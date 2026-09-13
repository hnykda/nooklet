/**
 * `search`'s `fallback` (B-520): when a semantic or hybrid search answers with keyword results, the
 * reply says why — one test per reason the server can tell apart, over the real HTTP mount.
 *
 * The provider failures are produced for real (a refused port, a stand-in Ollama over a socket),
 * not by mocking `fetch`: the classification reads what the probe and the provider actually do
 * with those answers. Deliberately never the machine's own Ollama on :11434 — CI has none.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateModel,
  EmbeddingIndexer,
  enqueueBackfill,
  FakeEmbeddingProvider,
  registerModel,
  setEmbeddingSettings,
  setVecStatus,
} from "../embeddings/index.js";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  s = makeTestServer();
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Fallback Fixture",
    markdown: "- vendor pricing detail\n- a second block about pricing\n- third",
  });
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function search(body: Record<string, unknown>) {
  const { status, json } = await post(s.app, "/api/v1/search", s.readToken, {
    query: "pricing",
    ...body,
  });
  expect(status).toBe(200);
  return json;
}

/** An Ollama stand-in: `/api/tags` lists `models`; `/api/embed` answers with `embedStatus`. */
async function stubOllama(opts: { models: string[]; embedStatus: number }): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: opts.models.map((name) => ({ name })) }));
      } else if (req.url === "/api/embed") {
        res.writeHead(opts.embedStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `stub embed answered ${opts.embedStatus}` }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Nothing listens here, and a refused connection comes back immediately. */
const DEAD_HOST = "http://127.0.0.1:1";

/** An active `ollama:bge-m3` row pointed at `host` — the state after a finished backfill. */
function activeOllamaModel(host: string): void {
  const driver = s.serverCtx.driver;
  setEmbeddingSettings(driver, { provider: "ollama", model: "bge-m3", host });
  const row = registerModel(driver, { provider: "ollama", model: "bge-m3", dims: 8 });
  activateModel(driver, row.id);
}

describe("search fallback: why semantic search did not run (B-520)", () => {
  it("not_configured on a fresh install, and no fallback at all for a keyword search", async () => {
    const hybrid = await search({ mode: "hybrid" });
    expect(hybrid.mode_used).toBe("keyword");
    expect(hybrid.hits.length).toBeGreaterThan(0);
    expect(hybrid.fallback).toMatchObject({ reason: "not_configured" });
    expect(hybrid.fallback.message).toContain("not set up");

    const keyword = await search({ mode: "keyword" });
    expect(keyword.mode_used).toBe("keyword");
    expect(keyword).not.toHaveProperty("fallback");
  });

  it("sqlite_vec_unavailable carries the load error", async () => {
    setVecStatus(s.serverCtx.driver, { loaded: false, error: "dlopen vec0.dylib: not found" });
    const out = await search({ mode: "semantic" });
    expect(out.mode_used).toBe("keyword");
    expect(out.fallback).toMatchObject({
      reason: "sqlite_vec_unavailable",
      error: "dlopen vec0.dylib: not found",
    });
  });

  it("indexing reports N of M, and N moves as the backfill drains", async () => {
    const driver = s.serverCtx.driver;
    setEmbeddingSettings(driver, { provider: "fake", model: "test-model" });
    registerModel(driver, { provider: "fake", model: "test-model", dims: 8 });
    const queued = enqueueBackfill(driver);

    const before = await search({ mode: "hybrid" });
    expect(before.mode_used).toBe("keyword");
    expect(before.fallback).toMatchObject({
      reason: "indexing",
      provider: "fake",
      model: "test-model",
      indexed: 0,
      total: queued,
      errors: 0,
    });

    const indexer = new EmbeddingIndexer({
      driver,
      providerFor: (m) => new FakeEmbeddingProvider(8, m.model),
    });
    await indexer.runOnce({ limit: 2 });
    const during = await search({ mode: "hybrid" });
    expect(during.fallback.reason).toBe("indexing");
    expect(during.fallback.indexed).toBeGreaterThan(0);
    expect(during.fallback.indexed).toBeLessThan(during.fallback.total);

    // Once drained the model activates itself, and the same search is hybrid with no fallback.
    await indexer.drainUntilEmpty();
    const after = await search({ mode: "hybrid" });
    expect(after.mode_used).toBe("hybrid");
    expect(after).not.toHaveProperty("fallback");
  });

  it("index_incomplete when the backfill ended with failures, naming the last error", async () => {
    const driver = s.serverCtx.driver;
    setEmbeddingSettings(driver, { provider: "fake", model: "test-model" });
    registerModel(driver, { provider: "fake", model: "test-model", dims: 8 });
    enqueueBackfill(driver);
    const indexer = new EmbeddingIndexer({
      driver,
      providerFor: () => {
        throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
      },
    });
    await indexer.drainUntilEmpty();

    const out = await search({ mode: "hybrid" });
    expect(out.mode_used).toBe("keyword");
    expect(out.fallback).toMatchObject({ reason: "index_incomplete", indexed: 0 });
    expect(out.fallback.errors).toBeGreaterThan(0);
    expect(out.fallback.total).toBe(out.fallback.errors);
    expect(out.fallback.error).toContain("ECONNREFUSED");
  });

  it("provider_unreachable names the address the active model's server was expected at", async () => {
    activeOllamaModel(DEAD_HOST);
    const out = await search({ mode: "hybrid" });
    expect(out.mode_used).toBe("keyword");
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.fallback).toMatchObject({
      reason: "provider_unreachable",
      host: DEAD_HOST,
      model: "bge-m3",
    });
    expect(out.fallback.message).toContain(DEAD_HOST);
    expect(out.fallback.error).toBeTruthy();
  });

  it("model_missing when the server answers but no longer has the model", async () => {
    const host = await stubOllama({ models: ["nomic-embed-text:latest"], embedStatus: 404 });
    activeOllamaModel(host);
    const out = await search({ mode: "semantic" });
    expect(out.mode_used).toBe("keyword");
    expect(out.fallback).toMatchObject({ reason: "model_missing", host, model: "bge-m3" });
  });

  it("query_embedding_failed when the server has the model and embedding fails anyway", async () => {
    const host = await stubOllama({ models: ["bge-m3:latest"], embedStatus: 500 });
    activeOllamaModel(host);
    const out = await search({ mode: "hybrid" });
    expect(out.mode_used).toBe("keyword");
    expect(out.fallback).toMatchObject({ reason: "query_embedding_failed", host });
    expect(out.fallback.error).toContain("500");
  });
});

describe("search with a pages filter that matches no page (B-521)", () => {
  it("reports the requested mode — nothing was searched, so nothing fell back", async () => {
    const out = await search({ mode: "hybrid", pages: ["No Such Page Anywhere"] });
    expect(out.hits).toEqual([]);
    expect(out.mode_used).toBe("hybrid");
    expect(out).not.toHaveProperty("fallback");
  });
});
