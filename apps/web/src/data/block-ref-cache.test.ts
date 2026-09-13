/**
 * `block-ref-cache.ts` at the reactive level: labels are memos in a Solid root, the worker's
 * `queryAs` is a fake whose answers the test releases by hand (so the order of answers, and what
 * is on screen while a read is out, can be asserted), plus one run of the real SQL against a real
 * `WorkerDb`. B-500 is the first test: a refresh used to empty the cache and every label read
 * `undefined` — the `((id))` placeholder — until its re-read answered.
 */
import { DatabaseSync } from "node:sqlite";
import { makeOp, newId, type Op } from "@nooklet/core";
import { createNodeSqliteDriver } from "@nooklet/core/node-sqlite";
import { createMemo, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Read {
  sql: string;
  ids: string[];
  answer: (rows: Array<{ id: string; content: string }>) => void;
  fail: () => void;
}

const fake = vi.hoisted(() => ({
  reads: [] as Read[],
  /** When set, `queryAs` runs against this instead of queueing a manual read. */
  sql: undefined as ((sql: string, params: unknown[]) => Promise<unknown[]>) | undefined,
}));

vi.mock("../db/client.js", () => ({
  queryAs: (sql: string, params: unknown[]) => {
    if (fake.sql) return fake.sql(sql, params);
    return new Promise((resolve, reject) => {
      fake.reads.push({
        sql,
        ids: params as string[],
        answer: resolve,
        fail: () => reject(new Error("worker gone")),
      });
    });
  },
}));

type Cache = typeof import("./block-ref-cache.js");
let cache: Cache;
const disposers: Array<() => void> = [];
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  // The cache is module state; each test gets a fresh module.
  vi.resetModules();
  fake.reads = [];
  fake.sql = undefined;
  cache = await import("./block-ref-cache.js");
});
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});

/** A label on screen: a memo that resolves `id` the way `BlockRefView` does, recording every value
 * it rendered. */
function label(id: string): { seen: Array<string | undefined>; dispose: () => void } {
  const seen: Array<string | undefined> = [];
  const dispose = createRoot((d) => {
    createMemo(() => {
      seen.push(cache.lookupBlockText(id));
    });
    return d;
  });
  disposers.push(dispose);
  return { seen, dispose };
}

function rows(texts: Record<string, string>): Array<{ id: string; content: string }> {
  return Object.entries(texts).map(([id, content]) => ({ id, content }));
}

