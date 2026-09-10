import { describe, expect, it } from "vitest";
import {
  deleteForwardMerge,
  deleteSelectedBlocks,
  duplicateBlock,
  indentBlock,
  indentSelectedBlocks,
  mergeWithPrevious,
  moveBlock,
  outdentBlock,
  outdentSelectedBlocks,
  splitBlock,
} from "./commands.js";
import { tree as buildTree, makeBlock, makeFakeClock, orders } from "./test-helpers.js";
import { childrenIds, flattenVisible } from "./tree.js";

/** Real, valid fractional-indexing keys for `n` top-level (or otherwise-unrelated) blocks —
 * `EditableBlock.order` must always be something `@nooklet/core`'s `orderBetween` accepts as a
 * bound, since almost every command computes a fresh order relative to existing ones. */
function o(n: number): string[] {
  return orders(n) as string[];
}

describe("splitBlock (R16)", () => {
  it("splits at the caret into before/after; new block is the NEXT SIBLING when there are no children", () => {
    const [a] = o(1);
    const t = buildTree(makeBlock({ id: "A", order: a as string, content: "hello world" }));
    const clock = makeFakeClock();
    const { ops, focus } = splitBlock(t, "A", 5, clock, 1000);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      entity: "A",
      payload: { kind: "block.text", content: "hello" },
    });
    expect(ops[1]).toMatchObject({
      payload: { kind: "block.create", content: " world", place: { parentId: null } },
    });
    expect(focus.caret).toEqual({ at: "start" });
    expect(focus.id).not.toBe("A");
  });

  it("new block is the FIRST CHILD when the block is expanded and has children (R16)", () => {
    const [a] = o(1);
    const [a1] = o(1);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string, content: "parent text", collapsed: false }),
      makeBlock({ id: "A1", parentId: "A", order: a1 as string, content: "existing child" }),
    );
    const clock = makeFakeClock();
    const { ops } = splitBlock(t, "A", 6, clock, 1000);
    const create = ops.find((o) => o.payload.kind === "block.create");
    expect(create?.payload).toMatchObject({ place: { parentId: "A" } });
    if (create?.payload.kind === "block.create") {
      // the new child's order must sort BEFORE the existing child A1.
      expect(create.payload.place.order < (a1 as string)).toBe(true);
    }
  });

  it("does NOT insert as first child when the block is collapsed, even with children", () => {
    const [a] = o(1);
    const [a1] = o(1);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string, content: "parent text", collapsed: true }),
      makeBlock({ id: "A1", parentId: "A", order: a1 as string }),
    );
    const { ops } = splitBlock(t, "A", 6, makeFakeClock(), 1000);
    const create = ops.find((o) => o.payload.kind === "block.create");
    expect(create?.payload).toMatchObject({ place: { parentId: null } });
  });

  it("degenerates to inserting an empty sibling when the block was already empty", () => {
    const [a] = o(1);
    const t = buildTree(makeBlock({ id: "A", order: a as string, content: "" }));
    const { ops } = splitBlock(t, "A", 0, makeFakeClock(), 1000);
    // No point rewriting A's content to the same empty string.
    expect(ops.filter((op) => op.payload.kind === "block.text")).toHaveLength(0);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.payload).toMatchObject({ kind: "block.create", content: "" });
  });
});

describe("indentBlock (R18)", () => {
  it("is a no-op for the first child / first top-level block", () => {
    const [a, b] = o(2);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", order: b as string }),
    );
    expect(indentBlock(t, "A", makeFakeClock())).toBeNull();
  });

  it("becomes the previous sibling's LAST child", () => {
    const [a, b] = o(2);
    const [s1] = o(1);
    const t = buildTree(
      makeBlock({ id: "S", order: a as string }),
      makeBlock({ id: "S1", parentId: "S", order: s1 as string }),
      makeBlock({ id: "B", order: b as string }),
    );
    const { ops } = indentBlock(t, "B", makeFakeClock()) ?? { ops: [] };
    expect(ops[0]).toMatchObject({
      entity: "B",
      payload: { kind: "block.place", place: { parentId: "S" } },
    });
    if (ops[0]?.payload.kind === "block.place") {
      expect(ops[0].payload.place.order > (s1 as string)).toBe(true);
    }
  });
});

