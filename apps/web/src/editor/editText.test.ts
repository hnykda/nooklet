/**
 * B-101 at the editor's own seams: the buffer carries property lines, the tree keeps content and
 * properties apart, undo restores a property, and a coalesced burst of typing that adds a property
 * still undoes and redoes it.
 */
import type { Op, OpPayload } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import {
  caretInEditText,
  contentOffsetOf,
  editTextMatches,
  editTextOf,
  withEditText,
} from "./editText.js";
import { EditHistory } from "./history.js";
import { invertOp } from "./invert.js";
import { applyOptimistic, type OptimisticOp } from "./optimistic.js";
import { tree as buildTree, makeBlock, makeFakeClock } from "./test-helpers.js";

describe("editing text <-> EditableBlock", () => {
  it("puts a block's properties into its buffer under line 1", () => {
    const b = makeBlock({ id: "A", content: "title\nbody", properties: { status: "done" } });
    expect(editTextOf(b)).toBe("title\nstatus:: done\nbody");
  });

  it("splits a typed property line out of the content (B-101)", () => {
    const b = makeBlock({ id: "A", content: "start here " });
    const next = withEditText(b, "start here \nstatus:: done");
    expect(next.content).toBe("start here ");
    expect(next.properties).toEqual({ status: "done" });
  });

  it("returns the same block when the buffer says nothing new, whatever the line order", () => {
    const b = makeBlock({ id: "A", content: "x\ny", properties: { a: "1", b: "2" } });
    expect(withEditText(b, "x\nb:: 2\ny\na:: 1")).toBe(b);
  });

  it("keeps a property the buffer could never show", () => {
    const b = makeBlock({ id: "A", content: "x", properties: { heading: "2", k: "v" } });
    expect(withEditText(b, "x").properties).toEqual({ heading: "2" });
  });

  it("keeps a multi-line value out of the buffer and in the block, however the buffer changes (B-152)", () => {
    const b = makeBlock({ id: "A", content: "title", properties: { summary: "one\ntwo", k: "v" } });
    expect(editTextOf(b)).toBe("title\nk:: v");
    expect(editTextMatches(b, "title\nk:: v")).toBe(true);
    const typed = withEditText(b, "title!\nk:: v");
    expect(typed.content).toBe("title!");
    expect(typed.properties).toEqual({ summary: "one\ntwo", k: "v" });
  });

  it("maps content carets into the buffer: end means end of the text, not of the last property", () => {
    const b = makeBlock({ id: "A", content: "ab\ncd", properties: { k: "v" } });
    // buffer: "ab\nk:: v\ncd"
    expect(caretInEditText(b, { at: "start" })).toEqual({ offset: 0 });
    expect(caretInEditText(b, { at: "end" })).toEqual({ offset: 11 });
    expect(caretInEditText(b, { offset: 3 })).toEqual({ offset: 9 });
    expect(contentOffsetOf(editTextOf(b), 9)).toBe(3);
    const single = makeBlock({ id: "B", content: "one", properties: { k: "v" } });
    expect(caretInEditText(single, { at: "end" })).toEqual({ offset: 3 });
  });

  it("is the identity for a block without properties", () => {
    const b = makeBlock({ id: "A", content: "plain" });
    expect(editTextOf(b)).toBe("plain");
    expect(caretInEditText(b, { at: "end" })).toEqual({ at: "end" });
  });
});

describe("generic properties in the optimistic tree and in undo", () => {
  const op = (entity: string, payload: OpPayload, n = 1): Op => ({
    id: `h${n}`,
    hlc: `h${n}`,
    device: "d",
    entity,
    payload,
  });

  it("applyOptimistic sets and removes a generic property, and a create carries its own", () => {
    const blocks = [makeBlock({ id: "A", content: "x", properties: { old: "1" } })];
    const out = applyOptimistic(
      blocks,
      [
        op("A", { kind: "block.prop", key: "status", value: "done" }),
        op("A", { kind: "block.prop", key: "old", value: null }),
        op("B", {
          kind: "block.create",
          place: { pageId: "page1", parentId: null, order: "a1" },
          content: "",
          properties: { list: "number", scheduled: "2026-09-20" },
          createdAt: 0,
        }),
      ] as unknown as OptimisticOp[],
      new Map(),
    );
    expect(out.find((b) => b.id === "A")?.properties).toEqual({ status: "done" });
    // Reserved keys ride in the same bag on the wire but are columns, not properties.
    expect(out.find((b) => b.id === "B")?.properties).toEqual({ list: "number" });
  });

  it("inverts a generic block.prop to the value it had, not to null", () => {
    const before = buildTree(makeBlock({ id: "A", properties: { status: "draft" } }));
    expect(
      invertOp("A", { kind: "block.prop", key: "status", value: "done" }, before, 0).payload,
    ).toEqual({ kind: "block.prop", key: "status", value: "draft" });
  });

  it("a coalesced burst that adds a property undoes and redoes the property too", () => {
    const h = new EditHistory(500);
    const t0 = buildTree(makeBlock({ id: "A", content: "x" }));
    const t1 = buildTree(makeBlock({ id: "A", content: "x", properties: { k: "v" } }));
    h.record(
      [op("A", { kind: "block.prop", key: "k", value: "v" }, 1)],
      t0,
      "text",
      null,
      null,
      "A",
      0,
    );
    h.record([op("A", { kind: "block.text", content: "xy" }, 2)], t1, "text", null, null, "A", 100);
    expect(h.depths().undo).toBe(1);
    const undo = h.undo(makeFakeClock())?.ops.map((o) => o.payload);
    expect(undo).toEqual(
      expect.arrayContaining([
        { kind: "block.prop", key: "k", value: null },
        { kind: "block.text", content: "x" },
      ]),
    );
    const redo = h.redo(makeFakeClock())?.ops.map((o) => o.payload);
    expect(redo).toEqual(
      expect.arrayContaining([
        { kind: "block.prop", key: "k", value: "v" },
        { kind: "block.text", content: "xy" },
      ]),
    );
  });
});
