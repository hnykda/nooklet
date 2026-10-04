/**
 * B-641: the replica keeps its own reference index and answers references from it — offline and in
 * local-only mode, where the panel used to say "Couldn't load references".
 */
import { DatabaseSync } from "node:sqlite";
import {
  applyOps,
  formatHlc,
  initSchema,
  makeOp,
  newId,
  type Op,
  type OpPayload,
  type SqlDriver,
} from "@nooklet/core";
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
import { drainRefIndex, FULL_REBUILD_THRESHOLD } from "./ref-index-client.js";
import { initClientSchema } from "./schema-client.js";
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

const OPTS = { includeUnlinked: true, unlinkedLimit: 50, linkedLimit: 5000 };

let driver: SqlDriver;
let db: WorkerDb;

function write(entity: string, payload: OpPayload): void {
  db.applyLocalOps([makeOp(db.sync.nextHlc(), db.getDeviceId(), entity, payload)]);
}
function page(name: string): string {
  const id = newId();
  write(id, { kind: "page.create", name, journalDay: null, createdAt: Date.now() });
  return id;
}
function block(pageId: string, content: string, parentId: string | null = null): string {
  const id = newId();
  write(id, {
    kind: "block.create",
    place: { pageId, parentId, order: `a${id}` },
    content,
    createdAt: Date.now(),
  });
  return id;
}

describe("references from the replica (B-641)", () => {
  beforeEach(() => {
    driver = createNodeSqliteDriver(new DatabaseSync(":memory:"));
    // Local-only: no server to ask, which is exactly where the panel used to fail.
    db = new WorkerDb({ driver, transport: new NoopTransport(), hasSyncTarget: false });
  });

  it("lists linked references, Logseq's direct count and unlinked mentions, with no server", () => {
    page("Target");
    const other = page("Other");
    const parent = block(other, "about [[Target]]");
    block(other, "inherits the link", parent);
    block(other, "mentions Target in passing");

    const answer = db.pageBacklinks("Target", OPTS);
    expect(answer.linked.map((r) => r.text).sort()).toEqual([
      "about [[Target]]",
      "inherits the link",
    ]);
    expect(answer.linked_total).toBe(2);
    expect(answer.linked_direct_total).toBe(1);
    expect(answer.linked.every((r) => r.page === "Other")).toBe(true);
    expect(answer.unlinked.map((r) => r.text)).toEqual(["mentions Target in passing"]);
    expect(answer.unlinkedAvailable).toBe(true);
  });

  it("follows edits: a link written, then removed, then a block moved under a link", () => {
    page("Target");
    const other = page("Other");
    const a = block(other, "plain");
    const b = block(other, "also plain");
    expect(db.pageBacklinks("Target", OPTS).linked_total).toBe(0);

    write(a, { kind: "block.text", content: "now [[Target]]" });
    expect(db.pageBacklinks("Target", OPTS).linked_direct_total).toBe(1);

    write(b, { kind: "block.place", place: { pageId: other, parentId: a, order: "b" } });
    expect(db.pageBacklinks("Target", OPTS).linked_total).toBe(2);

    write(a, { kind: "block.text", content: "plain again" });
    expect(db.pageBacklinks("Target", OPTS).linked_total).toBe(0);
  });

  it("sees tags:: and alias:: on pages, and a property's reference on a block", () => {
    const real = page("Real");
    write(real, { kind: "page.prop", key: "alias", value: "Nick" });
    const alice = page("Alice");
    write(alice, { kind: "page.prop", key: "tags", value: "Real" });
    const other = page("Other");
    const x = block(other, "met [[Nick]]");
    const y = block(other, "no link in the text");
    // Set twice: `applyOps` upserts properties, and the dirty-marking trigger once failed the
    // second write with a UNIQUE error (a trigger's OR IGNORE is overridden by the upsert's policy).
    write(y, { kind: "block.prop", key: "about", value: "[[Real]]" });
    write(y, { kind: "block.prop", key: "about", value: "[[Real]] again" });

    const answer = db.pageBacklinks("Real", OPTS);
    expect(answer.linked.map((r) => r.id).sort()).toEqual([x, y].sort());
    expect(answer.tagged_pages.map((p) => p.page)).toEqual(["Alice"]);
  });

  it("indexes rows written outside applyOps (a snapshot bootstrap inserts raw rows)", () => {
    page("Target");
    const pageId = newId();
    const now = Date.now();
    driver.run(
      "INSERT INTO page(id, name, key, journal_day, created_at, updated_at, name_hlc) VALUES (?, 'Raw', 'raw', NULL, ?, ?, 'h')",
      [pageId, now, now],
    );
    driver.run(
      "INSERT INTO block(id, page_id, parent_id, order_key, content, created_at, updated_at, place_hlc, content_hlc) VALUES (?, ?, NULL, 'a', 'raw [[Target]]', ?, ?, 'h', 'h')",
      [newId(), pageId, now, now],
    );
    expect(db.pageBacklinks("Target", OPTS).linked.map((r) => r.page)).toEqual(["Raw"]);
  });

  it("draws the link graph from the replica", () => {
    page("Target");
    const other = page("Other");
    block(other, "[[Target]]");
    const graph = db.graphLinks({ includeJournals: false, limit: 1500 });
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.map((n) => n.name).sort()).toEqual(["Other", "Target"]);
  });
});

