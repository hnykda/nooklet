/**
 * B-788: zoomed into a block, that block is the fixed top of the view and nothing done in the view
 * lands outside its subtree. Every structural command that can run from a zoomed view, at the zoom
 * root and at its direct children — the two places where "one level up" is outside the view.
 *
 * Each test applies the command's ops the way `BlockTree.commit` does and reads the rows a person
 * would then see (`flattenVisible` with the zoom root), so "inside the view" is checked as what is
 * on screen, not as a guess about op shapes.
 */
import type { Op } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import {
  deleteForwardMerge,
  deleteSelectedBlocks,
  duplicateBlock,
  indentBlock,
  indentSelectedBlocks,
  mergeWithPrevious,
  moveBlock,
  type OpsResult,
  outdentBlock,
  outdentSelectedBlocks,
  splitBlock,
} from "./commands.js";
import { applyOptimistic, type OptimisticOp } from "./optimistic.js";
import { pasteMarkdownAsTree } from "./paste.js";
import { makeBlock, makeFakeClock, orders } from "./test-helpers.js";
import { buildEditorTree, flattenVisible } from "./tree.js";
import type { EditableBlock } from "./types.js";

const ZOOM = { zoomRootId: "R" };

/**
 * - P            (before the root, outside the view)
 * - R            (the zoom root)
 *   - C1
 *   - C2
 * - S            (after the root, outside the view)
 *
 * `leaf: true` drops C1/C2: R is a leaf, the case the owner hit.
 */
function page(opts: { leaf?: boolean; root?: Partial<EditableBlock> } = {}): EditableBlock[] {
  const [o1, o2, o3] = orders(3) as [string, string, string];
  const list = [
    makeBlock({ id: "P", order: o1, content: "before" }),
    makeBlock({ id: "R", order: o2, content: "root text", ...opts.root }),
    makeBlock({ id: "S", order: o3, content: "after" }),
  ];
  if (!opts.leaf) {
    list.push(
      makeBlock({ id: "C1", parentId: "R", order: o1, content: "one" }),
      makeBlock({ id: "C2", parentId: "R", order: o2, content: "two" }),
    );
  }
  return list;
}

/** The zoomed view after `ops`: [id, depth, content] per row. */
function viewAfter(list: EditableBlock[], ops: readonly Op[]): Array<[string, number, string]> {
  const next = applyOptimistic(list, ops as unknown as OptimisticOp[], new Map());
  const t = buildEditorTree("page1", next);
  return flattenVisible(t, { rootBlockId: "R" }).map((r) => [
    r.id,
    r.depth,
    t.byId.get(r.id)?.content ?? "",
  ]);
}

/** The top level of the page after `ops`: the root must still sit between P and S, untouched. */
function topLevelAfter(list: EditableBlock[], ops: readonly Op[]): string[] {
  const next = applyOptimistic(list, ops as unknown as OptimisticOp[], new Map());
  return buildEditorTree("page1", next).childrenOf.get(null) ?? [];
}

function rowsOf(list: EditableBlock[]): string[] {
  return flattenVisible(buildEditorTree("page1", list), { rootBlockId: "R" }).map((r) => r.id);
}

