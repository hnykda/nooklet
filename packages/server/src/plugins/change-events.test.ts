/**
 * Direct unit tests of `onChange` (`./change-events.ts`) against real `serverApplyOps` writes:
 * confirms events fire with the right entity ids and `origin`, derived from `onCommit` + the
 * `changes` rows that commit produced.
 */
import { makeOp, newId } from "@nooklet/core";
import type { ServerChangeEvents } from "@nooklet/plugin-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext, serverApplyOps } from "../apply-ops.js";
import { openDb } from "../db.js";
import { onChange } from "./change-events.js";

let ctx: ServerContext;

beforeEach(() => {
  ctx = createServerContext(openDb({ path: ":memory:" }));
});

type Recorded = { name: keyof ServerChangeEvents; payload: unknown };

function record(): { events: Recorded[]; dispose: () => void } {
  const events: Recorded[] = [];
  const dispose = onChange(ctx, (name, payload) => {
    events.push({ name, payload });
  });
  return { events, dispose };
}

describe("change events (onCommit + changes rows)", () => {
  it("fires block.created with the entity id and origin for a page+block write", () => {
    const { events } = record();
    const pageId = newId();
    const blockId = newId();
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "d1", pageId, {
          kind: "page.create",
          name: "Test Page",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(ctx.hlc.next(), "d1", blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "hello world",
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "tester" },
    );

    const pageCreated = events.find((e) => e.name === "page.created");
    expect(pageCreated).toBeTruthy();
    const pageCreatedPayload = pageCreated?.payload as ServerChangeEvents["page.created"];
    expect(pageCreatedPayload.page.id).toBe(pageId);
    expect(pageCreatedPayload.origin).toEqual({ kind: "user" });

    const blockCreated = events.find((e) => e.name === "block.created");
    expect(blockCreated).toBeTruthy();
    const blockPayload = blockCreated?.payload as ServerChangeEvents["block.created"];
    expect(blockPayload.block.id).toBe(blockId);
    expect(blockPayload.block.content).toBe("hello world");
    expect(blockPayload.origin).toEqual({ kind: "user" });
  });

  it("fires tx.committed once per batch with every op and the shared origin", () => {
    const { events } = record();
    const pageId = newId();
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "d1", pageId, {
          kind: "page.create",
          name: "Batch Page",
          journalDay: null,
          createdAt: Date.now(),
        }),
      ],
      { origin: "mcp", actor: "claude" },
    );
    const committed = events.filter((e) => e.name === "tx.committed");
    expect(committed).toHaveLength(1);
    const payload = committed[0]?.payload as ServerChangeEvents["tx.committed"];
    expect(payload.origin).toEqual({ kind: "mcp" });
    expect(payload.ops.map((o) => o.entity)).toContain(pageId);
  });

  it("fires block.updated with a before/after content diff", () => {
    const pageId = newId();
    const blockId = newId();
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "d1", pageId, {
          kind: "page.create",
          name: "Edit Page",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(ctx.hlc.next(), "d1", blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "before text",
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "tester" },
    );

    const { events } = record();
    serverApplyOps(
      ctx,
      [makeOp(ctx.hlc.next(), "d1", blockId, { kind: "block.text", content: "after text" })],
      {
        origin: "user",
        actor: "tester",
      },
    );

    const updated = events.find((e) => e.name === "block.updated");
    expect(updated).toBeTruthy();
    const payload = updated?.payload as ServerChangeEvents["block.updated"];
    expect(payload.block.content).toBe("after text");
    expect(payload.before.content).toBe("before text");
  });

  it("fires block.moved with the before place", () => {
    const pageId = newId();
    const blockId = newId();
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "d1", pageId, {
          kind: "page.create",
          name: "Move Page",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(ctx.hlc.next(), "d1", blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "movable",
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "tester" },
    );

    const { events } = record();
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "d1", blockId, {
          kind: "block.place",
          place: { pageId, parentId: null, order: "z9" },
        }),
      ],
      { origin: "user", actor: "tester" },
    );

    const moved = events.find((e) => e.name === "block.moved");
    expect(moved).toBeTruthy();
    const payload = moved?.payload as ServerChangeEvents["block.moved"];
    expect(payload.before.order).toBe("a0");
    expect(payload.block.order).toBe("z9");
  });

  it("fires block.deleted", () => {
    const pageId = newId();
    const blockId = newId();
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "d1", pageId, {
          kind: "page.create",
          name: "Delete Page",
          journalDay: null,
          createdAt: Date.now(),
        }),
        makeOp(ctx.hlc.next(), "d1", blockId, {
          kind: "block.create",
          place: { pageId, parentId: null, order: "a0" },
          content: "gone soon",
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "tester" },
    );

    const { events } = record();
    serverApplyOps(
      ctx,
      [makeOp(ctx.hlc.next(), "d1", blockId, { kind: "block.delete", deletedAt: Date.now() })],
      { origin: "user", actor: "tester" },
    );

    const deleted = events.find((e) => e.name === "block.deleted");
    expect(deleted).toBeTruthy();
    const deletedPayload = deleted?.payload as ServerChangeEvents["block.deleted"];
    expect(deletedPayload.block.id).toBe(blockId);
  });

  it("stops delivering events once disposed", () => {
    const { events, dispose } = record();
    dispose();
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "d1", newId(), {
          kind: "page.create",
          name: "After dispose",
          journalDay: null,
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "tester" },
    );
    expect(events).toEqual([]);
  });

  it("does not replay history from before a listener subscribed", () => {
    serverApplyOps(
      ctx,
      [
        makeOp(ctx.hlc.next(), "d1", newId(), {
          kind: "page.create",
          name: "Before listener",
          journalDay: null,
          createdAt: Date.now(),
        }),
      ],
      { origin: "user", actor: "tester" },
    );
    const { events } = record();
    expect(events).toEqual([]);
  });
});
