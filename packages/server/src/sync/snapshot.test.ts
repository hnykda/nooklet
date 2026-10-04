import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hlc, makeOp, newId, type SqlDriver } from "@nooklet/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { post } from "../test-helpers.js";
import {
  dumpState,
  getJson,
  loadSnapshot,
  makeClientDriver,
  makeSyncTestServer,
} from "./sync-test-helpers.js";

describe("GET /sync/snapshot", () => {
  it("401s with no bearer token", async () => {
    const { app } = makeSyncTestServer();
    const res = await app.request("/sync/snapshot");
    expect(res.status).toBe(401);
  });

  it("403s for a token without can_sync", async () => {
    const { app, writeToken } = makeSyncTestServer();
    const res = await getJson(app, "/sync/snapshot", writeToken);
    expect(res.status).toBe(403);
  });

  it("bootstraps a fresh replica byte-identical to the source, consistent with its own cursor", async () => {
    const { app, serverCtx, syncToken } = makeSyncTestServer();
    const clock = new Hlc("aaaaaaaa");
    const pageId = newId();
    const blockId = newId();
    const childId = newId();

    const ops = [
      makeOp(clock.next(), "aaaaaaaa", pageId, {
        kind: "page.create",
        name: "Snapshot Test",
        journalDay: null,
        createdAt: Date.now(),
      }),
      makeOp(clock.next(), "aaaaaaaa", blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "top",
        createdAt: Date.now(),
      }),
      makeOp(clock.next(), "aaaaaaaa", childId, {
        kind: "block.create",
        place: { pageId, parentId: blockId, order: "a0" },
        content: "nested",
        createdAt: Date.now(),
      }),
      makeOp(clock.next(), "aaaaaaaa", blockId, { kind: "block.prop", key: "area", value: "x" }),
      makeOp(clock.next(), "aaaaaaaa", pageId, { kind: "page.prop", key: "alias", value: "snap" }),
      makeOp(clock.next(), "aaaaaaaa", childId, { kind: "block.delete", deletedAt: Date.now() }),
    ];
    const pushRes = await post(app, "/sync/push", syncToken, { device_id: "aaaaaaaa", ops });
    expect(pushRes.json.rejected).toEqual([]);

    const snap = await getJson(app, "/sync/snapshot", syncToken);
    expect(snap.status).toBe(200);
    expect(snap.json.cursor).toBe(pushRes.json.server_seq);
    expect(snap.json.pages).toHaveLength(1);
    // both the live block and the tombstoned one are present (rule: not filtered to deleted_at IS NULL)
    expect(snap.json.blocks).toHaveLength(2);

    const clientDriver = makeClientDriver();
    loadSnapshot(clientDriver, snap.json);

    expect(dumpState(clientDriver)).toEqual(dumpState(serverCtx.driver));
  });
});

describe("GET /sync/snapshot, streamed from a file-backed database", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nooklet-snapshot-stream-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** One page with `n` blocks (each with a property), pushed as one batch. */
  async function seed(s: ReturnType<typeof makeSyncTestServer>, n: number, name = "Big Page") {
    const clock = new Hlc("aaaaaaaa");
    const pageId = newId();
    const ops = [
      makeOp(clock.next(), "aaaaaaaa", pageId, {
        kind: "page.create",
        name,
        journalDay: null,
        createdAt: 1,
      }),
    ];
    for (let i = 0; i < n; i++) {
      const id = newId();
      ops.push(
        makeOp(clock.next(), "aaaaaaaa", id, {
          kind: "block.create",
          place: { pageId, parentId: null, order: `a${String(i).padStart(5, "0")}` },
          content: `block ${i} — ${"text ".repeat(40)} „Příliš žluťoučký kůň“ 🐎`,
          createdAt: 1,
        }),
        makeOp(clock.next(), "aaaaaaaa", id, { kind: "block.prop", key: "area", value: `v${i}` }),
      );
    }
    const res = await post(s.app, "/sync/push", s.syncToken, { device_id: "aaaaaaaa", ops });
    expect(res.json.rejected).toEqual([]);
    return res.json.server_seq as number;
  }

  /** What the pre-streaming route returned: four `driver.all()`s through `JSON.stringify`. */
  function oldBody(driver: SqlDriver): string {
    return JSON.stringify({
      cursor: driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM op")?.n ?? 0,
      pages: driver.all("SELECT * FROM page"),
      blocks: driver.all("SELECT * FROM block"),
      block_props: driver.all("SELECT * FROM block_prop"),
      page_props: driver.all("SELECT * FROM page_prop"),
    });
  }

  it("sends exactly the bytes the in-memory version sent, across many chunks", async () => {
    const s = makeSyncTestServer({ dbPath: join(dir, "graph.sqlite") });
    await seed(s, 400); // ~400 KB of JSON: several 64 KiB pieces
    const res = await s.app.request("/sync/snapshot", {
      headers: { authorization: `Bearer ${s.syncToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(200_000);
    expect(body).toBe(oldBody(s.serverCtx.driver));

    const clientDriver = makeClientDriver();
    loadSnapshot(clientDriver, JSON.parse(body));
    expect(dumpState(clientDriver)).toEqual(dumpState(s.serverCtx.driver));
  });

  it("is one consistent instant: a write committed while the body is still being read is not in it", async () => {
    const s = makeSyncTestServer({ dbPath: join(dir, "graph.sqlite") });
    const cursorBefore = await seed(s, 400);
    const before = oldBody(s.serverCtx.driver);
    const res = await s.app.request("/sync/snapshot", {
      headers: { authorization: `Bearer ${s.syncToken}` },
    });
    // The response exists, its read transaction is open; now the graph moves on.
    const cursorAfter = await seed(s, 5, "Written Meanwhile");
    expect(cursorAfter).toBeGreaterThan(cursorBefore);
    const body = await res.text();
    expect(body).toBe(before);
    expect(JSON.parse(body).cursor).toBe(cursorBefore);
  });

  it("is gzipped for a client that asks, and decompresses to the same body", async () => {
    const s = makeSyncTestServer({ dbPath: join(dir, "graph.sqlite") });
    await seed(s, 50);
    const res = await s.app.request("/sync/snapshot", {
      headers: { authorization: `Bearer ${s.syncToken}`, "accept-encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const body = gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8");
    expect(body).toBe(oldBody(s.serverCtx.driver));
  });

  it("a client that disconnects mid-download releases the read connection", async () => {
    const s = makeSyncTestServer({ dbPath: join(dir, "graph.sqlite") });
    await seed(s, 400);
    const res = await s.app.request("/sync/snapshot", {
      headers: { authorization: `Bearer ${s.syncToken}` },
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    // With the reader's transaction gone, a checkpoint can reset the whole WAL.
    const ck = s.serverCtx.driver.get<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(ck?.busy).toBe(0);
  });
});
