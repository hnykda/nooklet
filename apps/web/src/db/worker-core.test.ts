/**
 * `WorkerDb` exercised against `@nooklet/core`'s Node `SqlDriver` — the same substitution
 * `db.worker.ts` makes for the real sqlite-wasm/OPFS driver in the browser (see that file's and
 * `worker-core.ts`'s header comments). No Comlink, no Worker, no OPFS: everything here is
 * testable because `WorkerDb` only ever talks to a `SqlDriver`.
 */
import { DatabaseSync } from "node:sqlite";
import { makeOp, newId, type Op, type SqlDriver } from "@nooklet/core";
import { createNodeSqliteDriver } from "@nooklet/core/node-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  PullResponse,
  PushRequestBody,
  PushResponse,
  SnapshotResponse,
  SyncLiveHandlers,
  SyncTransport,
} from "../sync/types.js";
import type { ChangeEvent } from "./worker-api.js";
import { WorkerDb } from "./worker-core.js";

class NoopTransport implements SyncTransport {
  async push(_body: PushRequestBody): Promise<PushResponse> {
    return { accepted: [], rejected: [], corrections: [], server_seq: 0 };
  }
  async pull(_deviceId: string, _since: number): Promise<PullResponse> {
    return { ops: [], cursor: 0, has_more: false };
  }
  async snapshot(): Promise<SnapshotResponse> {
    return { cursor: 0, pages: [], blocks: [], block_props: [], page_props: [] };
  }
  connectLive(_deviceId: string, _handlers: SyncLiveHandlers): () => void {
    return () => {};
  }
}

function memoryDriver(): SqlDriver {
  return createNodeSqliteDriver(new DatabaseSync(":memory:"));
}

function pageCreate(db: WorkerDb, name: string, journalDay: number | null = null): Op {
  return makeOp(db.sync.nextHlc(), db.getDeviceId(), newId(), {
    kind: "page.create",
    name,
    journalDay,
    createdAt: Date.now(),
  });
}

function blockCreate(
  db: WorkerDb,
  pageId: string,
  parentId: string | null,
  order: string,
  content: string,
): Op {
  return makeOp(db.sync.nextHlc(), db.getDeviceId(), newId(), {
    kind: "block.create",
    place: { pageId, parentId, order },
    content,
    createdAt: Date.now(),
  });
}

describe("WorkerDb.getPageTree", () => {
  let db: WorkerDb;

  beforeEach(() => {
    db = new WorkerDb({ driver: memoryDriver(), transport: new NoopTransport() });
  });

  it("returns undefined for a page that doesn't exist", () => {
    expect(db.getPageTree("nope")).toBeUndefined();
  });

  it("returns the page plus its nested block tree", () => {
    const pageOp = pageCreate(db, "Projects/Nooklet");
    db.applyLocalOps([pageOp]);
    const pageId = pageOp.entity;

    const root = blockCreate(db, pageId, null, "a", "Root block");
    db.applyLocalOps([root]);
    const child = blockCreate(db, pageId, root.entity, "a", "Child block");
    db.applyLocalOps([child]);

    const result = db.getPageTree(pageId);
    expect(result?.page.name).toBe("Projects/Nooklet");
    expect(result?.blocks).toHaveLength(1);
    expect(result?.blocks[0]?.content).toBe("Root block");
    expect(result?.blocks[0]?.children[0]?.content).toBe("Child block");
  });
});

describe("WorkerDb.getJournalStream", () => {
  let db: WorkerDb;

  beforeEach(() => {
    db = new WorkerDb({ driver: memoryDriver(), transport: new NoopTransport() });
  });

  it("always includes today, virtual (page: null) when it has no page yet", () => {
    const stream = db.getJournalStream({ today: 20260910, maxDays: 5 });
    expect(stream).toHaveLength(1);
    expect(stream[0]).toEqual({ day: 20260910, page: null, blocks: [] });
  });

  it("includes earlier non-empty days, most recent first, capped at maxDays", () => {
    for (const day of [20260907, 20260908, 20260909]) {
      db.applyLocalOps([pageCreate(db, `journal-${day}`, day)]);
    }
    const stream = db.getJournalStream({ today: 20260910, maxDays: 2 });
    expect(stream.map((e) => e.day)).toEqual([20260910, 20260909, 20260908]);
  });

  it("today has real content when a page already exists for it", () => {
    const op = pageCreate(db, "journal-today", 20260910);
    db.applyLocalOps([op]);
    db.applyLocalOps([blockCreate(db, op.entity, null, "a", "did a thing")]);

    const stream = db.getJournalStream({ today: 20260910, maxDays: 0 });
    expect(stream).toHaveLength(1);
    expect(stream[0]?.page?.journalDay).toBe(20260910);
    expect(stream[0]?.blocks[0]?.content).toBe("did a thing");
  });
});

describe("WorkerDb change notifications (invalidation seam)", () => {
  it("fires a ChangeEvent naming the touched table and page for a local write", () => {
    const events: ChangeEvent[] = [];
    const db = new WorkerDb({
      driver: memoryDriver(),
      transport: new NoopTransport(),
      onChange: (e) => events.push(e),
    });

    const pageOp = pageCreate(db, "Alpha");
    db.applyLocalOps([pageOp]);
    expect(events.at(-1)).toEqual({ tables: ["page"], pageIds: [pageOp.entity] });

    const blockOp = blockCreate(db, pageOp.entity, null, "a", "hello");
    db.applyLocalOps([blockOp]);
    expect(events.at(-1)).toEqual({ tables: ["block"], pageIds: [pageOp.entity] });
  });

  it("onChange can be (re)registered after construction", () => {
    const db = new WorkerDb({ driver: memoryDriver(), transport: new NoopTransport() });
    const events: ChangeEvent[] = [];
    db.onChange((e) => events.push(e));
    const pageOp = pageCreate(db, "Alpha");
    db.applyLocalOps([pageOp]);
    expect(events).toHaveLength(1);
  });
});

describe("WorkerDb schema idempotency", () => {
  it("does not throw when constructed twice against the same already-initialized driver", () => {
    const driver = memoryDriver();
    new WorkerDb({ driver, transport: new NoopTransport() });
    expect(() => new WorkerDb({ driver, transport: new NoopTransport() })).not.toThrow();
  });
});
