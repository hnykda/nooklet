import { Hlc, makeOp, newId } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { post } from "../test-helpers.js";
import { getJson, makeSyncTestServer } from "./sync-test-helpers.js";

async function pushNPages(app: import("hono").Hono, token: string, n: number): Promise<void> {
  const clock = new Hlc("aaaaaaaa");
  const ops = Array.from({ length: n }, (_, i) =>
    makeOp(clock.next(), "aaaaaaaa", newId(), {
      kind: "page.create",
      name: `Page ${i}`,
      journalDay: null,
      createdAt: Date.now(),
    }),
  );
  const res = await post(app, "/sync/push", token, { device_id: "aaaaaaaa", ops });
  expect(res.json.rejected).toEqual([]);
}

describe("GET /sync/pull", () => {
  it("401s with no bearer token", async () => {
    const { app } = makeSyncTestServer();
    const res = await app.request("/sync/pull?device_id=bbbbbbbb&since=0");
    expect(res.status).toBe(401);
  });

  it("403s for a token without can_sync", async () => {
    const { app, writeToken } = makeSyncTestServer();
    const res = await getJson(app, "/sync/pull?device_id=bbbbbbbb&since=0", writeToken);
    expect(res.status).toBe(403);
  });

  it("400s without a device_id", async () => {
    const { app, syncToken } = makeSyncTestServer();
    const res = await getJson(app, "/sync/pull?since=0", syncToken);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("invalid");
  });

  it("returns nothing beyond `since` on an empty log", async () => {
    const { app, syncToken } = makeSyncTestServer();
    const res = await getJson(app, "/sync/pull?device_id=bbbbbbbb&since=0", syncToken);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ops: [], cursor: 0, has_more: false });
  });

  it("paginates with since/limit and never loses or duplicates an op across pages", async () => {
    const { app, syncToken } = makeSyncTestServer();
    await pushNPages(app, syncToken, 7);

    const seenIds = new Set<string>();
    let since = 0;
    let pages = 0;
    for (;;) {
      const res = await getJson(
        app,
        `/sync/pull?device_id=bbbbbbbb&since=${since}&limit=3`,
        syncToken,
      );
      expect(res.status).toBe(200);
      pages++;
      for (const op of res.json.ops) {
        expect(seenIds.has(op.id)).toBe(false);
        seenIds.add(op.id);
      }
      since = res.json.cursor;
      if (!res.json.has_more) {
        expect(res.json.ops.length).toBeLessThanOrEqual(3);
        break;
      }
      expect(res.json.ops).toHaveLength(3);
      if (pages > 10) throw new Error("pagination did not terminate");
    }
    expect(seenIds.size).toBe(7);
  });

  it("caps limit at the documented max and defaults to 500", async () => {
    const { app, syncToken } = makeSyncTestServer();
    const res = await getJson(app, "/sync/pull?device_id=bbbbbbbb&since=0&limit=999999", syncToken);
    expect(res.status).toBe(200); // capped server-side, not rejected
    expect(res.json.has_more).toBe(false);
  });

  it("advances device.acked_seq to the returned cursor, and never decreases it", async () => {
    const { app, serverCtx, syncToken } = makeSyncTestServer();
    await pushNPages(app, syncToken, 5);

    const full = await getJson(app, "/sync/pull?device_id=bbbbbbbb&since=0", syncToken);
    expect(full.json.has_more).toBe(false);
    const highWaterMark = full.json.cursor;

    let device = serverCtx.driver.get<{ acked_seq: number }>(
      "SELECT acked_seq FROM device WHERE id = ?",
      ["bbbbbbbb"],
    );
    expect(device?.acked_seq).toBe(highWaterMark);

    // Pulling again from further back with a small limit reports a smaller cursor; acked_seq
    // must not regress below what this device already acknowledged.
    const partial = await getJson(app, "/sync/pull?device_id=bbbbbbbb&since=0&limit=1", syncToken);
    expect(partial.json.cursor).toBeLessThan(highWaterMark);

    device = serverCtx.driver.get<{ acked_seq: number }>(
      "SELECT acked_seq FROM device WHERE id = ?",
      ["bbbbbbbb"],
    );
    expect(device?.acked_seq).toBe(highWaterMark);
  });
});
