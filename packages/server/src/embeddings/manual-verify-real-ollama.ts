#!/usr/bin/env -S node --experimental-strip-types
/**
 * MANUAL verification script — NOT part of the automated test suite (no `.test.ts` in the name,
 * so vitest's default include glob never picks it up). This is the one place in M3 that is
 * allowed, and expected, to hit a real Ollama and the user's real Logseq graph.
 *
 * What it does:
 *   1. Imports the real graph at $NOOKLET_VERIFY_GRAPH (default: the path below) into an
 *      in-memory database via the same `importLogseqGraph` the CLI's `nooklet import` uses.
 *   2. Registers `ollama:bge-m3` as the active embedding model (real `/api/show` dims probe).
 *   3. Embeds a BOUNDED subset of the resulting `embed_dirty` queue (500 units) with the real
 *      Ollama provider — not the whole graph, so this finishes in well under a minute.
 *   4. Runs a couple of semantic queries through the real `search` op (mode: semantic, hybrid)
 *      and `related.find`, over HTTP, exactly as a client would.
 *
 * Output discipline: prints ONLY aggregate counts/timings and hit ids/scores — never note
 * content (no snippets, no page names beyond what's needed to sanity-check ids resolve).
 *
 * Run with: pnpm --filter @nooklet/server exec tsx src/embeddings/manual-verify-real-ollama.ts
 */

import { createServerContext } from "../apply-ops.js";
import { createToken } from "../auth/tokens.js";
import { openDb } from "../db.js";
import { createApp } from "../http/app.js";
import { importLogseqGraph } from "../importer/logseq.js";
import { buildRegistry } from "../ops/index.js";
import type { ServerConfig } from "../ops/registry.js";
import { EmbeddingIndexer } from "./indexer.js";
import { activateModel, getActiveModel, registerModel } from "./model-registry.js";
import { OllamaProvider } from "./ollama-provider.js";

const GRAPH_DIR = process.env.NOOKLET_VERIFY_GRAPH ?? "~/notes-graph";
const BOUNDED_UNITS = 500;
const QUERIES = ["sync engine design", "task scheduling and deadlines", "embedding search"];

function ms(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

async function main(): Promise<void> {
  console.log(`nooklet M3 manual verification — real Ollama + real graph`);
  console.log(`graph: ${GRAPH_DIR}`);
  console.log(`bounded units: ${BOUNDED_UNITS}`);
  console.log("");

  const serverCtx = createServerContext(openDb({ path: ":memory:" }));
  const registry = buildRegistry();
  const config: ServerConfig = {
    dataDir: ":memory:",
    graphId: "default",
    timezone: "UTC",
    port: 0,
    mirror: { enabled: false },
  };
  const app = createApp({ serverCtx, registry, config, version: "manual-verify" });
  const writeToken = createToken(serverCtx.driver, { label: "verify", scope: "write" }).token;

  // 1. Import.
  const t0 = performance.now();
  const stats = await importLogseqGraph(serverCtx, GRAPH_DIR);
  console.log(
    `[import] pages=${stats.pagesImported} journals=${stats.journalsImported} ` +
      `blocks=${stats.blocksImported} skipped=${stats.pagesSkipped} in ${ms(t0)}`,
  );

  const dirtyTotal =
    serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM embed_dirty")?.n ?? 0;
  console.log(`[embed_dirty] ${dirtyTotal} units queued after import`);

  // 2. Register + activate bge-m3.
  const t1 = performance.now();
  const probe = new OllamaProvider({ model: "bge-m3" });
  const dims = await probe.dims();
  console.log(`[model] bge-m3 dims=${dims} (probed in ${ms(t1)})`);
  const model = registerModel(serverCtx.driver, { provider: "ollama", model: "bge-m3", dims });
  activateModel(serverCtx.driver, model.id);

  // 3. Bounded embed pass — one `runOnce` call capped at BOUNDED_UNITS dirty rows, real network.
  const indexer = new EmbeddingIndexer({
    driver: serverCtx.driver,
    providerFor: (m) => new OllamaProvider({ model: m.model }),
    log: (m) => console.error(`[indexer] ${m}`),
  });
  const t2 = performance.now();
  const drainStats = await indexer.runOnce({ limit: BOUNDED_UNITS });
  const elapsedIndex = performance.now() - t2;
  console.log(
    `[index] processed=${drainStats.processedUnits} embedded=${drainStats.embeddedPairs} ` +
      `deleted=${drainStats.deletedUnits} errors=${drainStats.errors} in ${elapsedIndex.toFixed(0)}ms ` +
      `(${((drainStats.embeddedPairs / Math.max(1, elapsedIndex)) * 1000).toFixed(1)} embeds/s)`,
  );
  const active = getActiveModel(serverCtx.driver);
  const doneCount = active
    ? serverCtx.driver.get<{ n: number }>(
        "SELECT count(*) AS n FROM embedding WHERE model_id = ? AND status = 'done'",
        [active.id],
      )?.n
    : 0;
  console.log(`[embedding table] status=done rows=${doneCount}`);
  console.log("");

  // 4. Semantic + hybrid queries over HTTP, exactly like a real client.
  for (const q of QUERIES) {
    for (const mode of ["semantic", "hybrid"] as const) {
      const t = performance.now();
      const res = await app.request("/api/v1/search", {
        method: "POST",
        headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json" },
        body: JSON.stringify({ query: q, mode, limit: 5 }),
      });
      const elapsed = performance.now() - t;
      const json = (await res.json()) as {
        mode_used: string;
        hits: Array<{ kind: string; id: string; score: number }>;
      };
      const hitSummary = json.hits.map((h) => `${h.kind}:${h.id}@${h.score.toFixed(3)}`).join(" ");
      console.log(
        `[search] q="${q}" mode=${mode} mode_used=${json.mode_used} hits=${json.hits.length} ` +
          `in ${elapsed.toFixed(0)}ms -> ${hitSummary}`,
      );
    }
  }
  console.log("");

  // 5. related.find on the top hit of the last query, if any.
  const lastSearch = await app.request("/api/v1/search", {
    method: "POST",
    headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ query: QUERIES[0], mode: "semantic", scope: "blocks", limit: 1 }),
  });
  const lastJson = (await lastSearch.json()) as { hits: Array<{ id: string }> };
  const targetId = lastJson.hits[0]?.id;
  if (targetId) {
    const t = performance.now();
    const relRes = await app.request("/api/v1/related.find", {
      method: "POST",
      headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ target: targetId, limit: 5 }),
    });
    const elapsed = performance.now() - t;
    const relJson = (await relRes.json()) as {
      available: boolean;
      kind: string;
      items: Array<{ kind: string; id: string; score: number }>;
    };
    const summary = relJson.items.map((h) => `${h.kind}:${h.id}@${h.score.toFixed(3)}`).join(" ");
    console.log(
      `[related.find] target=${targetId} available=${relJson.available} kind=${relJson.kind} ` +
        `items=${relJson.items.length} in ${elapsed.toFixed(0)}ms -> ${summary}`,
    );
  } else {
    console.log(`[related.find] skipped: no semantic hit to use as a target`);
  }

  console.log("");
  console.log(`total wall time: ${ms(t0)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
