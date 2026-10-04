import { applyOps, Hlc, initSchema, isId, makeOp, newId, type Op } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "./apply-ops.js";
import {
  CONFLICT_COPY_KEY,
  CONFLICT_DEVICE_ID,
  conflictCopyBlockId,
  SYNC_CONFLICT_KEY,
} from "./conflict-copy.js";
import { openDb } from "./db.js";
import { dumpState } from "./sync/sync-test-helpers.js";
import { verifyRebuildParity } from "./verify.js";

let ctx: ServerContext;
let devA: Hlc;
let devB: Hlc;
let page: string;

function push(dev: Hlc, ops: Op[], origin: "sync" | "api" = "sync") {
  return serverApplyOps(ctx, ops, {
    origin,
    actor: dev.device,
    deviceId: origin === "sync" ? dev.device : undefined,
  });
}

function create(dev: Hlc, content: string, order: string): string {
  const id = newId();
  push(dev, [
    makeOp(dev.next(), dev.device, id, {
      kind: "block.create",
      place: { pageId: page, parentId: null, order },
      content,
      createdAt: 1,
    }),
  ]);
  return id;
}

function report(dev: Hlc, block: string, loser: string): Op {
  return makeOp(dev.next(), dev.device, block, {
    kind: "block.prop",
    key: CONFLICT_COPY_KEY,
    value: loser,
  });
}

/** Live blocks of the page in display order: order key, then id (ADR 004). */
function outline(): Array<{ id: string; content: string; props: Record<string, string> }> {
  const rows = ctx.driver.all<{ id: string; content: string }>(
    "SELECT id, content FROM block WHERE page_id = ? AND deleted_at IS NULL ORDER BY order_key, id",
    [page],
  );
  return rows.map((r) => {
    const props: Record<string, string> = {};
    for (const p of ctx.driver.all<{ key: string; value: string | null }>(
      "SELECT key, value FROM block_prop WHERE block_id = ?",
      [r.id],
    )) {
      if (p.value !== null) props[p.key] = p.value;
    }
    return { ...r, props };
  });
}

/** A replica reading the whole log the way `/sync/pull` serves it. */
function freshReplicaMatchesServer(): void {
  const driver = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(driver);
  const ops = ctx.driver
    .all<{ id: string; hlc: string; device_id: string; entity: string; payload_json: string }>(
      "SELECT id, hlc, device_id, entity, payload_json FROM op WHERE status = 'applied' ORDER BY seq",
    )
    .map((r) => ({
      id: r.id,
      hlc: r.hlc,
      device: r.device_id,
      entity: r.entity,
      payload: JSON.parse(r.payload_json),
    })) as Op[];
  applyOps(driver, ops, { order: "seq" });
  expect(dumpState(driver)).toEqual(dumpState(ctx.driver));
  expect(verifyRebuildParity(ctx.driver).divergences).toEqual([]);
}

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
  devA = new Hlc("aaaaaaa1");
  devB = new Hlc("aaaaaaa2");
  page = newId();
  push(devA, [
    makeOp(devA.next(), devA.device, page, {
      kind: "page.create",
      name: "Conflicts",
      journalDay: null,
      createdAt: 1,
    }),
  ]);
});

describe("conflictCopyBlockId", () => {
  it("is a valid block id, stable for the same winner and text, different otherwise", () => {
    const a = conflictCopyBlockId("01abcdefghjkmn", "There is this");
    expect(isId(a)).toBe(true);
    expect(conflictCopyBlockId("01abcdefghjkmn", "There is this")).toBe(a);
    expect(conflictCopyBlockId("01abcdefghjkmn", "There is that")).not.toBe(a);
    expect(conflictCopyBlockId("01abcdefghjkmz", "There is this")).not.toBe(a);
    for (let i = 0; i < 200; i++) expect(isId(conflictCopyBlockId(newId(), `t${i}`))).toBe(true);
  });
});

