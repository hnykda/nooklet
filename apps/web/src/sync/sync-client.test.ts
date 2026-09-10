/**
 * `SyncClient` exercised against a fake `SyncTransport` — no network, no worker, no browser. The
 * driver is `@nooklet/core`'s Node `SqlDriver` adapter (real SQLite, in-memory or file-backed),
 * which is exactly the substitution the worker's own DB layer is designed for (see
 * `../db/worker-core.ts`'s header comment): production swaps in the sqlite-wasm/OPFS driver,
 * tests swap in this one, and `SyncClient`/`WorkerDb` never know the difference.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA_STATEMENTS, makeOp, type Op, type SqlDriver } from "@nooklet/core";
import { createNodeSqliteDriver } from "@nooklet/core/node-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_SCHEMA_STATEMENTS } from "../db/schema-client.js";
import { PUSH_DEBOUNCE_MS, SyncClient } from "./sync-client.js";
import type {
  PullResponse,
  PushRequestBody,
  PushResponse,
  SnapshotResponse,
  SyncLiveHandlers,
  SyncTransport,
} from "./types.js";

function schemaOn(driver: SqlDriver): void {
  for (const stmt of CORE_SCHEMA_STATEMENTS) driver.exec(stmt);
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) driver.exec(stmt);
}

function memoryDriver(): SqlDriver {
  const driver = createNodeSqliteDriver(new DatabaseSync(":memory:"));
  schemaOn(driver);
  return driver;
}

/** A fully controllable fake transport: responses and failures are set per test, and every call
 * is recorded so tests can assert on dedupe/ordering without a real network. */
class FakeTransport implements SyncTransport {
  pushCalls: PushRequestBody[] = [];
  pullCalls: Array<{ deviceId: string; since: number }> = [];
  snapshotCalls = 0;
  nextPush: PushResponse | (() => PushResponse) = {
    accepted: [],
    rejected: [],
    corrections: [],
    server_seq: 0,
  };
  nextPull: PullResponse | (() => PullResponse) = { ops: [], cursor: 0, has_more: false };
  nextSnapshot: SnapshotResponse = {
    cursor: 0,
    pages: [],
    blocks: [],
    block_props: [],
    page_props: [],
  };
  failPush = false;
  liveHandlers: SyncLiveHandlers | undefined;
  liveDeviceId: string | undefined;

  async push(body: PushRequestBody): Promise<PushResponse> {
    this.pushCalls.push(body);
    if (this.failPush) throw new Error("offline");
    return typeof this.nextPush === "function" ? this.nextPush() : this.nextPush;
  }

  async pull(deviceId: string, since: number): Promise<PullResponse> {
    this.pullCalls.push({ deviceId, since });
    return typeof this.nextPull === "function" ? this.nextPull() : this.nextPull;
  }

  async snapshot(): Promise<SnapshotResponse> {
    this.snapshotCalls++;
    return this.nextSnapshot;
  }

  connectLive(deviceId: string, handlers: SyncLiveHandlers): () => void {
    this.liveDeviceId = deviceId;
    this.liveHandlers = handlers;
    return () => {
      this.liveHandlers = undefined;
    };
  }
}

function pageCreateOp(client: SyncClient, name: string, id = `pg${name}`): Op {
  return makeOp(client.nextHlc(), client.getDeviceId(), id, {
    kind: "page.create",
    name,
    journalDay: null,
    createdAt: Date.now(),
  });
}

