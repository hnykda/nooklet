import { newId } from "@nooklet/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { FakeEmbeddingProvider } from "./fake-provider.js";
import { EmbeddingIndexer } from "./indexer.js";
import { activateModel, registerModel } from "./model-registry.js";

let ctx: ServerContext;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

function createPage(name: string): string {
  const id = newId();
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: { kind: "page.create", name, journalDay: null, createdAt: Date.now() },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

function createBlock(pageId: string, content: string, parentId: string | null = null): string {
  const id = newId();
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: id,
        payload: {
          kind: "block.create",
          place: { pageId, parentId, order: "a0" },
          content,
          createdAt: Date.now(),
        },
      },
    ],
    { origin: "user", actor: "test" },
  );
  return id;
}

function updateBlockText(blockId: string, content: string): void {
  const hlc = ctx.hlc.next();
  serverApplyOps(
    ctx,
    [
      {
        id: hlc,
        hlc,
        device: "aaaaaaaa",
        entity: blockId,
        payload: { kind: "block.text", content },
      },
    ],
    { origin: "user", actor: "test" },
  );
}

describe("apply-ops -> embed_dirty wiring", () => {
  it("enqueues a block and page unit on block.create", () => {
    const page = createPage("Projects/Nooklet");
    const block = createBlock(page, "fix the reconnect bug, this text is long enough to embed");
    const dirty = ctx.driver.all<{ unit_kind: string; unit_id: string }>(
      "SELECT unit_kind, unit_id FROM embed_dirty ORDER BY unit_kind",
    );
    expect(dirty).toContainEqual({ unit_kind: "block", unit_id: block });
    expect(dirty).toContainEqual({ unit_kind: "page", unit_id: page });
  });
});

describe("EmbeddingIndexer.drainOnce / hash-skip logic", () => {
  it("embeds a new unit and marks it done", async () => {
    const page = createPage("Projects/Nooklet");
    createBlock(page, "fix the reconnect bug, this text is long enough to embed on its own");
    const model = registerModel(ctx.driver, { provider: "fake", model: "m", dims: 8 });
    activateModel(ctx.driver, model.id);

    const provider = new FakeEmbeddingProvider(8, "m");
    const embed = vi.spyOn(provider, "embed");
    const indexer = new EmbeddingIndexer({ driver: ctx.driver, providerFor: () => provider });

    const stats = await indexer.runOnce();
    expect(stats.embeddedPairs).toBeGreaterThan(0);
    expect(embed).toHaveBeenCalledTimes(1);

    const rows = ctx.driver.all<{
      status: string;
      embedded_hash: string | null;
      text_hash: string;
    }>("SELECT status, embedded_hash, text_hash FROM embedding WHERE model_id = ?", [model.id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).toBe("done");
      expect(r.embedded_hash).toBe(r.text_hash);
    }
    // Queue is drained.
    expect(ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM embed_dirty")?.n).toBe(0);
  });

  it("skips re-embedding when the dirty signal fires but the text hash hasn't changed", async () => {
    const page = createPage("Projects/Nooklet");
    const block = createBlock(page, "fix the reconnect bug, long enough text to make a unit");
    const model = registerModel(ctx.driver, { provider: "fake", model: "m", dims: 8 });
    activateModel(ctx.driver, model.id);

    const provider = new FakeEmbeddingProvider(8, "m");
    const embed = vi.spyOn(provider, "embed");
    const indexer = new EmbeddingIndexer({ driver: ctx.driver, providerFor: () => provider });
    await indexer.drainUntilEmpty();
    expect(embed).toHaveBeenCalled();
    const callsAfterFirstDrain = embed.mock.calls.length;

    // Re-touch the block WITHOUT changing its content (e.g. a place move re-enqueues embed_dirty
    // for ancestors, or the app just re-saves the same text) — the resulting text is byte-for-byte
    // identical, so its hash matches embedded_hash and no embed call should happen.
    ctx.driver.run(
      "INSERT OR IGNORE INTO embed_dirty(unit_kind, unit_id, enqueued_at) VALUES ('block', ?, ?)",
      [block, Date.now()],
    );
    const stats = await indexer.runOnce();
    expect(stats.processedUnits).toBeGreaterThan(0);
    expect(stats.embeddedPairs).toBe(0);
    expect(embed.mock.calls.length).toBe(callsAfterFirstDrain); // no new network/provider calls

    // Changing the text for real DOES trigger a re-embed.
    updateBlockText(block, "fix the reconnect bug, long enough text to make a unit, edited now");
    await indexer.drainUntilEmpty();
    expect(embed.mock.calls.length).toBeGreaterThan(callsAfterFirstDrain);
  });

  it("removes the embedding row and vector when a block is deleted", async () => {
    const page = createPage("Projects/Nooklet");
    const block = createBlock(page, "a block that will shortly be deleted, long enough text");
    const model = registerModel(ctx.driver, { provider: "fake", model: "m", dims: 8 });
    activateModel(ctx.driver, model.id);
    const indexer = new EmbeddingIndexer({
      driver: ctx.driver,
      providerFor: () => new FakeEmbeddingProvider(8, "m"),
    });
    await indexer.drainUntilEmpty();
    const before = ctx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM embedding WHERE model_id = ? AND block_id = ?",
      [model.id, block],
    );
    expect(before?.n).toBe(1);

    const hlc = ctx.hlc.next();
    serverApplyOps(
      ctx,
      [
        {
          id: hlc,
          hlc,
          device: "aaaaaaaa",
          entity: block,
          payload: { kind: "block.delete", deletedAt: Date.now() },
        },
      ],
      { origin: "user", actor: "test" },
    );
    await indexer.drainUntilEmpty();
    const after = ctx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM embedding WHERE model_id = ? AND block_id = ?",
      [model.id, block],
    );
    expect(after?.n).toBe(0);
  });

  it("skips a block that is too short and has no children", async () => {
    const page = createPage("Projects/Nooklet");
    createBlock(page, "hi");
    const model = registerModel(ctx.driver, { provider: "fake", model: "m", dims: 8 });
    activateModel(ctx.driver, model.id);
    const indexer = new EmbeddingIndexer({
      driver: ctx.driver,
      providerFor: () => new FakeEmbeddingProvider(8, "m"),
    });
    const stats = await indexer.drainUntilEmpty();
    expect(stats.deletedUnits).toBeGreaterThan(0); // "not embeddable" is handled the same as deleted
    const rows = ctx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM embedding WHERE model_id = ?",
      [model.id],
    );
    // Only the page unit remains (the block was too short to be its own unit).
    expect(rows?.n).toBe(1);
  });

  it("maintains embeddings for every tracked model, not just the active one", async () => {
    const page = createPage("Projects/Nooklet");
    createBlock(page, "shared block content long enough to be embedded by both models here");
    const modelA = registerModel(ctx.driver, { provider: "fake", model: "a", dims: 8 });
    const modelB = registerModel(ctx.driver, { provider: "fake", model: "b", dims: 8 });
    activateModel(ctx.driver, modelA.id);
    const indexer = new EmbeddingIndexer({
      driver: ctx.driver,
      providerFor: (model) => new FakeEmbeddingProvider(8, model.model),
    });
    await indexer.drainUntilEmpty();
    const countA = ctx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM embedding WHERE model_id = ? AND status = 'done'",
      [modelA.id],
    )?.n;
    const countB = ctx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM embedding WHERE model_id = ? AND status = 'done'",
      [modelB.id],
    )?.n;
    expect(countA).toBeGreaterThan(0);
    expect(countB).toBe(countA);
  });
});