describe("a conflict_copy report from a device (B-642, ADR 027)", () => {
  it("becomes a block right after the winner, marked sync-conflict, and the property is cleared", () => {
    const winner = create(devA, "Nothing", "a0");
    const next = create(devA, "the next block", "a1");

    const r = push(devB, [report(devB, winner, "There is this")]);

    const copyId = conflictCopyBlockId(winner, "There is this");
    expect(r.corrections.map((c) => [c.device, c.entity, c.payload.kind])).toEqual([
      [CONFLICT_DEVICE_ID, copyId, "block.create"],
      [CONFLICT_DEVICE_ID, winner, "block.prop"],
    ]);
    expect(outline()).toEqual([
      { id: winner, content: "Nothing", props: {} },
      { id: copyId, content: "There is this", props: { [SYNC_CONFLICT_KEY]: "true" } },
      { id: next, content: "the next block", props: {} },
    ]);
    freshReplicaMatchesServer();
  });

  it("keeps a nested winner's copy under the same parent", () => {
    const parent = create(devA, "parent", "a0");
    const winner = newId();
    push(devA, [
      makeOp(devA.next(), devA.device, winner, {
        kind: "block.create",
        place: { pageId: page, parentId: parent, order: "a0" },
        content: "child",
        createdAt: 1,
      }),
    ]);
    push(devB, [report(devB, winner, "other child")]);
    const copy = ctx.driver.get<{ parent_id: string | null }>(
      "SELECT parent_id FROM block WHERE id = ?",
      [conflictCopyBlockId(winner, "other child")],
    );
    expect(copy?.parent_id).toBe(parent);
    freshReplicaMatchesServer();
  });

  it("the second device reporting the same conflict creates nothing more", () => {
    const winner = create(devA, "Nothing", "a0");
    push(devB, [report(devB, winner, "There is this")]);
    // A noticed the same conflict too, with a NEWER clock than the server's clear — so its report
    // is applied, not lost to LWW, and would make a second block without the derived id.
    const fromA = makeOp(
      // 30 s ahead of the server: inside the 60 s drift allowance (ADR 003).
      new Hlc("aaaaaaa1", undefined, () => Date.now() + 30_000).next(),
      "aaaaaaa1",
      winner,
      { kind: "block.prop", key: CONFLICT_COPY_KEY, value: "There is this" },
    );
    const r = push(devA, [fromA]);
    expect(r.results.find((x) => x.id === fromA.id)?.status).toBe("applied");
    expect(r.corrections.map((c) => c.payload.kind)).toEqual(["block.prop"]);
    expect(outline().map((b) => b.content)).toEqual(["Nothing", "There is this"]);
    expect(outline()[0]?.props).toEqual({});
    freshReplicaMatchesServer();
  });

  it("a deleted copy is not brought back by a late duplicate report", () => {
    const winner = create(devA, "Nothing", "a0");
    push(devB, [report(devB, winner, "There is this")]);
    const copyId = conflictCopyBlockId(winner, "There is this");
    push(devA, [makeOp(devA.next(), devA.device, copyId, { kind: "block.delete", deletedAt: 5 })]);
    push(devA, [report(devA, winner, "There is this")]);
    expect(outline().map((b) => b.content)).toEqual(["Nothing"]);
    freshReplicaMatchesServer();
  });

  it("a report that lost LWW to an earlier clear still keeps its text", () => {
    const winner = create(devA, "Nothing", "a0");
    // A's report is minted first (older HLC) but pushed after B's has been materialised and
    // cleared: it is a `noop` on the property, and its text exists nowhere else.
    const stale = report(devA, winner, "A's lost words");
    push(devB, [report(devB, winner, "B's lost words")]);
    const r = push(devA, [stale]);
    expect(r.results.find((x) => x.id === stale.id)?.status).toBe("noop");
    expect(outline().map((b) => b.content)).toEqual([
      "Nothing",
      // Each copy goes directly after the winner, so the later one comes first.
      "A's lost words",
      "B's lost words",
    ]);
    freshReplicaMatchesServer();
  });

  it("a pre-existing conflict_copy is carried along, not dropped, when the block conflicts again", () => {
    const winner = create(devA, "Nothing", "a0");
    // Written by an API caller (as an older server would have left it): stays a property.
    push(devA, [report(devA, winner, "old loser")], "api");
    expect(outline()[0]?.props).toEqual({ [CONFLICT_COPY_KEY]: "old loser" });

    // B's report overwrites the property under LWW; the planner reads the pre-batch value too.
    push(devB, [report(devB, winner, "new loser")]);
    expect(outline().map((b) => b.content)).toEqual(["Nothing", "new loser", "old loser"]);
    expect(outline()[0]?.props).toEqual({});
    freshReplicaMatchesServer();
  });

  it("an api write of conflict_copy keeps the plain property", () => {
    const winner = create(devA, "Nothing", "a0");
    const r = push(devA, [report(devA, winner, "kept as a property")], "api");
    expect(r.corrections).toEqual([]);
    expect(outline()).toEqual([
      { id: winner, content: "Nothing", props: { [CONFLICT_COPY_KEY]: "kept as a property" } },
    ]);
  });

  it("a report whose text equals the winner's needs no copy", () => {
    const winner = create(devA, "same", "a0");
    push(devB, [report(devB, winner, "same")]);
    expect(outline()).toEqual([{ id: winner, content: "same", props: {} }]);
    freshReplicaMatchesServer();
  });
});
