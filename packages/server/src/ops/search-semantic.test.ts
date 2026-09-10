/**
 * `search`'s semantic/hybrid modes, end to end through the HTTP mount, using a `FakeEmbeddingProvider`
 * (no network/Ollama). Keyword-only behaviour is covered in `ops.http.test.ts`; this file is scoped
 * to the M3 embeddings addition.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  activateModel,
  EmbeddingIndexer,
  FakeEmbeddingProvider,
  registerModel,
} from "../embeddings/index.js";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

async function seedAndIndex(): Promise<void> {
  await post(s.app, "/api/v1/page.create", s.writeToken, {
    name: "Projects/Nooklet",
    markdown:
      "- The sync engine needs a reconnect backoff strategy for flaky wifi\n" +
      "- Grocery list: oat milk, coffee, bread",
  });
  const driver = s.serverCtx.driver;
  const model = registerModel(driver, { provider: "fake", model: "test-model", dims: 8 });
  activateModel(driver, model.id);
  const indexer = new EmbeddingIndexer({
    driver,
    providerFor: (m) => new FakeEmbeddingProvider(8, m.model),
  });
  await indexer.drainUntilEmpty();
}

describe("search: mode falls back to keyword with no embedding model", () => {
  it("reports mode_used 'keyword' for a semantic request when nothing is indexed", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "SearchMe",
      markdown: "- vendor pricing detail",
    });
    const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, {
      query: "pricing",
      mode: "semantic",
    });
    expect(status).toBe(200);
    expect(json.mode_used).toBe("keyword");
  });
});

describe("search: semantic/hybrid once a model is active and indexed", () => {
  it("mode: semantic reports mode_used 'semantic' and returns indexed blocks", async () => {
    await seedAndIndex();
    const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, {
      query: "reconnect backoff",
      mode: "semantic",
    });
    expect(status).toBe(200);
    expect(json.mode_used).toBe("semantic");
    expect(json.hits.length).toBeGreaterThan(0);
    expect(json.hits.every((h: { score: number }) => h.score >= 0 && h.score <= 1)).toBe(true);
  });

  it("mode: hybrid reports mode_used 'hybrid' and fuses keyword + semantic hits", async () => {
    await seedAndIndex();
    const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, {
      query: "sync engine",
      mode: "hybrid",
    });
    expect(status).toBe(200);
    expect(json.mode_used).toBe("hybrid");
    expect(json.hits.some((h: { page: string }) => h.page === "Projects/Nooklet")).toBe(true);
  });

  it("mode: keyword never touches the embedding path even when a model is active", async () => {
    await seedAndIndex();
    const { status, json } = await post(s.app, "/api/v1/search", s.writeToken, {
      query: "grocery",
      mode: "keyword",
    });
    expect(status).toBe(200);
    expect(json.mode_used).toBe("keyword");
  });
});
