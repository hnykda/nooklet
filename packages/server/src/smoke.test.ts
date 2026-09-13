/**
 * End-to-end smoke test (M6, PLAN.md §15): the one test meant to catch a cross-cutting regression
 * that every focused unit test misses. Imports a small synthetic graph, starts the real Hono app
 * in-process (no mocking of the write path, auth, or op registry), exercises a representative
 * slice of the HTTP API a real agent/client would actually call, then runs the `verify()`
 * rebuild-parity check (ADR 003) and asserts the graph is exactly what it should be throughout.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext } from "./apply-ops.js";
import { createToken } from "./auth/tokens.js";
import { openDb } from "./db.js";
import { createApp } from "./http/app.js";
import { importLogseqGraph } from "./importer/logseq.js";
import { buildRegistry } from "./ops/index.js";
import type { ServerConfig } from "./ops/registry.js";
import { verifyRebuildParity } from "./verify.js";

let graphDir: string;
let dataDir: string;

function writeGraphFile(relPath: string, content: string): void {
  const full = join(graphDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

beforeEach(() => {
  graphDir = mkdtempSync(join(tmpdir(), "nooklet-smoke-graph-"));
  dataDir = mkdtempSync(join(tmpdir(), "nooklet-smoke-data-"));
});

afterEach(() => {
  rmSync(graphDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: smoke-test-only escape hatch for response bodies.
type JsonAny = any;

describe("end-to-end smoke test", () => {
  it("imports a graph, exercises create/append/search/backlinks/undo through HTTP, and passes verify", async () => {
    // -----------------------------------------------------------------------------------------
    // 1. A small synthetic Logseq-style graph on disk, imported the same way a real user's would be.
    // -----------------------------------------------------------------------------------------
    writeGraphFile(
      "pages/Home.md",
      "- Welcome to the [[Projects]] tracker\n- #idea capture everything here\n",
    );
    writeGraphFile(
      "pages/Projects.md",
      "- Aurora\n  status:: active\n  - Owned by [[Sam]]\n- Nebula\n  status:: done\n",
    );
    writeGraphFile("pages/Sam.md", "- Team lead for [[Projects]]\n- TODO Review Aurora budget\n");

    const ctx: ServerContext = createServerContext(openDb({ path: join(dataDir, "graph.sqlite") }));
    const importStats = await importLogseqGraph(ctx, graphDir);
    expect(importStats.errors).toEqual([]);
    expect(importStats.pagesImported).toBe(3);
    expect(importStats.blocksImported).toBeGreaterThan(0);

    // -----------------------------------------------------------------------------------------
    // 2. Start the real app in-process (same createApp() nooklet serve uses), with a real token.
    // -----------------------------------------------------------------------------------------
    const registry = buildRegistry();
    const config: ServerConfig = {
      dataDir,
      graphId: "default",
      timezone: "UTC",
      port: 0,
      mirror: { enabled: false },
    };
    const app = createApp({ serverCtx: ctx, registry, config, version: "smoke-test" });
    const token = createToken(ctx.driver, { label: "smoke", scope: "write" }).token;

    async function api(path: string, body: unknown): Promise<{ status: number; json: JsonAny }> {
      const res = await app.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => undefined) };
    }

    const health = await app.request("/");
    expect(health.status).toBe(200);

    // -----------------------------------------------------------------------------------------
    // 3. create: a brand-new page with nested markdown.
    // -----------------------------------------------------------------------------------------
    const create = await api("/api/v1/page.create", {
      name: "Journal Notes",
      markdown: "- Kickoff meeting\n  - Discuss [[Aurora]] timeline",
    });
    expect(create.status).toBe(200);
    expect(create.json.created).toHaveLength(2);
    const cursorAfterCreate = String(create.json.seq);

    // -----------------------------------------------------------------------------------------
    // 4. append markdown: grow the page, get stable block ids back.
    // -----------------------------------------------------------------------------------------
    const append = await api("/api/v1/page.append", {
      page: "Journal Notes",
      markdown: "- Follow up with [[Sam]] #followup",
    });
    expect(append.status).toBe(200);
    expect(append.json.created).toHaveLength(1);

    const afterAppend = await api("/api/v1/page.read", { page: "Journal Notes", format: "json" });
    expect(afterAppend.status).toBe(200);
    expect((afterAppend.json.tree as Array<{ content: string }>).map((n) => n.content)).toEqual([
      "Kickoff meeting",
      "Follow up with [[Sam]] #followup",
    ]);

    // -----------------------------------------------------------------------------------------
    // 5. search: the appended block is findable (keyword mode -- no embedding model configured).
    // -----------------------------------------------------------------------------------------
    const search = await api("/api/v1/search", { query: "Aurora", mode: "keyword" });
    expect(search.status).toBe(200);
    expect((search.json.hits as unknown[]).length).toBeGreaterThan(0);
    const hitPages = (search.json.hits as Array<{ page: string }>).map((h) => h.page);
    expect(hitPages).toContain("Projects");

    // -----------------------------------------------------------------------------------------
    // 6. backlinks: Projects is linked from Home, Sam, and the new Journal Notes block.
    // -----------------------------------------------------------------------------------------
    const backlinks = await api("/api/v1/page.backlinks", { target: "Projects" });
    expect(backlinks.status).toBe(200);
    expect((backlinks.json.linked as unknown[]).length).toBeGreaterThanOrEqual(2);

    // -----------------------------------------------------------------------------------------
    // 7. undo: reverse the append batch and confirm the page is back to its pre-append state.
    // -----------------------------------------------------------------------------------------
    const changes = await api("/api/v1/changes.since", { cursor: cursorAfterCreate });
    expect(changes.status).toBe(200);
    const appendBatchId = changes.json.items[0]?.batch_id as string;
    expect(typeof appendBatchId).toBe("string");

    const undo = await api("/api/v1/batch.undo", { batch_id: appendBatchId });
    expect(undo.status).toBe(200);
    // The appended block, and the `followup` page its `#followup` made exist in the same batch
    // (ADR 024) — one undo takes back the whole write.
    expect(undo.json.deleted).toHaveLength(2);

    const afterUndo = await api("/api/v1/page.read", { page: "Journal Notes", format: "json" });
    expect((afterUndo.json.tree as Array<{ content: string }>).map((n) => n.content)).toEqual([
      "Kickoff meeting",
    ]);

    // The undone block must also be gone from search and from Sam's backlinks.
    const searchAfterUndo = await api("/api/v1/search", { query: "followup", mode: "keyword" });
    expect((searchAfterUndo.json.hits as unknown[]).length).toBe(0);

    // -----------------------------------------------------------------------------------------
    // 8. verify: the whole graph, as it stands after create/append/undo, is exactly what
    //    replaying its op log from scratch produces. This is the regression detector: if any step
    //    above had silently bypassed the op log (a bare SQL write, a missed audit row), this fails.
    // -----------------------------------------------------------------------------------------
    const report = verifyRebuildParity(ctx.driver);
    expect(report.divergences).toEqual([]);
    expect(report.ok).toBe(true);

    // -----------------------------------------------------------------------------------------
    // 9. Sanity on the intact graph shape: original imported pages/blocks are untouched.
    // -----------------------------------------------------------------------------------------
    const overview = await api("/api/v1/graph.overview", {});
    expect(overview.status).toBe(200);
    expect(overview.json.counts.pages).toBeGreaterThanOrEqual(3); // Home, Projects, Sam
    const samRead = await api("/api/v1/page.read", { page: "Sam" });
    expect(samRead.status).toBe(200);
    expect(samRead.json.text).toContain("TODO Review Aurora budget");
  });
});
