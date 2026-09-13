import { describe, expect, it } from "vitest";
import { sameFields } from "./same-fields.js";
import type { EditableBlock } from "./types.js";

const block = (over: Partial<EditableBlock> = {}): EditableBlock => ({
  id: "b1",
  parentId: null,
  order: "a",
  content: "call the bank",
  marker: "TODO",
  priority: null,
  collapsed: false,
  scheduled: "2026-09-20",
  deadline: null,
  repeat: null,
  doneAt: null,
  properties: { owner: "[[Flash Target]]" },
  ...over,
});

describe("sameFields", () => {
  it("the same block read twice is the same, properties record included", () => {
    expect(sameFields(block(), block())).toBe(true);
    expect(sameFields({ id: "r", depth: 1 }, { id: "r", depth: 1 })).toBe(true);
    expect(sameFields(undefined, undefined)).toBe(true);
  });

  it("any field that differs is a change", () => {
    expect(sameFields(block(), block({ content: "call the bank!" }))).toBe(false);
    expect(sameFields(block(), block({ marker: "DONE" }))).toBe(false);
    expect(sameFields(block(), block({ collapsed: true }))).toBe(false);
    expect(sameFields(block(), block({ scheduled: null }))).toBe(false);
    expect(sameFields(block(), block({ properties: { owner: "[[Someone Else]]" } }))).toBe(false);
    expect(sameFields(block(), block({ properties: {} }))).toBe(false);
    expect(sameFields(block(), block({ properties: { owner: "[[Flash Target]]", x: "1" } }))).toBe(
      false,
    );
    expect(sameFields(block(), undefined)).toBe(false);
  });

  it("a field only one side has, or a value it cannot compare, is a change", () => {
    expect(sameFields({ id: "a" }, { id: "a", extra: undefined })).toBe(false);
    expect(sameFields({ id: "a", list: [1] }, { id: "a", list: [1] })).toBe(false);
    expect(sameFields({ id: "a", deep: { x: { y: 1 } } }, { id: "a", deep: { x: { y: 1 } } })).toBe(
      false,
    );
  });
});