describe("outdentBlock (R19) — the spec's own worked example", () => {
  // - A
  //   - B
  //   - C   <- focus, outdent
  //   - D
  //   - E
  // - F
  // =>
  // - A
  //   - B
  // - C
  //   - D
  //   - E
  // - F
  function scenario() {
    const [a0, f0] = o(2);
    const [b, c, d, e] = o(4);
    return buildTree(
      makeBlock({ id: "A", order: a0 as string }),
      makeBlock({ id: "F", order: f0 as string }),
      makeBlock({ id: "B", parentId: "A", order: b as string }),
      makeBlock({ id: "C", parentId: "A", order: c as string }),
      makeBlock({ id: "D", parentId: "A", order: d as string }),
      makeBlock({ id: "E", parentId: "A", order: e as string }),
    );
  }

  it("moves C to A's level (next sibling of A) and reparents D, E under C, in order", () => {
    const t = scenario();
    const { ops } = outdentBlock(t, "C", makeFakeClock()) ?? { ops: [] };
    expect(ops).toHaveLength(3); // C's own place, D's place, E's place
    const byEntity = Object.fromEntries(ops.map((op) => [op.entity, op]));
    expect(byEntity.C?.payload).toMatchObject({ kind: "block.place", place: { parentId: null } });
    expect(byEntity.D?.payload).toMatchObject({ kind: "block.place", place: { parentId: "C" } });
    expect(byEntity.E?.payload).toMatchObject({ kind: "block.place", place: { parentId: "C" } });
    // D must sort before E under C.
    if (byEntity.D?.payload.kind === "block.place" && byEntity.E?.payload.kind === "block.place") {
      expect(byEntity.D.payload.place.order < byEntity.E.payload.place.order).toBe(true);
    }
  });

  it("appends reparented younger siblings AFTER any pre-existing children of the outdented block", () => {
    const [a] = o(1);
    const [b, c, d] = o(3);
    const [c1] = o(1);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", parentId: "A", order: b as string }),
      makeBlock({ id: "C", parentId: "A", order: c as string }),
      makeBlock({ id: "D", parentId: "A", order: d as string }),
      makeBlock({ id: "C1", parentId: "C", order: c1 as string }), // C already has a child
    );
    const { ops } = outdentBlock(t, "C", makeFakeClock()) ?? { ops: [] };
    const dOp = ops.find((op) => op.entity === "D");
    expect(dOp?.payload).toMatchObject({ kind: "block.place", place: { parentId: "C" } });
    if (dOp?.payload.kind === "block.place")
      expect(dOp.payload.place.order > (c1 as string)).toBe(true);
  });

  it("is a no-op at the page root", () => {
    const [a] = o(1);
    const t = buildTree(makeBlock({ id: "A", order: a as string }));
    expect(outdentBlock(t, "A", makeFakeClock())).toBeNull();
  });

  it("is a no-op when the target is the current zoom root", () => {
    const [a] = o(1);
    const [b] = o(1);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", parentId: "A", order: b as string }),
    );
    expect(outdentBlock(t, "B", makeFakeClock(), { zoomRootId: "B" })).toBeNull();
  });
});

describe("mergeWithPrevious (R20) — the spec's own worked example", () => {
  // - A
  //   - B|        <- focus, content "note", Backspace at offset 0
  //     - X
  // - C
  // =>
  // - A|note
  //   - X
  // - C
  it("joins into the parent when B is the first visible child, reparenting X, deleting B", () => {
    const [a, c] = o(2);
    const [b] = o(1);
    const [x] = o(1);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string, content: "" }),
      makeBlock({ id: "C", order: c as string, content: "" }),
      makeBlock({ id: "B", parentId: "A", order: b as string, content: "note" }),
      makeBlock({ id: "X", parentId: "B", order: x as string }),
    );
    const rows = flattenVisible(t).map((r) => r.id); // A, B, X, C
    const { ops, focus } = mergeWithPrevious(t, rows, "B", makeFakeClock(), 5000) ?? {
      ops: [],
      focus: undefined as never,
    };
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ entity: "A", payload: { kind: "block.text", content: "note" } });
    expect(ops[1]).toMatchObject({
      entity: "X",
      payload: { kind: "block.place", place: { parentId: "A" } },
    });
    expect(ops[2]).toMatchObject({ entity: "B", payload: { kind: "block.delete" } });
    expect(focus).toEqual({ id: "A", caret: { offset: 0 } });
  });

  it("is a no-op for an empty block that still has children", () => {
    const [a] = o(1);
    const [b] = o(1);
    const [x] = o(1);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", parentId: "A", order: b as string, content: "" }),
      makeBlock({ id: "X", parentId: "B", order: x as string }),
    );
    const rows = flattenVisible(t).map((r) => r.id);
    expect(mergeWithPrevious(t, rows, "B", makeFakeClock())).toBeNull();
  });

  it("deletes an empty, childless block and focuses the previous block at its end", () => {
    const [a, b] = o(2);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string, content: "hello" }),
      makeBlock({ id: "B", order: b as string, content: "" }),
    );
    const rows = flattenVisible(t).map((r) => r.id);
    const result = mergeWithPrevious(t, rows, "B", makeFakeClock(), 5000);
    expect(result?.ops).toEqual([
      expect.objectContaining({ entity: "B", payload: { kind: "block.delete", deletedAt: 5000 } }),
    ]);
    expect(result?.focus).toEqual({ id: "A", caret: { at: "end" } });
  });

  it("is a no-op at the very first row of the page", () => {
    const [a] = o(1);
    const t = buildTree(makeBlock({ id: "A", order: a as string }));
    const rows = flattenVisible(t).map((r) => r.id);
    expect(mergeWithPrevious(t, rows, "A", makeFakeClock())).toBeNull();
  });
});

