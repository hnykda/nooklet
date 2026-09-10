import { newId } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { FakeEmbeddingProvider } from "./fake-provider.js";
import { EmbeddingIndexer } from "./indexer.js";
import {
  activateModel,
  createVecTable,
  enqueueBackfill,
  findModel,
  getActiveModel,
  getModel,
  listModels,
  pendingCountForModel,
  registerModel,
} from "./model-registry.js";
import { getVecStatus } from "./vec-loader.js";

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

describe("sqlite-vec loading", () => {
  it("loads for every db opened via openDb (in-memory included)", () => {
    const status = getVecStatus(ctx.driver);
    expect(status.loaded).toBe(true);
    expect(status.version).toMatch(/^v?\d+\.\d+\.\d+/);
  });
});

describe("model registry", () => {
  it("registers a new model inactive, with its own vec0 table", () => {
    const row = registerModel(ctx.driver, { provider: "fake", model: "test-model", dims: 8 });
    expect(row.active).toBe(false);
    expect(row.tableName).toBe(`embedding_vec_${row.id}`);
    expect(getActiveModel(ctx.driver)).toBeUndefined();

    // The vec0 table really exists and accepts a row of the right dimension.
    const insertOk = () =>
      ctx.driver.run(
        `INSERT INTO ${row.tableName}(id, kind, page_key, embedding) VALUES (?, ?, ?, ?)`,
        [1n, "block", "p", new Float32Array(8).buffer],
      );
    expect(insertOk).not.toThrow();
  });

  it("is idempotent for an already-registered provider+model", () => {
    const a = registerModel(ctx.driver, { provider: "fake", model: "dup", dims: 8 });
    const b = registerModel(ctx.driver, { provider: "fake", model: "dup", dims: 8 });
    expect(b.id).toBe(a.id);
    expect(listModels(ctx.driver)).toHaveLength(1);
  });

  it("refuses invalid dims", () => {
    expect(() => registerModel(ctx.driver, { provider: "fake", model: "bad", dims: 0 })).toThrow();
    expect(() =>
      registerModel(ctx.driver, { provider: "fake", model: "bad", dims: 1.5 }),
    ).toThrow();
  });

  it("findModel/getModel resolve the same row two ways", () => {
    const row = registerModel(ctx.driver, { provider: "fake", model: "m", dims: 4 });
    expect(findModel(ctx.driver, "fake", "m")?.id).toBe(row.id);
    expect(getModel(ctx.driver, row.id)?.model).toBe("m");
  });

  it("createVecTable rejects an unsafe table name shape defensively", () => {
    // createVecTable always derives the name itself; this exercises the guard directly.
    expect(() => createVecTable(ctx.driver, Number.NaN, 8)).toThrow();
  });
});

describe("model switch-over flow (rule 19)", () => {
  it("flips active atomically once the new model's backlog is drained, keeping search on the old model until then", async () => {
    const page = createPage("Projects/Nooklet");
    createBlock(page, "first block with enough text to be its own unit for sure");
    createBlock(page, "second block also long enough to be an embedding unit");

    const modelA = registerModel(ctx.driver, { provider: "fake", model: "model-a", dims: 8 });
    activateModel(ctx.driver, modelA.id);
    const indexer = new EmbeddingIndexer({
      driver: ctx.driver,
      providerFor: () => new FakeEmbeddingProvider(8, "model-a"),
    });
    await indexer.drainUntilEmpty();
    expect(pendingCountForModel(ctx.driver, modelA.id)).toBe(0);
    expect(getActiveModel(ctx.driver)?.id).toBe(modelA.id);

    // Switch to a second model: it starts inactive, and the active model doesn't change until
    // the new model's own backlog is fully drained.
    const modelB = registerModel(ctx.driver, { provider: "fake", model: "model-b", dims: 8 });
    const enqueued = enqueueBackfill(ctx.driver);
    expect(enqueued).toBeGreaterThan(0);
    expect(getActiveModel(ctx.driver)?.id).toBe(modelA.id);
    // The backlog exists as `embed_dirty` signals; `embedding` rows for model-b are only created
    // once the indexer actually drains them (checked below).
    expect(
      ctx.driver.get<{ n: number }>("SELECT count(*) AS n FROM embed_dirty")?.n,
    ).toBeGreaterThan(0);

    const indexerB = new EmbeddingIndexer({
      driver: ctx.driver,
      providerFor: (model) => new FakeEmbeddingProvider(8, model.model),
    });
    await indexerB.drainUntilEmpty();
    expect(pendingCountForModel(ctx.driver, modelB.id)).toBe(0);

    // Still not active until we explicitly flip it (rule 19's atomic flip is a separate step).
    expect(getActiveModel(ctx.driver)?.id).toBe(modelA.id);
    activateModel(ctx.driver, modelB.id);
    expect(getActiveModel(ctx.driver)?.id).toBe(modelB.id);

    // Exactly one active row, ever.
    const activeRows = ctx.driver.all<{ n: number }>(
      "SELECT count(*) AS n FROM embedding_model WHERE active = 1",
    );
    expect(activeRows[0]?.n).toBe(1);
  });
});