describe("SyncClient.applyLocal / flush (queue, flush, dedupe)", () => {
  let driver: SqlDriver;
  let transport: FakeTransport;
  let client: SyncClient;

  beforeEach(() => {
    driver = memoryDriver();
    transport = new FakeTransport();
    client = new SyncClient({ driver, transport });
    client.init();
  });

  it("queues ops into pending_op and applies them locally in one call", () => {
    const op = pageCreateOp(client, "Alpha");
    const result = client.applyLocal([op]);
    expect(result.applied).toBe(1);
    expect(driver.get("SELECT id FROM page WHERE id = ?", [op.entity])).toBeDefined();
    expect(driver.all("SELECT * FROM pending_op")).toHaveLength(1);
    expect(client.getStatus().pendingCount).toBe(1);
  });

  it("flush pushes queued ops and removes accepted ones", async () => {
    const op = pageCreateOp(client, "Alpha");
    client.applyLocal([op]);
    transport.nextPush = {
      accepted: [{ id: op.id, seq: 1 }],
      rejected: [],
      corrections: [],
      server_seq: 1,
    };

    await client.flush();

    expect(transport.pushCalls).toHaveLength(1);
    expect(transport.pushCalls[0]?.ops.map((o) => o.id)).toEqual([op.id]);
    expect(driver.all("SELECT * FROM pending_op")).toHaveLength(0);
    expect(client.getStatus().pendingCount).toBe(0);
  });

  it("also removes rejected ops from the queue (server is the sole arbiter)", async () => {
    const op = pageCreateOp(client, "Alpha");
    client.applyLocal([op]);
    transport.nextPush = {
      accepted: [],
      rejected: [{ id: op.id, reason: "cycle" }],
      corrections: [],
      server_seq: 0,
    };

    await client.flush();

    expect(driver.all("SELECT * FROM pending_op")).toHaveLength(0);
  });

  it("dedupes: applying the same op id twice queues it only once", () => {
    const op = pageCreateOp(client, "Alpha");
    client.applyLocal([op]);
    client.applyLocal([op]);
    expect(driver.all("SELECT * FROM pending_op")).toHaveLength(1);
  });

  it("a flush that fails (offline) leaves pending_op intact for the next attempt", async () => {
    const op = pageCreateOp(client, "Alpha");
    client.applyLocal([op]);
    transport.failPush = true;

    await client.flush();

    expect(driver.all("SELECT * FROM pending_op")).toHaveLength(1);
    expect(client.getStatus().state).toBe("offline");
  });

  it("schedulePush debounces: rapid successive edits push once", async () => {
    client.applyLocal([pageCreateOp(client, "A")]);
    client.applyLocal([pageCreateOp(client, "B")]);
    client.applyLocal([pageCreateOp(client, "C")]);
    await new Promise((r) => setTimeout(r, PUSH_DEBOUNCE_MS + 50));
    expect(transport.pushCalls).toHaveLength(1);
    expect(transport.pushCalls[0]?.ops).toHaveLength(3);
  });

  it("flush() drains pending_op in batches when pushBatchLimit is smaller than the queue", async () => {
    const small = new SyncClient({ driver, transport, pushBatchLimit: 2 });
    small.init();
    small.applyLocal([pageCreateOp(small, "A", "pgBatchA00001")]);
    small.applyLocal([pageCreateOp(small, "B", "pgBatchB00001")]);
    small.applyLocal([pageCreateOp(small, "C", "pgBatchC00001")]);
    transport.nextPush = () => {
      const batch = transport.pushCalls.at(-1);
      const accepted = (batch?.ops ?? []).map((o, i) => ({ id: o.id, seq: i + 1 }));
      return {
        accepted,
        rejected: [],
        corrections: [],
        server_seq: accepted.at(-1)?.seq ?? 0,
      };
    };

    await small.flush();

    expect(transport.pushCalls).toHaveLength(2); // ceil(3 / 2)
    expect(transport.pushCalls[0]?.ops).toHaveLength(2);
    expect(transport.pushCalls[1]?.ops).toHaveLength(1);
    expect(driver.all("SELECT * FROM pending_op")).toHaveLength(0);
  });
});

