import { makeOp, type Op, type OpPayload } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { prepareExternalBatch } from "./external-batch.js";
import { EditHistory } from "./history.js";
import { makeBlock, makeFakeClock, tree } from "./test-helpers.js";

/** Ops as a command mints them — with ITS clock (another device string, so re-minting shows). */
const commandClock = makeFakeClock("cccccccc");
const minted = (entity: string, payload: OpPayload): Op =>
  makeOp(commandClock.next(), commandClock.device, entity, payload);

const page = tree(makeBlock({ id: "b1", order: "a0", content: "" }));

/** A `/template` into the empty bullet b1: two children and the first line's text. */
function templateIntoB1(): Op[] {
  return [
    minted("c1", {
      kind: "block.create",
      place: { pageId: "page1", parentId: "b1", order: "a0" },
      content: "first step",
      createdAt: 1,
    }),
    minted("c2", {
      kind: "block.create",
      place: { pageId: "page1", parentId: "b1", order: "a1" },
      content: "second step",
      marker: "TODO",
      createdAt: 1,
    }),
    minted("b1", { kind: "block.prop", key: "type", value: "checklist" }),
    minted("b1", { kind: "block.text", content: "Checklist" }),
  ];
}

describe("prepareExternalBatch", () => {
  it("re-mints every op with the tree's clock and keeps entities and payloads", () => {
    const ops = templateIntoB1();
    const clock = makeFakeClock("eeeeeeee");
    const prepared = prepareExternalBatch({ ops, anchorId: "b1" }, page, clock);
    expect(prepared?.ops.map((o) => [o.entity, o.payload])).toEqual(
      ops.map((o) => [o.entity, o.payload]),
    );
    expect(prepared?.ops.every((o) => o.device === "eeeeeeee")).toBe(true);
    expect(prepared?.ops.map((o) => o.hlc)).not.toEqual(ops.map((o) => o.hlc));
    expect(prepared?.focus).toBeUndefined();
  });

  it("turns the caret target into the tree's FocusChange", () => {
    const clock = makeFakeClock();
    const ops = templateIntoB1();
    expect(
      prepareExternalBatch(
        { ops, anchorId: "b1", focus: { blockId: "b1", caret: "end" } },
        page,
        clock,
      )?.focus,
    ).toEqual({ id: "b1", caret: { at: "end" } });
    expect(
      prepareExternalBatch({ ops, anchorId: "b1", focus: { blockId: "c1", caret: 3 } }, page, clock)
        ?.focus,
    ).toEqual({ id: "c1", caret: { offset: 3 } });
  });

  it("refuses a batch this tree cannot place: unknown anchor, another page, nothing to do", () => {
    const clock = makeFakeClock();
    expect(
      prepareExternalBatch({ ops: templateIntoB1(), anchorId: "gone" }, page, clock),
    ).toBeNull();
    expect(prepareExternalBatch({ ops: [], anchorId: "b1" }, page, clock)).toBeNull();
    const elsewhere = minted("x", {
      kind: "block.create",
      place: { pageId: "page2", parentId: null, order: "a0" },
      content: "x",
      createdAt: 1,
    });
    expect(prepareExternalBatch({ ops: [elsewhere], anchorId: "b1" }, page, clock)).toBeNull();
    const moveAway = minted("b1", {
      kind: "block.place",
      place: { pageId: "page2", parentId: null, order: "a0" },
    });
    expect(prepareExternalBatch({ ops: [moveAway], anchorId: "b1" }, page, clock)).toBeNull();
  });

  it("refuses an op the undo history cannot invert, rather than half-committing it", () => {
    const pageOp = minted("page1", { kind: "page.rename", name: "Other" });
    expect(
      prepareExternalBatch({ ops: [pageOp], anchorId: "b1" }, page, makeFakeClock()),
    ).toBeNull();
  });

  it("recorded as one transaction, a single undo deletes the copies and restores the text (B-108)", () => {
    const clock = makeFakeClock();
    const prepared = prepareExternalBatch({ ops: templateIntoB1(), anchorId: "b1" }, page, clock);
    if (!prepared) throw new Error("refused");
    const history = new EditHistory();
    history.record(prepared.ops, page, "structure", null, null);
    expect(history.depths()).toEqual({ undo: 1, redo: 0 });
    const undo = history.undo(clock);
    expect(undo?.ops.map((o) => [o.entity, o.payload.kind])).toEqual([
      ["b1", "block.text"],
      ["b1", "block.prop"],
      ["c2", "block.delete"],
      ["c1", "block.delete"],
    ]);
    expect(undo?.ops[0]?.payload).toEqual({ kind: "block.text", content: "" });
    expect(history.depths()).toEqual({ undo: 0, redo: 1 });
  });
});
