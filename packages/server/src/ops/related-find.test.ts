/**
 * `related.find` end to end through the HTTP mount (MCP tool name `related_find`), using a
 * `FakeEmbeddingProvider` (no network). Checks the structural contract — excludes itself, excludes
 * its own page for a block target, soft-fails when nothing is indexed — not real semantic quality
 * (the fake provider's vectors aren't meaningfully "similar" for related text).
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

async function indexWithFakeModel(): Promise<void> {
  const driver = s.serverCtx.driver;
  const model = registerModel(driver, { provider: "fake", model: "test-model", dims: 8 });
  activateModel(driver, model.id);
  const indexer = new EmbeddingIndexer({
    driver,
    providerFor: (m) => new FakeEmbeddingProvider(8, m.model),
  });
  await indexer.drainUntilEmpty();
}

describe("related.find: unavailable without an embedding model", () => {
  it("returns available: false, not an error", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "Solo" });
    const { status, json } = await post(s.app, "/api/v1/related.find", s.writeToken, {
      target: "Solo",
    });
    expect(status).toBe(200);
    expect(json.available).toBe(false);
    expect(json.items).toEqual([]);
  });
});

describe("related.find: with an active, indexed model", () => {
  it("finds related pages, excluding the target page itself", async () => {
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Projects/Nooklet",
      markdown: "- building a local-first outliner",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Projects/Other",
      markdown: "- a completely different project",
    });
    await indexWithFakeModel();

    const { status, json } = await post(s.app, "/api/v1/related.find", s.writeToken, {
      target: "Projects/Nooklet",
    });
    expect(status).toBe(200);
    expect(json.available).toBe(true);
    expect(json.kind).toBe("page");
    expect(json.items.every((it: { page: string }) => it.page !== "Projects/Nooklet")).toBe(true);
  });

  it("finds related blocks, excluding the target block and its own page", async () => {
    const created = await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Projects/Nooklet",
      markdown:
        "- fix the reconnect bug in the sync engine\n- a second unrelated block with plenty of text",
    });
    await post(s.app, "/api/v1/page.create", s.writeToken, {
      name: "Projects/Other",
      markdown: "- some other page's block with unrelated but long enough content",
    });
    await indexWithFakeModel();

    const targetBlockId = created.json.created[0] as string;
    const { status, json } = await post(s.app, "/api/v1/related.find", s.writeToken, {
      target: targetBlockId,
    });
    expect(status).toBe(200);
    expect(json.available).toBe(true);
    expect(json.kind).toBe("block");
    expect(json.items.every((it: { id: string }) => it.id !== targetBlockId)).toBe(true);
    expect(json.items.every((it: { page: string }) => it.page !== "Projects/Nooklet")).toBe(true);
  });

  it("is not_found for a target that resolves to neither a page nor a block", async () => {
    const { status, json } = await post(s.app, "/api/v1/related.find", s.writeToken, {
      target: "1k7f3q9xz2hav4",
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});
