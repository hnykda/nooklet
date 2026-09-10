/**
 * The end-to-end contract this whole protocol exists for: device A pushes, device B pulls and
 * applies via `@nooklet/core`'s own `applyOps` into its own (separate, in-memory) replica, and
 * both databases converge — same comparison approach as
 * `packages/core/src/sync/sync.property.test.ts`.
 */

import { applyOps as coreApplyOps, Hlc, makeOp, newId } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { post } from "../test-helpers.js";
import { dumpState, getJson, makeClientDriver, makeSyncTestServer } from "./sync-test-helpers.js";

describe("sync round trip: push (device A) -> pull (device B) -> applyOps", () => {
  it("converges page/block/prop state exactly", async () => {
    const { app, serverCtx, syncToken } = makeSyncTestServer();
    const clock = new Hlc("aaaaaaaa");
    const pageId = newId();
    const blockId = newId();
    const childId = newId();

    const ops = [
      makeOp(clock.next(), "aaaaaaaa", pageId, {
        kind: "page.create",
        name: "Round Trip",
        journalDay: null,
        createdAt: Date.now(),
      }),
      makeOp(clock.next(), "aaaaaaaa", blockId, {
        kind: "block.create",
        place: { pageId, parentId: null, order: "a0" },
        content: "hello",
        createdAt: Date.now(),
      }),
      makeOp(clock.next(), "aaaaaaaa", childId, {
        kind: "block.create",
        place: { pageId, parentId: blockId, order: "a0" },
        content: "world",
        createdAt: Date.now(),
      }),
      makeOp(clock.next(), "aaaaaaaa", blockId, {
        kind: "block.prop",
        key: "priority",
        value: "A",
      }),
    ];

    const pushRes = await post(app, "/sync/push", syncToken, { device_id: "aaaaaaaa", ops });
    expect(pushRes.status).toBe(200);
    expect(pushRes.json.rejected).toEqual([]);
    expect(pushRes.json.accepted).toHaveLength(ops.length);

    const pullRes = await getJson(app, "/sync/pull?device_id=bbbbbbbb&since=0", syncToken);
    expect(pullRes.status).toBe(200);
    expect(pullRes.json.has_more).toBe(false);
    expect(pullRes.json.ops).toHaveLength(ops.length);

    const clientDriver = makeClientDriver();
    coreApplyOps(clientDriver, pullRes.json.ops);

    expect(dumpState(clientDriver)).toEqual(dumpState(serverCtx.driver));

    const deviceRow = serverCtx.driver.get<{ acked_seq: number }>(
      "SELECT acked_seq FROM device WHERE id = ?",
      ["bbbbbbbb"],
    );
    expect(deviceRow?.acked_seq).toBe(pullRes.json.cursor);
  });

  it("a rejected cycle move never reaches device B, but its correction does — both converge", async () => {
    const { app, serverCtx, syncToken } = makeSyncTestServer();
    const clock = new Hlc("aaaaaaaa");
    const pageId = newId();
    const parentId = newId();
    const childId = newId();

    const setupOps = [
      makeOp(clock.next(), "aaaaaaaa", pageId, {
        kind: "page.create",
        name: "Cycle Round Trip",
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
    await post(app, "/sync/push", syncToken, { device_id: "aaaaaaaa", ops: setupOps });

    const cycleOp = makeOp(clock.next(), "aaaaaaaa", parentId, {
      kind: "block.place",
      place: { pageId, parentId: childId, order: "z0" },
    });
    const pushRes = await post(app, "/sync/push", syncToken, {
      device_id: "aaaaaaaa",
      ops: [cycleOp],
    });
    expect(pushRes.json.rejected).toEqual([{ id: cycleOp.id, reason: "cycle" }]);
    expect(pushRes.json.corrections).toHaveLength(1);

    const pullRes = await getJson(app, "/sync/pull?device_id=bbbbbbbb&since=0", syncToken);
    // 4 applied ops reach device B: page.create, 2x block.create, and the server's correction —
    // NOT the rejected block.place itself.
    expect(pullRes.json.ops).toHaveLength(4);
    expect(pullRes.json.ops.some((o: { id: string }) => o.id === cycleOp.id)).toBe(false);

    const clientDriver = makeClientDriver();
    coreApplyOps(clientDriver, pullRes.json.ops);

    expect(dumpState(clientDriver)).toEqual(dumpState(serverCtx.driver));
    const parentRow = clientDriver.get<{ parent_id: string | null }>(
      "SELECT parent_id FROM block WHERE id = ?",
      [parentId],
    );
    expect(parentRow?.parent_id).toBeNull();
  });
});
