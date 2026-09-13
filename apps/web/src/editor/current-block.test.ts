import { describe, expect, it } from "vitest";
import type { BlockTreeNode } from "../data/types.js";
import { findTreeNode, toCoreBlock } from "./current-block.js";
import { makeBlock } from "./test-helpers.js";

describe("toCoreBlock — the edited block as a plugin sees it (B-344)", () => {
  it("takes content and property lines from the live buffer, not the last flush", () => {
    const block = makeBlock({ id: "b1", parentId: "p1", order: "a3", content: "old" });
    const out = toCoreBlock(block, "page1", "after text \nowner:: dan", {
      createdAt: 10,
      updatedAt: 20,
    });
    expect(out).toEqual({
      id: "b1",
      pageId: "page1",
      parentId: "p1",
      order: "a3",
      content: "after text ",
      marker: null,
      priority: null,
      properties: { owner: "dan" },
      collapsed: false,
      createdAt: 10,
      updatedAt: 20,
    });
  });

  it("folds the reserved scheduling fields into properties, as loadBlock does (ADR 011)", () => {
    const block = makeBlock({
      id: "b1",
      content: "task",
      marker: "DONE",
      priority: "A",
      scheduled: "2026-09-13",
      deadline: "2026-09-20 10:00",
      repeat: "1w",
      doneAt: Date.UTC(2026, 8, 13, 8, 0, 0),
    });
    const out = toCoreBlock(block, "page1", "task", undefined, 99);
    expect(out.marker).toBe("DONE");
    expect(out.priority).toBe("A");
    expect(out.properties).toEqual({
      scheduled: "2026-09-13",
      deadline: "2026-09-20 10:00",
      repeat: "1w",
      done: "2026-09-13T08:00:00Z",
    });
    // Not in the fetched tree yet (created moments ago): stamped with now.
    expect([out.createdAt, out.updatedAt]).toEqual([99, 99]);
  });
});

describe("findTreeNode", () => {
  it("finds a nested node by id, or nothing", () => {
    const node = (id: string, children: BlockTreeNode[] = []) =>
      ({ id, children }) as unknown as BlockTreeNode;
    const tree = [node("a", [node("b", [node("c")])]), node("d")];
    expect(findTreeNode(tree, "c")?.id).toBe("c");
    expect(findTreeNode(tree, "d")?.id).toBe("d");
    expect(findTreeNode(tree, "zz")).toBeUndefined();
  });
});
