import { describe, expect, it } from "vitest";
import { rowSurvivesCollapseAll, setAllCollapsedOps } from "./collapse-all.js";
import { applyOptimistic, type OptimisticOp } from "./optimistic.js";
import { tree as buildTree, makeBlock, makeFakeClock, orders } from "./test-helpers.js";
import { buildEditorTree, flattenVisible } from "./tree.js";
import type { EditableBlock } from "./types.js";

/**
 * - A
 *   - A1
 *     - A1a
 *   - A2
 * - B
 *   - B1
 * - C
 */
function blocks(overrides: Partial<Record<string, Partial<EditableBlock>>> = {}): EditableBlock[] {
  const [o1, o2, o3] = orders(3) as [string, string, string];
  const spec: Array<[string, string | null, string]> = [
    ["A", null, o1],
    ["A1", "A", o1],
    ["A1a", "A1", o1],
    ["A2", "A", o2],
    ["B", null, o2],
    ["B1", "B", o1],
    ["C", null, o3],
  ];
  return spec.map(([id, parentId, order]) =>
    makeBlock({ id, parentId, order, content: id, ...overrides[id] }),
  );
}

function collapsedIds(ops: ReturnType<typeof setAllCollapsedOps>): Array<[string, string]> {
  return ops.map((op) => {
    const payload = op.payload as { kind: string; key: string; value: string };
    expect(payload).toMatchObject({ kind: "block.prop", key: "collapsed" });
    return [op.entity, payload.value];
  });
}

/** Apply the ops the way `BlockTree.commit` does and read the rows a person would see. */
function visibleAfter(
  list: EditableBlock[],
  ops: ReturnType<typeof setAllCollapsedOps>,
  root?: string,
) {
  const next = applyOptimistic(list, ops as unknown as OptimisticOp[], new Map());
  return flattenVisible(buildEditorTree("page1", next), { rootBlockId: root }).map((r) => r.id);
}

describe("setAllCollapsedOps — Collapse all / Expand all (R26, B-97)", () => {
  it("collapse all on the page: one op per block with children, leaves untouched", () => {
    const list = blocks();
    const ops = setAllCollapsedOps(buildTree(...list), undefined, true, makeFakeClock());
    expect(collapsedIds(ops)).toEqual([
      ["A", "true"],
      ["A1", "true"],
      ["B", "true"],
    ]);
    expect(visibleAfter(list, ops)).toEqual(["A", "B", "C"]);
  });

  it("skips blocks already in the target state, so a second run writes nothing", () => {
    const list = blocks({ A1: { collapsed: true } });
    const ops = setAllCollapsedOps(buildTree(...list), undefined, true, makeFakeClock());
    expect(collapsedIds(ops)).toEqual([
      ["A", "true"],
      ["B", "true"],
    ]);
    const all = blocks({ A: { collapsed: true }, A1: { collapsed: true }, B: { collapsed: true } });
    expect(setAllCollapsedOps(buildTree(...all), undefined, true, makeFakeClock())).toEqual([]);
  });

  it("expand all opens every collapsed block with children, including ones hidden inside others", () => {
    const list = blocks({ A: { collapsed: true }, A1: { collapsed: true } });
    const ops = setAllCollapsedOps(buildTree(...list), undefined, false, makeFakeClock());
    expect(collapsedIds(ops)).toEqual([
      ["A", "false"],
      ["A1", "false"],
    ]);
    expect(visibleAfter(list, ops)).toEqual(["A", "A1", "A1a", "A2", "B", "B1", "C"]);
  });

  it("zoomed: collapse all folds the zoom root's descendants and leaves the root and the rest of the page alone", () => {
    const list = blocks();
    const ops = setAllCollapsedOps(buildTree(...list), "A", true, makeFakeClock());
    expect(collapsedIds(ops)).toEqual([["A1", "true"]]);
    expect(visibleAfter(list, ops, "A")).toEqual(["A", "A1", "A2"]);
  });

  it("zoomed: expand all opens the root too, and nothing outside it", () => {
    const list = blocks({
      A: { collapsed: true },
      A1: { collapsed: true },
      B: { collapsed: true },
    });
    const ops = setAllCollapsedOps(buildTree(...list), "A", false, makeFakeClock());
    expect(collapsedIds(ops)).toEqual([
      ["A", "false"],
      ["A1", "false"],
    ]);
    expect(visibleAfter(list, ops, "A")).toEqual(["A", "A1", "A1a", "A2"]);
  });

  it("a zoom root that is not in the tree scopes to nothing, never to the whole page", () => {
    expect(setAllCollapsedOps(buildTree(...blocks()), "gone", true, makeFakeClock())).toEqual([]);
  });
});

describe("rowSurvivesCollapseAll", () => {
  it("only the first level survives: top-level blocks on a page, the root and its children when zoomed", () => {
    const t = buildTree(...blocks());
    expect(
      ["A", "A1", "A1a", "B", "B1", "C"].filter((id) => rowSurvivesCollapseAll(t, undefined, id)),
    ).toEqual(["A", "B", "C"]);
    expect(["A", "A1", "A1a", "A2"].filter((id) => rowSurvivesCollapseAll(t, "A", id))).toEqual([
      "A",
      "A1",
      "A2",
    ]);
  });
});