describe("deleteForwardMerge (R21)", () => {
  it("appends the next block's content and reparents ITS children as trailing children of this block", () => {
    // A (no children of its own) followed by B (has a child B1): merging A<-B must fold B1 in
    // under A, after any pre-existing children of A (there are none here).
    const [a, b] = o(2);
    const [b1] = o(1);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string, content: "foo" }),
      makeBlock({ id: "B", order: b as string, content: "bar" }),
      makeBlock({ id: "B1", parentId: "B", order: b1 as string }),
    );
    const rows = flattenVisible(t).map((r) => r.id); // A, B, B1
    const { ops } = deleteForwardMerge(t, rows, "A", makeFakeClock(), 5000) ?? { ops: [] };
    expect(ops[0]).toMatchObject({
      entity: "A",
      payload: { kind: "block.text", content: "foobar" },
    });
    const placeOp = ops.find((op) => op.entity === "B1");
    expect(placeOp?.payload).toMatchObject({ kind: "block.place", place: { parentId: "A" } });
    expect(ops.at(-1)).toMatchObject({ entity: "B", payload: { kind: "block.delete" } });
  });

  it("is a no-op at the last row", () => {
    const [a] = o(1);
    const t = buildTree(makeBlock({ id: "A", order: a as string }));
    const rows = flattenVisible(t).map((r) => r.id);
    expect(deleteForwardMerge(t, rows, "A", makeFakeClock())).toBeNull();
  });
});

describe("moveBlock (R22)", () => {
  it("swaps with the previous sibling; no-op at the first position", () => {
    const [a, b, c] = o(3);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", order: b as string }),
      makeBlock({ id: "C", order: c as string }),
    );
    expect(moveBlock(t, "A", "up", makeFakeClock())).toBeNull();
    const { ops } = moveBlock(t, "B", "up", makeFakeClock()) ?? { ops: [] };
    expect(ops[0]).toMatchObject({
      entity: "B",
      payload: { kind: "block.place", place: { parentId: null } },
    });
    if (ops[0]?.payload.kind === "block.place") {
      expect(ops[0].payload.place.order < (a as string)).toBe(true);
    }
  });

  it("swaps with the next sibling; no-op at the last position", () => {
    const [a, b] = o(2);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", order: b as string }),
    );
    expect(moveBlock(t, "B", "down", makeFakeClock())).toBeNull();
    const { ops } = moveBlock(t, "A", "down", makeFakeClock()) ?? { ops: [] };
    if (ops[0]?.payload.kind === "block.place")
      expect(ops[0].payload.place.order > (b as string)).toBe(true);
  });
});

describe("duplicateBlock (R32)", () => {
  it("deep-copies the subtree with fresh ids, preserving content/marker/collapsed", () => {
    const [a] = o(1);
    const [a1] = o(1);
    const t = buildTree(
      makeBlock({
        id: "A",
        order: a as string,
        content: "todo item",
        marker: "TODO",
        collapsed: false,
      }),
      makeBlock({ id: "A1", parentId: "A", order: a1 as string, content: "child" }),
    );
    const { ops, focus } = duplicateBlock(t, "A", makeFakeClock(), 9000);
    const creates = ops.filter((op) => op.payload.kind === "block.create");
    expect(creates).toHaveLength(2);
    expect(creates.map((op) => op.entity)).not.toContain("A");
    expect(creates.map((op) => op.entity)).not.toContain("A1");
    expect(new Set(creates.map((op) => op.entity)).size).toBe(2); // fresh & distinct
    const rootCreate = creates.find(
      (op) => (op.payload as { place: { parentId: string | null } }).place.parentId === null,
    );
    expect(rootCreate?.payload).toMatchObject({ content: "todo item", marker: "TODO" });
    expect(focus.id).toBe(rootCreate?.entity);
    expect(focus.caret).toEqual({ offset: "todo item".length });
  });

  it("copies scheduled/repeat/done as block.prop ops (task state is not cleared)", () => {
    const [a] = o(1);
    const t = buildTree(
      makeBlock({
        id: "A",
        order: a as string,
        content: "x",
        scheduled: "2026-09-12",
        repeat: "1w",
        doneAt: 1_760_000_000_000,
      }),
    );
    const { ops } = duplicateBlock(t, "A", makeFakeClock(), 9000);
    expect(
      ops.some(
        (op) =>
          op.payload.kind === "block.prop" &&
          op.payload.key === "scheduled" &&
          op.payload.value === "2026-09-12",
      ),
    ).toBe(true);
    expect(
      ops.some(
        (op) =>
          op.payload.kind === "block.prop" &&
          op.payload.key === "repeat" &&
          op.payload.value === "1w",
      ),
    ).toBe(true);
    expect(ops.some((op) => op.payload.kind === "block.prop" && op.payload.key === "done")).toBe(
      true,
    );
  });
});