describe("SyncClient.pull (cursor advancement, corrections)", () => {
  let driver: SqlDriver;
  let transport: FakeTransport;
  let client: SyncClient;

  beforeEach(() => {
    driver = memoryDriver();
    transport = new FakeTransport();
    // Fixed clock so client-generated HLCs are deterministically comparable against the
    // hardcoded remote/correction HLCs below, regardless of the real wall clock.
    client = new SyncClient({
      driver,
      transport,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    client.init();
  });

  it("applies pulled ops and advances server_cursor", async () => {
    // Within the client's 60s HLC-drift tolerance of its fixed clock (2026-01-01T00:00:00.000Z).
    const remoteOp = makeOp("2026-01-01T00:00:00.010Z-0000-deadbeef", "deadbeef", "pgRemote", {
      kind: "page.create",
      name: "Remote",
      journalDay: null,
      createdAt: 0,
    });
    transport.nextPull = { ops: [remoteOp], cursor: 5, has_more: false };

    await client.pull();

    expect(driver.get("SELECT id FROM page WHERE id = ?", ["pgRemote"])).toBeDefined();
    const row = driver.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'server_cursor'",
    );
    expect(row?.value).toBe("5");
    expect(client.getStatus().serverCursor).toBe(5);
    // Threads the client's own device id through to the transport (server requires it to
    // advance that device's acked_seq — nothing else on a GET identifies the caller).
    expect(transport.pullCalls[0]).toEqual({ deviceId: client.getDeviceId(), since: 0 });
  });

  it("pulls again immediately on has_more: true, rather than waiting for the next poke", async () => {
    const small = new SyncClient({
      driver,
      transport,
      pullLimit: 2,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    small.init();
    const opAt = (n: number) =>
      makeOp(
        `2026-01-01T00:00:00.${String(n).padStart(3, "0")}Z-0000-deadbeef`,
        "deadbeef",
        `pgPage${n}0000`,
        {
          kind: "page.create",
          name: `Page ${n}`,
          journalDay: null,
          createdAt: 0,
        },
      );
    let call = 0;
    transport.nextPull = () => {
      call++;
      if (call === 1) return { ops: [opAt(1), opAt(2)], cursor: 2, has_more: true }; // more to come: keep going
      if (call === 2) return { ops: [opAt(3)], cursor: 3, has_more: false }; // caught up: stop
      throw new Error("pull() should have stopped once has_more was false");
    };

    await small.pull();

    // One `pull()` call drained both pages with no wait in between — a far-behind device (fresh
    // install, or offline for a week) does not crawl forward one page per poke.
    expect(transport.pullCalls.map((c) => c.since)).toEqual([0, 2]);
    expect(transport.pullCalls.every((c) => c.deviceId === small.getDeviceId())).toBe(true);
    expect(driver.all("SELECT id FROM page ORDER BY id")).toHaveLength(3);
    const cursor = driver.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'server_cursor'",
    );
    expect(cursor?.value).toBe("3");
  });

  it("does NOT pull again when a page is full but has_more is false (exact-multiple last page)", async () => {
    // Regression guard for the old `ops.length === pullLimit` heuristic: the server can return a
    // page exactly as large as `limit` that is also the last page (rows remaining == limit
    // exactly), signalled by `has_more: false`. A length-based heuristic would wrongly issue one
    // more, wasted round trip; `has_more` must be believed instead.
    const small = new SyncClient({
      driver,
      transport,
      pullLimit: 2,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    small.init();
    const opAt = (n: number) =>
      makeOp(
        `2026-01-01T00:00:00.${String(n).padStart(3, "0")}Z-0000-deadbeef`,
        "deadbeef",
        `pgFull${n}00000`,
        { kind: "page.create", name: `Page ${n}`, journalDay: null, createdAt: 0 },
      );
    transport.nextPull = { ops: [opAt(1), opAt(2)], cursor: 2, has_more: false };

    await small.pull();

    expect(transport.pullCalls).toHaveLength(1);
    expect(driver.all("SELECT id FROM page ORDER BY id")).toHaveLength(2);
  });

  it("removes a pending op that comes back from the server via pull (already accepted)", async () => {
    const op = pageCreateOp(client, "Local");
    client.applyLocal([op]);
    expect(driver.all("SELECT * FROM pending_op")).toHaveLength(1);
    transport.nextPull = { ops: [op], cursor: 1, has_more: false };

    await client.pull();

    expect(driver.all("SELECT * FROM pending_op")).toHaveLength(0);
  });

  it("applying a correction from push updates local state and advances the HLC clock", async () => {
    const op = pageCreateOp(client, "Alpha");
    client.applyLocal([op]);
    // 30s ahead of the client's fixed clock: newer than `op` (so the rename wins LWW) but well
    // within the 60s HLC-drift tolerance.
    const correction = makeOp("2026-01-01T00:00:30.000Z-0000-serverdv", "serverdv", op.entity, {
      kind: "page.rename",
      name: "Alpha (corrected)",
    });
    transport.nextPush = {
      accepted: [{ id: op.id, seq: 1 }],
      rejected: [],
      corrections: [correction],
      server_seq: 1,
    };

    await client.flush();

    const page = driver.get<{ name: string }>("SELECT name FROM page WHERE id = ?", [op.entity]);
    expect(page?.name).toBe("Alpha (corrected)");
    // The client's own clock must now sort after the correction's HLC.
    expect(client.nextHlc() > correction.hlc).toBe(true);
  });

  it("rejects (does not apply) a correction whose HLC drifts too far ahead (ADR 003)", async () => {
    const op = pageCreateOp(client, "Alpha");
    client.applyLocal([op]);
    // Hours ahead of the client's fixed clock (2026-01-01T00:00:00.000Z) — well past the 60s
    // drift guard (`HLC_MAX_DRIFT_MS`, @nooklet/core's hlc.ts).
    const wildCorrection = makeOp("2026-01-01T04:00:00.000Z-0000-serverdv", "serverdv", op.entity, {
      kind: "page.rename",
      name: "Should not apply",
    });
    transport.nextPush = {
      accepted: [{ id: op.id, seq: 1 }],
      rejected: [],
      corrections: [wildCorrection],
      server_seq: 1,
    };

    await client.flush();

    const page = driver.get<{ name: string }>("SELECT name FROM page WHERE id = ?", [op.entity]);
    expect(page?.name).toBe("Alpha"); // rename was NOT applied
    expect(client.getStatus().state).toBe("error");
    expect(client.getStatus().lastError).toMatch(/HLC drift/);
  });
});

describe("SyncClient three-way text merge (ADR 003 v1.1)", () => {
  let driver: SqlDriver;
  let transport: FakeTransport;
  let client: SyncClient;

  beforeEach(() => {
    driver = memoryDriver();
    transport = new FakeTransport();
    client = new SyncClient({
      driver,
      transport,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    client.init();
  });

  /** A page with one block whose text is `base`, already "confirmed" (nothing pending). */
  function seedBlock(base: string): string {
    const pageId = "pgMergeTest01";
    const blockId = "blkMergeTest1";
    client.applyLocal([
      makeOp(client.nextHlc(), client.getDeviceId(), pageId, {
        kind: "page.create",
        name: "Merge Test",
        journalDay: null,
        createdAt: 0,
      }),
      makeOp(client.nextHlc(), client.getDeviceId(), blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: base,
        createdAt: 0,
      }),
    ]);
    driver.run("DELETE FROM pending_op", []);
    return blockId;
  }

  it("merges concurrent edits to different parts of a block instead of losing one", async () => {
    const blockId = seedBlock("the quick brown fox jumps over the lazy dog");

    // Our unpushed local edit: brown -> red.
    client.applyLocal([
      makeOp(client.nextHlc(), client.getDeviceId(), blockId, {
        kind: "block.text",
        content: "the quick red fox jumps over the lazy dog",
      }),
    ]);

    // Concurrently, another device edited a different word: jumps -> leaps.
    transport.nextPull = {
      ops: [
        makeOp("2026-01-01T00:00:00.010Z-0000-deadbeef", "deadbeef", blockId, {
          kind: "block.text",
          content: "the quick brown fox leaps over the lazy dog",
        }),
      ],
      cursor: 9,
      has_more: false,
    };

    await client.pull();

    const row = driver.get<{ content: string }>("SELECT content FROM block WHERE id = ?", [
      blockId,
    ]);
    expect(row?.content).toBe("the quick red fox leaps over the lazy dog");
    // The merge result is queued for push so other devices converge on it too.
    const pending = driver.all<{ kind: string }>("SELECT kind FROM pending_op");
    expect(pending.some((p) => p.kind === "block.text")).toBe(true);
  });

  it("keeps the losing text as conflict_copy when both sides edited the same words", async () => {
    const blockId = seedBlock("the quick brown fox");

    client.applyLocal([
      makeOp(client.nextHlc(), client.getDeviceId(), blockId, {
        kind: "block.text",
        content: "the SLOW brown fox",
      }),
    ]);
    transport.nextPull = {
      ops: [
        makeOp("2026-01-01T00:00:00.010Z-0000-deadbeef", "deadbeef", blockId, {
          kind: "block.text",
          content: "the FAST brown fox",
        }),
      ],
      cursor: 9,
      has_more: false,
    };

    await client.pull();

    // Whichever side lost, its text survives as a property rather than vanishing.
    const prop = driver.get<{ value: string }>(
      "SELECT value FROM block_prop WHERE block_id = ? AND key = 'conflict_copy'",
      [blockId],
    );
    expect(prop?.value).toBeDefined();
    expect(["the SLOW brown fox", "the FAST brown fox"]).toContain(prop?.value);
  });
});

describe("SyncClient.bootstrap (fresh replica from snapshot)", () => {
  it("inserts snapshot rows directly and marks the replica bootstrapped", async () => {
    const driver = memoryDriver();
    const transport = new FakeTransport();
    transport.nextSnapshot = {
      cursor: 42,
      pages: [
        {
          id: "pg00000000001",
          name: "Home",
          key: "home",
          journal_day: null,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
          name_hlc: "2026-09-01T00:00:00.000Z-0000-aaaaaaaa",
          deleted_hlc: null,
        },
      ],
      blocks: [],
      block_props: [],
      page_props: [],
    };
    const client = new SyncClient({ driver, transport });
    client.init();

    expect(client.isBootstrapped()).toBe(false);
    await client.bootstrap();

    expect(client.isBootstrapped()).toBe(true);
    expect(driver.get("SELECT name FROM page WHERE id = 'pg00000000001'")).toEqual({
      name: "Home",
    });
    const cursor = driver.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'server_cursor'",
    );
    expect(cursor?.value).toBe("42");
    expect(client.getStatus().serverCursor).toBe(42);
  });
});

describe("SyncClient crash-safety", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nooklet-sync-test-"));
    dbPath = join(dir, "replica.sqlite3");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("pending ops survive a real close/reopen of the on-disk database", async () => {
    // "Session 1": create the schema, queue an op, then close the connection without ever
    // successfully pushing — simulating a crash between "applied locally" and "pushed".
    const db1 = new DatabaseSync(dbPath);
    const driver1 = createNodeSqliteDriver(db1);
    schemaOn(driver1);
    const offlineTransport = new FakeTransport();
    offlineTransport.failPush = true;
    const client1 = new SyncClient({ driver: driver1, transport: offlineTransport });
    client1.init();
    const op = pageCreateOp(client1, "Survives restart", "pgSurvives00001");
    client1.applyLocal([op]);
    await client1.flush(); // fails (offline); pending_op must still hold the row afterwards
    expect(driver1.all("SELECT * FROM pending_op")).toHaveLength(1);
    db1.close();

    // "Session 2": reopen the same file as a brand-new connection/driver/SyncClient instance.
    const db2 = new DatabaseSync(dbPath);
    const driver2 = createNodeSqliteDriver(db2);
    const onlineTransport = new FakeTransport();
    onlineTransport.nextPush = {
      accepted: [{ id: op.id, seq: 1 }],
      rejected: [],
      corrections: [],
      server_seq: 1,
    };
    const client2 = new SyncClient({ driver: driver2, transport: onlineTransport });
    client2.init();

    expect(driver2.all("SELECT * FROM pending_op")).toHaveLength(1);
    expect(client2.getDeviceId()).toBe(client1.getDeviceId()); // device id itself persisted too

    await client2.flush();

    expect(onlineTransport.pushCalls[0]?.ops.map((o) => o.id)).toEqual([op.id]);
    expect(driver2.all("SELECT * FROM pending_op")).toHaveLength(0);
    db2.close();
  });
});
