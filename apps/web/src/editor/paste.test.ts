import type { Op } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { pasteMarkdownAsTree } from "./paste.js";
import { tree as buildTree, makeBlock, makeFakeClock } from "./test-helpers.js";

function contentOf(op: Op): string {
  return (op.payload as { content: string }).content;
}
function parentIdOf(op: Op): string | null {
  return (op.payload as { place: { parentId: string | null } }).place.parentId;
}
function orderOf(op: Op): string {
  return (op.payload as { place: { order: string } }).place.order;
}

describe("pasteMarkdownAsTree (R33 case 2: multi-line paste -> parseOutline -> a tree)", () => {
  it("inserts a nested tree as siblings AFTER the target when the target is non-empty", () => {
    const t = buildTree(makeBlock({ id: "A", order: "a0", content: "existing" }));
    const text = "- one\n  - nested\n- two\n";
    const { ops, focus } = pasteMarkdownAsTree(t, "A", text, makeFakeClock(), 5000);

    const creates = ops.filter((o) => o.payload.kind === "block.create");
    expect(creates).toHaveLength(3); // one, nested, two
    expect(creates.map(contentOf).sort()).toEqual(["nested", "one", "two"]);

    const oneCreate = creates.find((o) => contentOf(o) === "one");
    const nestedCreate = creates.find((o) => contentOf(o) === "nested");
    const twoCreate = creates.find((o) => contentOf(o) === "two");
    expect(oneCreate).toBeDefined();
    expect(nestedCreate).toBeDefined();
    expect(twoCreate).toBeDefined();
    const one = oneCreate as Op;
    const nested = nestedCreate as Op;
    const two = twoCreate as Op;

    expect(parentIdOf(one)).toBeNull();
    expect(parentIdOf(nested)).toBe(one.entity);
    expect(parentIdOf(two)).toBeNull();

    // Order: existing block A, then "one" (with "nested" under it), then "two".
    const oneOrder = orderOf(one);
    const twoOrder = orderOf(two);
    expect("a0" < oneOrder).toBe(true);
    expect(oneOrder < twoOrder).toBe(true);

    // Target A is untouched (not empty, so it is not replaced).
    expect(ops.some((o) => o.entity === "A")).toBe(false);
    expect(focus.id).toBe(two.entity);
  });

  it("replaces an empty, childless target instead of inserting after it", () => {
    const t = buildTree(makeBlock({ id: "A", order: "a0", content: "" }));
    const { ops } = pasteMarkdownAsTree(t, "A", "- alpha\n- beta\n", makeFakeClock(), 5000);
    expect(ops.some((o) => o.entity === "A" && o.payload.kind === "block.delete")).toBe(true);
    const creates = ops.filter((o) => o.payload.kind === "block.create");
    expect(creates.map(contentOf)).toEqual(["alpha", "beta"]);
  });

  it("keeps a fenced code block as a single block", () => {
    const t = buildTree(makeBlock({ id: "A", order: "a0", content: "x" }));
    const text = "- ```js\n  const x = 1;\n  ```\n- after\n";
    const { ops } = pasteMarkdownAsTree(t, "A", text, makeFakeClock(), 5000);
    const creates = ops.filter((o) => o.payload.kind === "block.create");
    expect(creates).toHaveLength(2);
    expect(contentOf(creates[0] as Op)).toContain("const x = 1;");
  });
});