describe("a replica that predates the index (the migration)", () => {
  it("is rebuilt whole on its first read, then kept incrementally", () => {
    driver = createNodeSqliteDriver(new DatabaseSync(":memory:"));
    initSchema(driver);
    initClientSchema(driver);
    // Rows written before this build: no index tables, no triggers.
    let tick = 0;
    const op = (entity: string, payload: OpPayload): Op =>
      makeOp(
        formatHlc({ wall: Date.now(), counter: tick++, device: "olddevic" }),
        "olddevic",
        entity,
        payload,
      );
    const target = newId();
    const other = newId();
    applyOps(driver, [
      op(target, { kind: "page.create", name: "Target", journalDay: null, createdAt: 1 }),
      op(other, { kind: "page.create", name: "Other", journalDay: null, createdAt: 1 }),
      op(newId(), {
        kind: "block.create",
        place: { pageId: other, parentId: null, order: "a" },
        content: "old [[Target]]",
        createdAt: 1,
      }),
    ]);

    db = new WorkerDb({ driver, transport: new NoopTransport(), hasSyncTarget: false });
    expect(driver.all("SELECT kind FROM ref_dirty")).toEqual([{ kind: "all" }]);
    expect(db.pageBacklinks("Target", OPTS).linked_total).toBe(1);
    expect(driver.all("SELECT 1 FROM ref_dirty")).toEqual([]);

    // Reopening does not queue another rebuild.
    db = new WorkerDb({ driver, transport: new NoopTransport(), hasSyncTarget: false });
    expect(driver.all("SELECT 1 FROM ref_dirty")).toEqual([]);
  });

  it("switches to a full rebuild past the threshold (a bootstrap or a long pull)", () => {
    driver = createNodeSqliteDriver(new DatabaseSync(":memory:"));
    db = new WorkerDb({ driver, transport: new NoopTransport(), hasSyncTarget: false });
    const p = page("Bulk");
    const ops: Op[] = [];
    for (let i = 0; i <= FULL_REBUILD_THRESHOLD; i++) {
      ops.push(
        makeOp(db.sync.nextHlc(), db.getDeviceId(), newId(), {
          kind: "block.create",
          place: { pageId: p, parentId: null, order: `a${i}` },
          content: i === 0 ? "[[Target]]" : "x",
          createdAt: 1,
        }),
      );
    }
    db.applyLocalOps(ops);
    expect(drainRefIndex(driver).mode).toBe("full");
    expect(db.pageBacklinks("Target", OPTS).linked_total).toBe(1);
  });
});
