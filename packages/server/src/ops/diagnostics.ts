/**
 * `system.diagnostics` — "is this thing actually working?"
 *
 * Exists because a broken backend was indistinguishable from a slow one: a missing API token
 * showed up as a permanent "Searching…", an unloadable `sqlite-vec` silently downgraded hybrid
 * search to keyword, and an embedding backlog looked exactly like semantic search returning
 * nothing useful. The client's diagnostics panel renders this; an agent can also call it to find
 * out whether semantic search is worth attempting before it tries.
 *
 * Everything here is cheap: counts and status, no scans.
 */

import { z } from "zod";
import { getActiveModel, getVecStatus, modelCounts } from "../embeddings/index.js";
import { graphInstanceId } from "../graph-identity.js";
import { defineOp } from "./registry.js";

export const systemDiagnostics = defineOp({
  name: "system.diagnostics",
  summary: "Backend health: storage, search index, embedding backlog",
  description:
    "Reports whether full-text and semantic search are actually available, how much of the " +
    "embedding queue is outstanding, and the size of the graph. Call this when search returns " +
    "nothing surprising, or before relying on semantic/hybrid search - if sqlite_vec.loaded is " +
    "false or pending_embeddings is large, semantic results will be incomplete and keyword " +
    "search is the honest fallback.",
  input: z.object({}).strict(),
  output: z.object({
    storage: z.object({
      data_dir: z.string().describe("Where this server keeps graph.sqlite and the markdown mirror"),
      graph_id: z
        .string()
        .describe("Identity of this graph, the same value a client compares its replica against"),
    }),
    graph: z.object({
      pages: z.number().int(),
      blocks: z.number().int(),
      ops: z.number().int().describe("Entries in the append-only change log"),
      seq: z.number().int(),
    }),
    search: z.object({
      fts: z.boolean().describe("Full-text index present"),
      indexed_blocks: z.number().int(),
    }),
    embeddings: z.object({
      sqlite_vec: z.object({ loaded: z.boolean(), version: z.string().nullable() }),
      model: z.string().nullable(),
      dimensions: z.number().int().nullable(),
      indexed: z.number().int(),
      pending: z.number().int().describe("Blocks still waiting to be embedded"),
    }),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  render: (out) =>
    `${out.graph.pages} pages / ${out.graph.blocks} blocks; ` +
    `fts ${out.search.fts ? "ok" : "MISSING"}; ` +
    `vec ${out.embeddings.sqlite_vec.loaded ? "ok" : "NOT LOADED"}; ` +
    `${out.embeddings.pending} embeddings pending`,
  handler: async (_input, ctx) => {
    const driver = ctx.db;
    const count = (sql: string): number => driver.get<{ n: number }>(sql)?.n ?? 0;

    const vec = getVecStatus(driver);
    const active = getActiveModel(driver);
    // Vector/pending/error counts come from the embeddings module itself (`modelCounts`), which is
    // also what `embeddings.status` reports — one implementation, so the settings panel and this
    // panel can never disagree about how far indexing has got.
    const counts = active ? modelCounts(driver, active) : undefined;

    // The FTS tables are server-only derived tables (sql-schema.md rule 1) and may not exist at
    // all on a database that has never been indexed, so probe rather than assume.
    const ftsPresent =
      (driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?", [
        "block_fts",
      ])?.n ?? 0) > 0;

    return {
      // Which graph this is, in the two forms people actually need: the directory to back up or
      // `cd` into, and the graph's own identity. The identity is `graphInstanceId`, NOT
      // `config.graphId` ("default", a slug for a multi-graph future) — the instance id is the
      // value a client holds and compares against its local replica (`../graph-identity.ts`), so
      // reporting anything else here would make "is this the graph I think it is?" unanswerable.
      storage: { data_dir: ctx.config.dataDir, graph_id: graphInstanceId(driver) },
      graph: {
        pages: count("SELECT COUNT(*) AS n FROM page WHERE deleted_at IS NULL"),
        blocks: count("SELECT COUNT(*) AS n FROM block WHERE deleted_at IS NULL"),
        ops: count("SELECT COUNT(*) AS n FROM op"),
        seq: count("SELECT COALESCE(MAX(seq), 0) AS n FROM changes"),
      },
      search: {
        fts: ftsPresent,
        indexed_blocks: ftsPresent ? count("SELECT COUNT(*) AS n FROM block_fts") : 0,
      },
      embeddings: {
        sqlite_vec: { loaded: vec.loaded, version: vec.version ?? null },
        model: active?.model ?? null,
        dimensions: active?.dims ?? null,
        indexed: counts?.indexed ?? 0,
        pending: counts?.pending ?? 0,
      },
    };
  },
});