describe("block-ref-cache", () => {
  it("a resolved label keeps its text while a change re-reads it (B-500)", async () => {
    const a = label("a");
    await settle();
    fake.reads[0]?.answer(rows({ a: "alpha" }));
    await settle();
    expect(a.seen).toEqual([undefined, "alpha"]);

    cache.invalidateBlockRefs();
    await settle();
    // Re-read is out, nothing answered yet: still "alpha", never back to undefined.
    expect(fake.reads).toHaveLength(2);
    expect(cache.lookupBlockText("a")).toBe("alpha");
    fake.reads[1]?.answer(rows({ a: "alpha" }));
    await settle();
    // Same text: the label did not even re-run.
    expect(a.seen).toEqual([undefined, "alpha"]);
  });

  it("a changed text reaches only the labels showing that block", async () => {
    const a = label("a");
    const b = label("b");
    await settle();
    fake.reads[0]?.answer(rows({ a: "alpha", b: "beta" }));
    await settle();

    cache.invalidateBlockRefs();
    await settle();
    fake.reads[1]?.answer(rows({ a: "alpha 2", b: "beta" }));
    await settle();
    expect(a.seen).toEqual([undefined, "alpha", "alpha 2"]);
    expect(b.seen).toEqual([undefined, "beta"]);
  });

  it("labels rendered together ask in one query", async () => {
    for (let i = 0; i < 50; i++) label(`id${i}`);
    await settle();
    expect(fake.reads).toHaveLength(1);
    expect(fake.reads[0]?.ids).toHaveLength(50);
    expect(fake.reads[0]?.sql).toMatch(/WHERE id IN \(\?(,\?){49}\) AND deleted_at IS NULL/);

    // And a refresh re-reads them in one query too.
    fake.reads[0]?.answer([]);
    await settle();
    cache.invalidateBlockRefs();
    await settle();
    expect(fake.reads).toHaveLength(2);
    expect(fake.reads[1]?.ids).toHaveLength(50);
  });

  it("an older read that answers last does not overwrite a newer one", async () => {
    const a = label("a");
    await settle();
    fake.reads[0]?.answer(rows({ a: "v1" }));
    await settle();

    cache.invalidateBlockRefs();
    await settle();
    cache.invalidateBlockRefs();
    await settle();
    expect(fake.reads).toHaveLength(3);
    fake.reads[2]?.answer(rows({ a: "v3" }));
    await settle();
    fake.reads[1]?.answer(rows({ a: "v2" }));
    await settle();
    expect(a.seen).toEqual([undefined, "v1", "v3"]);
  });

  it("a block that is gone renders as unresolved; one that appears later resolves", async () => {
    const a = label("a");
    await settle();
    fake.reads[0]?.answer([]);
    await settle();
    expect(a.seen).toEqual([undefined]);

    cache.invalidateBlockRefs();
    await settle();
    fake.reads[1]?.answer(rows({ a: "arrived" }));
    await settle();
    expect(a.seen).toEqual([undefined, "arrived"]);

    cache.invalidateBlockRefs();
    await settle();
    fake.reads[2]?.answer([]);
    await settle();
    expect(a.seen).toEqual([undefined, "arrived", undefined]);
  });

  it("a failed re-read keeps the text on screen", async () => {
    const a = label("a");
    await settle();
    fake.reads[0]?.answer(rows({ a: "alpha" }));
    await settle();
    cache.invalidateBlockRefs();
    await settle();
    fake.reads[1]?.fail();
    await settle();
    expect(a.seen).toEqual([undefined, "alpha"]);
  });

  it("ids nobody shows are not re-read on a change, but on their next lookup — stale meanwhile", async () => {
    const a = label("a");
    await settle();
    fake.reads[0]?.answer(rows({ a: "alpha" }));
    await settle();
    a.dispose();

    cache.invalidateBlockRefs();
    await settle();
    expect(fake.reads).toHaveLength(1);

    // Remounted (a page opened again): the old text at once, and a re-read behind it.
    const again = label("a");
    expect(again.seen).toEqual(["alpha"]);
    await settle();
    expect(fake.reads).toHaveLength(2);
    fake.reads[1]?.answer(rows({ a: "alpha edited" }));
    await settle();
    expect(again.seen).toEqual(["alpha", "alpha edited"]);
  });

  it("reads real text through the real schema, deleted blocks excluded", async () => {
    const { WorkerDb } = await import("../db/worker-core.js");
    const db = new WorkerDb({
      driver: createNodeSqliteDriver(new DatabaseSync(":memory:")),
      transport: {
        push: async () => ({ accepted: [], rejected: [], corrections: [], server_seq: 0 }),
        pull: async () => ({ ops: [], cursor: 0, has_more: false }),
        snapshot: async () => ({
          cursor: 0,
          pages: [],
          blocks: [],
          block_props: [],
          page_props: [],
        }),
        connectLive: () => () => {},
      },
    });
    const op = (entity: string, payload: Op["payload"]): Op =>
      makeOp(db.sync.nextHlc(), db.getDeviceId(), entity, payload);
    const pageId = newId();
    db.applyLocalOps([
      op(pageId, { kind: "page.create", name: "P", journalDay: null, createdAt: 1 }),
    ]);
    const kept = newId();
    const gone = newId();
    for (const [id, content, order] of [
      [kept, "kept text", "a"],
      [gone, "gone text", "b"],
    ] as const) {
      db.applyLocalOps([
        op(id, {
          kind: "block.create",
          place: { pageId, parentId: null, order },
          content,
          createdAt: 1,
        }),
      ]);
    }
    db.applyLocalOps([op(gone, { kind: "block.delete", deletedAt: 2 })]);
    fake.sql = async (sql, params) => db.query(sql, params);

    const k = label(kept);
    const g = label(gone);
    await vi.waitFor(() => expect(k.seen).toEqual([undefined, "kept text"]));
    expect(g.seen).toEqual([undefined]);
  });
});