describe("B-788: Enter on the zoom root makes its first child", () => {
  it("at the end of a zoomed LEAF: a new empty first child, visible and focused", () => {
    const list = page({ leaf: true });
    const t = buildEditorTree("page1", list);
    const r = splitBlock(t, "R", "root text".length, makeFakeClock(), 1000, ZOOM);
    const view = viewAfter(list, r.ops);
    expect(view).toEqual([
      ["R", 0, "root text"],
      [r.focus.id, 1, ""],
    ]);
    expect(r.focus.caret).toEqual({ at: "start" });
    expect(topLevelAfter(list, r.ops)).toEqual(["P", "R", "S"]);
  });

  it("at the end of a root WITH children: the new block goes above the existing ones", () => {
    const list = page();
    const t = buildEditorTree("page1", list);
    const r = splitBlock(t, "R", "root text".length, makeFakeClock(), 1000, ZOOM);
    expect(viewAfter(list, r.ops).map(([id]) => id)).toEqual(["R", r.focus.id, "C1", "C2"]);
  });

  it("in the middle: the root keeps the text before the caret, the rest becomes the first child", () => {
    const list = page({ leaf: true });
    const t = buildEditorTree("page1", list);
    const r = splitBlock(t, "R", 4, makeFakeClock(), 1000, ZOOM);
    expect(viewAfter(list, r.ops)).toEqual([
      ["R", 0, "root"],
      [r.focus.id, 1, " text"],
    ]);
  });

  it("on a COLLAPSED root: still its first child, and the view shows it (the root is always open)", () => {
    const list = page({ root: { collapsed: true } });
    const t = buildEditorTree("page1", list);
    const r = splitBlock(t, "R", "root text".length, makeFakeClock(), 1000, ZOOM);
    expect(viewAfter(list, r.ops).map(([id]) => id)).toEqual(["R", r.focus.id, "C1", "C2"]);
  });

  it("in an EMPTY zoomed leaf: the root shows, and Enter makes a visible child", () => {
    const list = page({ leaf: true, root: { content: "" } });
    expect(rowsOf(list)).toEqual(["R"]);
    const t = buildEditorTree("page1", list);
    const r = splitBlock(t, "R", 0, makeFakeClock(), 1000, ZOOM);
    expect(viewAfter(list, r.ops)).toEqual([
      ["R", 0, ""],
      [r.focus.id, 1, ""],
    ]);
  });

  it("a numbered root's first child does not continue the list (it starts its own)", () => {
    const list = page({ leaf: true, root: { properties: { list: "number" } } });
    const t = buildEditorTree("page1", list);
    const r = splitBlock(t, "R", "root text".length, makeFakeClock(), 1000, ZOOM);
    const create = r.ops.find((op) => op.payload.kind === "block.create");
    expect(create?.payload).not.toHaveProperty("properties");
  });

  it("Enter on a direct child is unchanged: its sibling, still inside the root", () => {
    const list = page();
    const t = buildEditorTree("page1", list);
    const r = splitBlock(t, "C2", 3, makeFakeClock(), 1000, ZOOM);
    expect(viewAfter(list, r.ops).map(([id, depth]) => [id, depth])).toEqual([
      ["R", 0],
      ["C1", 1],
      ["C2", 1],
      [r.focus.id, 1],
    ]);
  });

  it("not zoomed, Enter at the end of a leaf is still a sibling (R16 unchanged)", () => {
    const t = buildEditorTree("page1", page({ leaf: true }));
    const r = splitBlock(t, "R", "root text".length, makeFakeClock(), 1000);
    expect(r.ops.at(-1)?.payload).toMatchObject({ place: { parentId: null } });
  });
});

