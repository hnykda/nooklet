import { Hlc, makeOp, newId } from "@nooklet/core";
import { describe, expect, it } from "vitest";
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
