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

  // B-100/B-101: without this projection `list:: number` could never render and property chips
  // had nothing to show — every block reached the editor with no properties at all.
  it("carries each block's generic properties, not tombstones or reserved keys (B-100)", () => {
    const pageOp = pageCreate(db, "Numbered");
    db.applyLocalOps([pageOp]);
    const one = blockCreate(db, pageOp.entity, null, "a", "one");
    const two = blockCreate(db, pageOp.entity, null, "b", "two");
    db.applyLocalOps([one, two]);
    const prop = (entity: string, key: string, value: string | null): Op =>
      makeOp(db.sync.nextHlc(), db.getDeviceId(), entity, { kind: "block.prop", key, value });
    db.applyLocalOps([
      prop(one.entity, "list", "number"),
      prop(one.entity, "author", "Dan"),
      prop(one.entity, "scheduled", "2026-09-20"),
      prop(two.entity, "gone", "soon"),
    ]);
    db.applyLocalOps([prop(two.entity, "gone", null)]);

    const blocks = db.getPageTree(pageOp.entity)?.blocks ?? [];
    expect(blocks.map((b) => b.properties)).toEqual([{ author: "Dan", list: "number" }, {}]);
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

  it("gives a replica created before block_dated existed that index on its next open", () => {
    const hasIndex = (driver: SqlDriver): boolean =>
      driver.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'block_dated'") !==
      undefined;
    const driver = memoryDriver();
    new WorkerDb({ driver, transport: new NoopTransport() });
    expect(hasIndex(driver)).toBe(true);
    // An OPFS file from an older build: tables all there, the index not.
    driver.exec("DROP INDEX block_dated");
    new WorkerDb({ driver, transport: new NoopTransport() });
    expect(hasIndex(driver)).toBe(true);
  });
});

describe("WorkerDb.replayLocalOps (B-247)", () => {
  it("applies and queues ops the replica never saw, and skips ones it already recorded", () => {
    const driver = memoryDriver();
    const db = new WorkerDb({ driver, transport: new NoopTransport() });
    const landed = pageCreate(db, "Landed before the page went away");
    db.applyLocalOps([landed]);
    // The push went through: the outbox no longer holds it.
    driver.run("DELETE FROM pending_op");
    const lost = pageCreate(db, "Still queued when the page went away");

    expect(db.replayLocalOps([landed, lost])).toEqual({ replayed: 1, skipped: 1 });
    expect(db.query<{ name: string }>("SELECT name FROM page ORDER BY name")).toEqual([
      { name: "Landed before the page went away" },
      { name: "Still queued when the page went away" },
    ]);
    // Only the op that was really missing goes back out; the landed one is not pushed twice.
    expect(db.query<{ id: string }>("SELECT id FROM pending_op")).toEqual([{ id: lost.id }]);

    expect(db.replayLocalOps([landed, lost])).toEqual({ replayed: 0, skipped: 2 });
  });
});

/**
 * B-569, found on the Capacitor iOS shell with no server configured: `wsUrl()`
 * (`sync/http-transport.ts`) throws synchronously when it can't resolve a relative URL against
 * this worker's own `self.location` — a Capacitor-scheme-worker quirk, not a network failure.
 * `WorkerDb.start()` only wrapped `bootstrap()` in try/catch; an uncaught throw from
 * `connectLive()` right after it made `start()` itself reject, which permanently poisons
 * `db.worker.ts`'s cached `dbPromise` — every later worker RPC (`getPageTree`,
 * `getJournalStream`, the sidebar's queries) would reject forever, and with no `ErrorBoundary`
 * anywhere in the app the UI just froze on its first "Loading…" placeholder (B-400's shape).
 */
describe("WorkerDb.start (B-569)", () => {
  it("resolves even when the transport's connectLive() throws synchronously", async () => {
    class ThrowingConnectTransport extends NoopTransport {
      override connectLive(): () => void {
        throw new DOMException("The string did not match the expected pattern.", "SyntaxError");
      }
    }
    const db = new WorkerDb({ driver: memoryDriver(), transport: new ThrowingConnectTransport() });
    await expect(db.start()).resolves.toBeUndefined();
  });

  it("resolves even when both bootstrap() and connectLive() fail", async () => {
    class AllFailingTransport extends NoopTransport {
      override async snapshot(): Promise<SnapshotResponse> {
        throw new Error("network error");
      }
      override connectLive(): () => void {
        throw new DOMException("The string did not match the expected pattern.", "SyntaxError");
      }
    }
    const db = new WorkerDb({ driver: memoryDriver(), transport: new AllFailingTransport() });
    await expect(db.start()).resolves.toBeUndefined();
  });
});

describe("WorkerDb.start (B-567)", () => {
  class TrackingTransport extends NoopTransport {
    calls: string[] = [];
    override async snapshot(): Promise<SnapshotResponse> {
      this.calls.push("snapshot");
      return super.snapshot();
    }
    override async pull(deviceId: string, since: number): Promise<PullResponse> {
      this.calls.push("pull");
      return super.pull(deviceId, since);
    }
    override connectLive(deviceId: string, handlers: SyncLiveHandlers): () => void {
      this.calls.push("connectLive");
      return super.connectLive(deviceId, handlers);
    }
  }

  it("with hasSyncTarget: false, skips bootstrap/connectLive/pull entirely", async () => {
    const transport = new TrackingTransport();
    const db = new WorkerDb({ driver: memoryDriver(), transport, hasSyncTarget: false });
    await db.start();
    expect(transport.calls).toEqual([]);
  });

  it("with hasSyncTarget: true (the default), still attempts them, even against a target that will fail", async () => {
    const transport = new TrackingTransport();
    const db = new WorkerDb({ driver: memoryDriver(), transport });
    await db.start();
    expect(transport.calls).toContain("snapshot");
    expect(transport.calls).toContain("connectLive");
    expect(transport.calls).toContain("pull");
  });
});

describe("WorkerDb.applyLocalOps: pages a write references (B-568, B-585)", () => {
  function livePageNames(db: WorkerDb): string[] {
    return db
      .query<{ name: string }>("SELECT name FROM page WHERE deleted_at IS NULL ORDER BY name")
      .map((r) => r.name);
  }

  function writeLink(db: WorkerDb): void {
    const host = pageCreate(db, "Host");
    db.applyLocalOps([host]);
    db.applyLocalOps([blockCreate(db, host.entity, null, "a0", "see [[Proj/Sub]]")]);
  }

  it("with no server, the device mints the page and its ancestors in the same write", () => {
    const db = new WorkerDb({
      driver: memoryDriver(),
      transport: new NoopTransport(),
      localReferencePages: true,
    });
    writeLink(db);
    expect(livePageNames(db)).toEqual(["Host", "Proj", "Proj/Sub"]);
  });

  // B-585: a synced device minting under its own id gave the server pages it can never reclaim —
  // every intermediate name of a slowly-typed link became permanent (ref-pages.spec.ts:123).
  it("a synced device (the default) leaves minting to the server", () => {
    const db = new WorkerDb({ driver: memoryDriver(), transport: new NoopTransport() });
    writeLink(db);
    expect(livePageNames(db)).toEqual(["Host"]);
  });
});