describe("B-788: nothing done in the zoomed view lands outside the zoom root", () => {
  const t = () => buildEditorTree("page1", page());

  it("Tab on the root does nothing (its previous sibling is outside the view)", () => {
    expect(indentBlock(t(), "R", makeFakeClock(), ZOOM)).toBeNull();
  });

  it("Shift+Tab on the root does nothing", () => {
    expect(outdentBlock(t(), "R", makeFakeClock(), ZOOM)).toBeNull();
  });

  it("Shift+Tab on a direct child of the root does nothing (it would land beside the root)", () => {
    expect(outdentBlock(t(), "C1", makeFakeClock(), ZOOM)).toBeNull();
    expect(outdentBlock(t(), "C2", makeFakeClock(), ZOOM)).toBeNull();
  });

  it("Shift+Tab deeper inside the view still works, and stays inside", () => {
    const [o1] = orders(1) as [string];
    const list = [...page(), makeBlock({ id: "G", parentId: "C1", order: o1, content: "g" })];
    const r = outdentBlock(buildEditorTree("page1", list), "G", makeFakeClock(), ZOOM);
    expect(r).not.toBeNull();
    expect(viewAfter(list, (r as OpsResult).ops).map(([id, d]) => [id, d])).toEqual([
      ["R", 0],
      ["C1", 1],
      ["G", 1],
      ["C2", 1],
    ]);
  });

  it("Backspace at the start of the root does not merge it into the block before it", () => {
    const tree = t();
    const rows = rowsOf(page());
    expect(mergeWithPrevious(tree, rows, "R", makeFakeClock(), 1000)).toBeNull();
    // Even an empty leaf root (the case where Backspace would normally delete the block).
    const empty = page({ leaf: true, root: { content: "" } });
    const emptyTree = buildEditorTree("page1", empty);
    expect(mergeWithPrevious(emptyTree, rowsOf(empty), "R", makeFakeClock(), 1000)).toBeNull();
  });

  it("Backspace at the start of the first child merges into the root, inside the view", () => {
    const list = page();
    const r = mergeWithPrevious(
      buildEditorTree("page1", list),
      rowsOf(list),
      "C1",
      makeFakeClock(),
    );
    expect(r && "ops" in r).toBe(true);
    if (r && "ops" in r) {
      expect(viewAfter(list, r.ops)).toEqual([
        ["R", 0, "root textone"],
        ["C2", 1, "two"],
      ]);
    }
  });

  it("Delete at the end of the last visible block does not pull in the block after the root", () => {
    const list = page();
    expect(
      deleteForwardMerge(buildEditorTree("page1", list), rowsOf(list), "C2", makeFakeClock()),
    ).toBeNull();
    const leaf = page({ leaf: true });
    expect(
      deleteForwardMerge(buildEditorTree("page1", leaf), rowsOf(leaf), "R", makeFakeClock()),
    ).toBeNull();
  });

  it("Alt+Up / Alt+Down on the root does nothing (its siblings are outside the view)", () => {
    expect(moveBlock(t(), "R", "up", makeFakeClock(), ZOOM)).toBeNull();
    expect(moveBlock(t(), "R", "down", makeFakeClock(), ZOOM)).toBeNull();
  });

  it("Alt+Up / Alt+Down among the root's children still works", () => {
    const list = page();
    const r = moveBlock(buildEditorTree("page1", list), "C2", "up", makeFakeClock(), ZOOM);
    expect(viewAfter(list, (r as OpsResult).ops).map(([id]) => id)).toEqual(["R", "C2", "C1"]);
  });

  it("Duplicate on the root does nothing (the copy would be its sibling)", () => {
    expect(duplicateBlock(t(), "R", makeFakeClock(), 1000, ZOOM)).toBeNull();
  });

  it("selection: indent / outdent / delete with the root selected leave the root where it is", () => {
    const list = page();
    const tree = buildEditorTree("page1", list);
    const ids = ["R", "C1", "C2"];
    // C2 under C1 is a legitimate indent inside the view; the root itself does not move.
    const ind = indentSelectedBlocks(tree, ids, makeFakeClock(), ZOOM);
    expect(ind.ops.map((op) => op.entity)).toEqual(["C2"]);
    expect(viewAfter(list, ind.ops).map(([id, d]) => [id, d])).toEqual([
      ["R", 0],
      ["C1", 1],
      ["C2", 2],
    ]);
    expect(topLevelAfter(list, ind.ops)).toEqual(["P", "R", "S"]);
    expect(outdentSelectedBlocks(tree, ids, makeFakeClock(), ZOOM).ops).toEqual([]);
    const del = deleteSelectedBlocks(tree, ids, makeFakeClock(), 1000, ZOOM);
    expect(del.ops.map((op) => op.entity).sort()).toEqual(["C1", "C2"]);
    expect(viewAfter(list, del.ops)).toEqual([["R", 0, "root text"]]);
  });

  it("selection: outdenting the root's children does nothing", () => {
    const tree = t();
    expect(outdentSelectedBlocks(tree, ["C1", "C2"], makeFakeClock(), ZOOM).ops).toEqual([]);
  });
});

describe("B-788: multi-line paste on the zoom root goes in as its children", () => {
  it("above the existing children, never as siblings of the root", () => {
    const list = page();
    const r = pasteMarkdownAsTree(
      buildEditorTree("page1", list),
      "R",
      "- x\n  - y\n- z\n",
      makeFakeClock(),
      1000,
      ZOOM,
    );
    expect(viewAfter(list, r.ops).map(([, d, c]) => [d, c])).toEqual([
      [0, "root text"],
      [1, "x"],
      [2, "y"],
      [1, "z"],
      [1, "one"],
      [1, "two"],
    ]);
    expect(topLevelAfter(list, r.ops)).toEqual(["P", "R", "S"]);
  });

  it("into an EMPTY zoomed leaf: the root is kept (not replaced), the blocks go under it", () => {
    const list = page({ leaf: true, root: { content: "" } });
    const r = pasteMarkdownAsTree(
      buildEditorTree("page1", list),
      "R",
      "- x\n- z\n",
      makeFakeClock(),
      1000,
      ZOOM,
    );
    expect(r.ops.some((op) => op.payload.kind === "block.delete")).toBe(false);
    expect(viewAfter(list, r.ops).map(([, d, c]) => [d, c])).toEqual([
      [0, ""],
      [1, "x"],
      [1, "z"],
    ]);
  });
});