describe("multi-block selection commands (R31)", () => {
  it("deleteSelectedBlocks tombstones every selected block AND its whole subtree, without duplicates", () => {
    const [a, b] = o(2);
    const [a1] = o(1);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "A1", parentId: "A", order: a1 as string }),
      makeBlock({ id: "B", order: b as string }),
    );
    const { ops } = deleteSelectedBlocks(t, ["A", "A1"], makeFakeClock(), 1000);
    // A1 is a descendant of A; selecting both must not delete A1 twice.
    expect(ops).toHaveLength(2);
    expect(new Set(ops.map((op) => op.entity))).toEqual(new Set(["A", "A1"]));
  });

  it("indentSelectedBlocks nests a contiguous multi-selection flat under the original previous sibling", () => {
    const [s, b, c] = o(3);
    const t = buildTree(
      makeBlock({ id: "S", order: s as string }),
      makeBlock({ id: "B", order: b as string }),
      makeBlock({ id: "C", order: c as string }),
    );
    const { ops } = indentSelectedBlocks(t, ["B", "C"], makeFakeClock());
    const byEntity = Object.fromEntries(ops.map((op) => [op.entity, op]));
    expect(byEntity.B?.payload).toMatchObject({ kind: "block.place", place: { parentId: "S" } });
    expect(byEntity.C?.payload).toMatchObject({ kind: "block.place", place: { parentId: "S" } });
    if (byEntity.B?.payload.kind === "block.place" && byEntity.C?.payload.kind === "block.place") {
      expect(byEntity.B.payload.place.order < byEntity.C.payload.place.order).toBe(true);
    }
  });

  it("outdentSelectedBlocks: a selected block is never re-parented via another selected block's younger-siblings step (R31)", () => {
    // - A
    //   - B  (selected)
    //   - C  (selected)
    //   - D
    // Expect: B and C both land as A's siblings (root level), in order; D — which followed the
    // WHOLE selected run, not just B — becomes C's child (the last outdented block), not B's.
    const [a] = o(1);
    const [b, c, d] = o(3);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", parentId: "A", order: b as string }),
      makeBlock({ id: "C", parentId: "A", order: c as string }),
      makeBlock({ id: "D", parentId: "A", order: d as string }),
    );
    const { ops } = outdentSelectedBlocks(t, ["B", "C"], makeFakeClock());
    const byEntity = Object.fromEntries(ops.map((op) => [op.entity, op]));
    // Without the R31 exclusion, B's outdent would treat C (its younger sibling) as needing
    // reparenting under B — but C is itself in the selection and must be moved by its OWN row.
    expect(byEntity.C?.payload).toMatchObject({ kind: "block.place", place: { parentId: null } });
    expect(byEntity.B?.payload).toMatchObject({ kind: "block.place", place: { parentId: null } });
    // D (not selected) is the trailing sibling of the whole selected run and lands under C, the
    // LAST block of that run — not under B.
    expect(byEntity.D?.payload).toMatchObject({ kind: "block.place", place: { parentId: "C" } });
    // B and C must both land at the root, in order, not nested in each other.
    if (byEntity.B?.payload.kind === "block.place" && byEntity.C?.payload.kind === "block.place") {
      expect(byEntity.B.payload.place.order < byEntity.C.payload.place.order).toBe(true);
    }
  });
});

// Sanity: childrenIds import is exercised transitively above; keep an explicit smoke test so an
// accidental regression in tree.ts's export surface fails here too, close to its consumer.
describe("commands.ts integrates with tree.ts's childrenIds", () => {
  it("outdent leaves the original tree snapshot untouched (pure function)", () => {
    const [a] = o(1);
    const [b, c] = o(2);
    const t = buildTree(
      makeBlock({ id: "A", order: a as string }),
      makeBlock({ id: "B", parentId: "A", order: b as string }),
      makeBlock({ id: "C", parentId: "A", order: c as string }),
    );
    const { ops } = outdentBlock(t, "B", makeFakeClock()) ?? { ops: [] };
    expect(ops.some((op) => op.entity === "C")).toBe(true);
    expect(childrenIds(t, "A")).toEqual(["B", "C"]); // original tree untouched (pure function)
  });
});
