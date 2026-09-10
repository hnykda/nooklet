import { Hlc, makeOp, newId } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { post } from "../test-helpers.js";
import { type JsonAny, makeSyncTestServer } from "./sync-test-helpers.js";

describe("POST /sync/push", () => {
  it("401s with no bearer token", async () => {
    const { app } = makeSyncTestServer();
    const res = await app.request("/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: "aaaaaaaa", ops: [] }),
    });
    expect(res.status).toBe(401);
    const json: JsonAny = await res.json();
    expect(json.error.code).toBe("unauthorized");
  });

  it("403s for a token without can_sync", async () => {
    const { app, writeToken } = makeSyncTestServer();
    const res = await post(app, "/sync/push", writeToken, { device_id: "aaaaaaaa", ops: [] });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("forbidden");
  });

  it("400s on a malformed body", async () => {
    const { app, syncToken } = makeSyncTestServer();
    const res = await post(app, "/sync/push", syncToken, { ops: [] });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("invalid");
  });

  it("applies valid ops, returns accepted seqs and server_seq, and registers the device", async () => {
    const { app, serverCtx, syncToken } = makeSyncTestServer();
    const clock = new Hlc("aaaaaaaa");
    const pageId = newId();
    const op = makeOp(clock.next(), "aaaaaaaa", pageId, {
      kind: "page.create",
      name: "Push Test",
      journalDay: null,
      createdAt: Date.now(),
    });

    const res = await post(app, "/sync/push", syncToken, { device_id: "aaaaaaaa", ops: [op] });
    expect(res.status).toBe(200);
    expect(res.json.rejected).toEqual([]);
    expect(res.json.corrections).toEqual([]);
    expect(res.json.accepted).toHaveLength(1);
    expect(res.json.accepted[0].id).toBe(op.id);
    expect(typeof res.json.accepted[0].seq).toBe("number");
    expect(res.json.server_seq).toBe(res.json.accepted[0].seq);

    const device = serverCtx.driver.get<{ name: string; last_seen_at: number | null }>(
      "SELECT name, last_seen_at FROM device WHERE id = ?",
      ["aaaaaaaa"],
    );
    expect(device?.name).toBe("device-a");
    expect(device?.last_seen_at).not.toBeNull();
  });

  it("rejects a malformed op with reason invalid-op, without touching the rest of the batch", async () => {
    const { app, syncToken } = makeSyncTestServer();
    const clock = new Hlc("aaaaaaaa");
    const pageId = newId();
    const goodOp = makeOp(clock.next(), "aaaaaaaa", pageId, {
      kind: "page.create",
      name: "Ok Page",
      journalDay: null,
      createdAt: Date.now(),
    });
    const badOp = { id: "not-an-hlc", hlc: "not-an-hlc", device: "aaaaaaaa" };

    const res = await post(app, "/sync/push", syncToken, {
      device_id: "aaaaaaaa",
      ops: [goodOp, badOp],
    });
    expect(res.status).toBe(200);
    expect(res.json.accepted).toEqual([{ id: goodOp.id, seq: expect.any(Number) }]);
    expect(res.json.rejected).toEqual([{ id: "not-an-hlc", reason: "invalid-op" }]);
  });

  it("400s when a pushed op's HLC is implausibly far in the future (clock drift guard)", async () => {
    const { app, syncToken } = makeSyncTestServer();
    const farFuture = new Date(Date.now() + 10 * 60_000).toISOString();
    const hlc = `${farFuture}-0000-aaaaaaaa`;
    const op = makeOp(hlc, "aaaaaaaa", newId(), {
      kind: "page.create",
      name: "Future Page",
      journalDay: null,
      createdAt: Date.now(),
    });

    const res = await post(app, "/sync/push", syncToken, { device_id: "aaaaaaaa", ops: [op] });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("invalid");
  });

  it("rejects a cycle-creating move and returns a corrective op restoring the prior place", async () => {
    const { app, serverCtx, syncToken } = makeSyncTestServer();
    const clock = new Hlc("aaaaaaaa");
    const pageId = newId();
    const parentId = newId();
    const childId = newId();

    const setupOps = [
      makeOp(clock.next(), "aaaaaaaa", pageId, {
        kind: "page.create",
        name: "Cycle Test",
        journalDay: null,
        createdAt: Date.now(),
      }),
      makeOp(clock.next(), "aaaaaaaa", parentId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "parent",
        createdAt: Date.now(),
      }),
      makeOp(clock.next(), "aaaaaaaa", childId, {
        kind: "block.create",
        place: { pageId, parentId, order: "a0" },
        content: "child",
        createdAt: Date.now(),
      }),
    ];
    const setupRes = await post(app, "/sync/push", syncToken, {
      device_id: "aaaaaaaa",
      ops: setupOps,
    });
    expect(setupRes.json.rejected).toEqual([]);

    const cycleOp = makeOp(clock.next(), "aaaaaaaa", parentId, {
      kind: "block.place",
      place: { pageId, parentId: childId, order: "z0" },
    });
    const res = await post(app, "/sync/push", syncToken, {
      device_id: "aaaaaaaa",
      ops: [cycleOp],
    });

    expect(res.status).toBe(200);
    expect(res.json.rejected).toEqual([{ id: cycleOp.id, reason: "cycle" }]);
    expect(res.json.accepted).toEqual([]);
    expect(res.json.corrections).toHaveLength(1);
    const correction = res.json.corrections[0];
    expect(correction.entity).toBe(parentId);
    expect(correction.payload.kind).toBe("block.place");
    expect(correction.payload.place).toEqual({ pageId, parentId: null, order: "a0" });

    const row = serverCtx.driver.get<{ parent_id: string | null }>(
      "SELECT parent_id FROM block WHERE id = ?",
      [parentId],
    );
    expect(row?.parent_id).toBeNull();
  });

  it("does not notify/poke on an empty push and still 200s", async () => {
    const { app, syncToken } = makeSyncTestServer();
    const res = await post(app, "/sync/push", syncToken, { device_id: "aaaaaaaa", ops: [] });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ accepted: [], rejected: [], corrections: [], server_seq: 0 });
  });
});
