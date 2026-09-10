import { describe, expect, it } from "vitest";
import { tree as buildTree, makeBlock, orders } from "./test-helpers.js";
import { applyPlaceInPlace, childrenIds, cloneTree, flattenVisible, subtreeIds } from "./tree.js";

describe("flattenVisible", () => {
  it("depth-first orders a whole page, respecting collapsed", () => {
    const [a, b, c] = orders(3);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", order: b as string, collapsed: true }),
      makeBlock({ id: "C", order: c as string }),
      makeBlock({ id: "B1", parentId: "B", order: "a0" }),
      makeBlock({ id: "A1", parentId: "A", order: "a0" }),
    );
    const rows = flattenVisible(t);
    // B is collapsed, so B1 must not appear.
    expect(rows.map((r) => r.id)).toEqual(["A", "A1", "B", "C"]);
    expect(rows.find((r) => r.id === "A")?.depth).toBe(0);
    expect(rows.find((r) => r.id === "A1")?.depth).toBe(1);
    expect(rows.find((r) => r.id === "B")?.hasChildren).toBe(true);
  });

  it("zoom root: renders only that block's subtree, root row included", () => {
    const t = buildTree(
      makeBlock({ id: "root", order: "a0" }),
      makeBlock({ id: "mid", parentId: "root", order: "a0" }),
      makeBlock({ id: "leaf", parentId: "mid", order: "a0" }),
      makeBlock({ id: "unrelated", order: "b0" }),
    );
    const rows = flattenVisible(t, { rootBlockId: "mid" });
    expect(rows.map((r) => r.id)).toEqual(["mid", "leaf"]);
    expect(rows[0]?.depth).toBe(0);
    expect(rows[1]?.depth).toBe(1);
  });
});

describe("subtreeIds", () => {
  it("returns the block and every descendant, pre-order", () => {
    const t = buildTree(
      makeBlock({ id: "A", order: "a0" }),
      makeBlock({ id: "A1", parentId: "A", order: "a0" }),
      makeBlock({ id: "A1a", parentId: "A1", order: "a0" }),
      makeBlock({ id: "A2", parentId: "A", order: "b0" }),
    );
    expect(subtreeIds(t, "A")).toEqual(["A", "A1", "A1a", "A2"]);
  });
});

describe("cloneTree / applyPlaceInPlace", () => {
  it("does not mutate the original tree", () => {
    const t = buildTree(makeBlock({ id: "A", order: "a0" }), makeBlock({ id: "B", order: "b0" }));
    const work = cloneTree(t);
    applyPlaceInPlace(work, "B", "A", "z0");
    expect(childrenIds(t, "A")).toEqual([]);
    expect(childrenIds(work, "A")).toEqual(["B"]);
    expect(childrenIds(t, null)).toEqual(["A", "B"]);
  });

  it("keeps siblings sorted by order after a move", () => {
    const t = buildTree(
      makeBlock({ id: "P", order: "a0" }),
      makeBlock({ id: "C1", parentId: "P", order: "b0" }),
      makeBlock({ id: "C2", parentId: "P", order: "d0" }),
      makeBlock({ id: "X", order: "c0" }),
    );
    applyPlaceInPlace(t, "X", "P", "c0");
    expect(childrenIds(t, "P")).toEqual(["C1", "X", "C2"]);
  });
});
