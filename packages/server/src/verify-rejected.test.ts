import { Hlc, makeOp, newId } from "@nooklet/core";
import { beforeEach, describe, expect, it } from "vitest";
import { serverApplyOps } from "./apply-ops.js";
import { makeTestServer, post, type TestServer } from "./test-helpers.js";
import { formatVerifyReport, verifyRebuildParity } from "./verify.js";

let s: TestServer;
beforeEach(() => {
  s = makeTestServer();
});

/** A device clock that has seen the server's state so far, then goes offline. */
function offlineDevice(id: string): Hlc {
  const clock = new Hlc(id);
  clock.receive(s.serverCtx.hlc.next());
  return clock;
}

/** Whatever the server mints from now on is newer than `hlc` — deterministic, unlike waiting a
 * millisecond: the device's ops are OLDER than the server's writes made while it was offline. */
function serverMovesPast(hlc: string): void {
  s.serverCtx.hlc.receive(hlc);
}

describe("verify replays what the server decided, not ops it rejected (B-123)", () => {
  it("a late un-delete that lost its page name to a newer page is not a divergence", () => {
    const ctx = s.serverCtx;
    const p1 = newId();
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "00000000", p1, {
          kind: "page.create",
          name: "Dup",
          journalDay: null,
          createdAt: 1,
        }),
      ],
      { origin: "api", actor: "t" },
    );
    serverApplyOps(
      ctx,
      [makeOp(ctx.hlc.next(), "00000000", p1, { kind: "page.delete", deletedAt: 2 })],
      {
        origin: "api",
        actor: "t",
      },
    );
    const devA = offlineDevice("aaaaaaaa");
    const undelete = makeOp(devA.next(), "aaaaaaaa", p1, { kind: "page.delete", deletedAt: null });
    serverMovesPast(undelete.hlc);
    // Meanwhile, with a later HLC, the server creates a new "Dup".
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "00000000", newId(), {
          kind: "page.create",
          name: "Dup",
          journalDay: null,
          createdAt: 3,
        }),
      ],
      { origin: "api", actor: "t" },
    );
    const push = serverApplyOps(ctx, [undelete], {
      origin: "sync",
      actor: "devA",
      deviceId: "aaaaaaaa",
    });
    expect(push.results.map((r) => [r.status, r.reason])).toEqual([
      ["rejected", "page-key-collision"],
    ]);

    const report = verifyRebuildParity(ctx.driver);
    expect(report.divergences).toEqual([]);
    expect(report.rejectedSkipped).toBe(1);
    expect(formatVerifyReport(report)).toMatch(/1 rejected/);
  });

  it("an offline laptop's journal day that lost to an agent's page_append is not a divergence", async () => {
    const ctx = s.serverCtx;
    const devA = offlineDevice("aaaaaaaa");
    const day = newId();
    const laptop = [
      makeOp(devA.next(), "aaaaaaaa", day, {
        kind: "page.create",
        name: "2026-09-13",
        journalDay: 20260913,
        createdAt: 1,
      }),
    ];
    laptop.push(
      makeOp(devA.next(), "aaaaaaaa", newId(), {
        kind: "block.create",
        place: { pageId: day, parentId: null, order: "a0" },
        content: "typed offline",
        createdAt: 1,
      }),
    );
    serverMovesPast((laptop[1] as (typeof laptop)[number]).hlc);
    const append = await post(s.app, "/api/v1/page.append", s.writeToken, {
      page: "2026-09-13",
      markdown: "- from agent",
    });
    expect(append.status).toBe(200);
    const push = serverApplyOps(ctx, laptop, {
      origin: "sync",
      actor: "devA",
      deviceId: "aaaaaaaa",
    });
    expect(push.results.map((r) => r.status)).toEqual(["rejected", "rejected"]);

    expect(verifyRebuildParity(ctx.driver).divergences).toEqual([]);
  });
});
