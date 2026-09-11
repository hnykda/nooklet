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
import { getActiveModel, getVecStatus, pendingCountForModel } from "../embeddings/index.js";
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

    // The FTS and vector tables are server-only derived tables (sql-schema.md rule 1) and may not
    // exist at all on a database that has never been indexed, so probe rather than assume.
    const tableExists = (name: string): boolean =>
      (driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?", [name])
        ?.n ?? 0) > 0;

    const ftsPresent = tableExists("block_fts");

    return {
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
        // The vector rows live in the model's own `vec0` table, whose name is per-model.
        indexed:
          vec.loaded && active && tableExists(active.tableName)
            ? count(`SELECT COUNT(*) AS n FROM ${active.tableName}`)
            : 0,
        pending: active ? pendingCountForModel(driver, active.id) : 0,
      },
    };
  },
});
