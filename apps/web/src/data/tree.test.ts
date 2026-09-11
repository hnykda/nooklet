import type { BlockRow } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { buildBlockTree } from "./tree.js";

function block(
  overrides: Partial<BlockRow> & Pick<BlockRow, "id" | "parentId" | "order">,
): BlockRow {
  return {
    graphId: "default",
    pageId: "page1",
    content: "",
    marker: null,
    priority: null,
    collapsed: false,
    scheduledDay: null,
    scheduledTime: null,
    deadlineDay: null,
    deadlineTime: null,
    repeat: null,
    doneAt: null,
    dueDay: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    placeHlc: "2026-09-10T00:00:00.000Z-0000-aaaaaaaa",
    contentHlc: "2026-09-10T00:00:00.000Z-0000-aaaaaaaa",
    markerHlc: null,
    priorityHlc: null,
    collapsedHlc: null,
    scheduledHlc: null,
    deadlineHlc: null,
    repeatHlc: null,
    doneHlc: null,
    deletedHlc: null,
    ...overrides,
  };
}

describe("buildBlockTree", () => {
  it("nests children under their parent, sorted by order", () => {
    const rows = [
      block({ id: "b2", parentId: null, order: "b" }),
      block({ id: "b1", parentId: null, order: "a" }),
      block({ id: "c1", parentId: "b1", order: "a", content: "child of b1" }),
    ];
    const tree = buildBlockTree(rows);
    expect(tree.map((n) => n.id)).toEqual(["b1", "b2"]);
    expect(tree[0]?.children.map((n) => n.id)).toEqual(["c1"]);
    expect(tree[1]?.children).toEqual([]);
  });

  it("orders correctly regardless of input array order", () => {
    const rows = [
      block({ id: "b3", parentId: null, order: "c" }),
      block({ id: "b1", parentId: null, order: "a" }),
      block({ id: "b2", parentId: null, order: "b" }),
    ];
    expect(buildBlockTree(rows).map((n) => n.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("breaks ties on equal order keys by block id (concurrent same-position inserts)", () => {
    const rows = [
      block({ id: "b2", parentId: null, order: "a" }),
      block({ id: "b1", parentId: null, order: "a" }),
    ];
    expect(buildBlockTree(rows).map((n) => n.id)).toEqual(["b1", "b2"]);
  });

  it("supports arbitrary nesting depth", () => {
    const rows = [
      block({ id: "root", parentId: null, order: "a" }),
      block({ id: "mid", parentId: "root", order: "a" }),
      block({ id: "leaf", parentId: "mid", order: "a" }),
    ];
    const tree = buildBlockTree(rows);
    expect(tree[0]?.children[0]?.children[0]?.id).toBe("leaf");
  });

  it("returns an empty tree for no rows, and ignores rows under a different root", () => {
    expect(buildBlockTree([])).toEqual([]);
    const rows = [block({ id: "other-page-root", parentId: "not-a-root-here", order: "a" })];
    expect(buildBlockTree(rows, null)).toEqual([]);
  });

  it("can build a subtree rooted at an arbitrary block id (zoom-into-block seam)", () => {
    const rows = [
      block({ id: "root", parentId: null, order: "a" }),
      block({ id: "mid", parentId: "root", order: "a" }),
      block({ id: "leaf", parentId: "mid", order: "a" }),
    ];
    const zoomed = buildBlockTree(rows, "mid");
    expect(zoomed.map((n) => n.id)).toEqual(["leaf"]);
  });
});
