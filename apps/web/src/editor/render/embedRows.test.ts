import { describe, expect, it } from "vitest";
import { type EmbedNode, embedReachesPath, visibleEmbedRows } from "./embedRows.js";

const n = (id: string, children: EmbedNode[] = [], collapsed = false): EmbedNode => ({
  id,
  collapsed,
  children,
});

const storedCollapse = (node: EmbedNode, isRoot: boolean): boolean => isRoot || !node.collapsed;

describe("visibleEmbedRows", () => {
  it("lists rows in reading order with their depth", () => {
    const tree = [n("a", [n("a1", [n("a11")]), n("a2")]), n("b")];
    const rows = visibleEmbedRows(tree, () => true);
    expect(rows.ids).toEqual(["a", "a1", "a11", "a2", "b"]);
    expect([...rows.depth.entries()]).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a11", 2],
      ["a2", 1],
      ["b", 0],
    ]);
    expect(rows.hidden).toBe(0);
  });

  it("a collapsed root still shows its children; a collapsed descendant does not", () => {
    // The owner's embeds point at blocks collapsed on their original day — the embed is the view
    // that is meant to be open.
    const tree = [n("root", [n("kid", [n("grandkid")], true), n("kid2")], true)];
    expect(visibleEmbedRows(tree, storedCollapse).ids).toEqual(["root", "kid", "kid2"]);
  });

  it("counts visible rows past the cap as hidden", () => {
    const tree = [n("a", [n("b"), n("c", [n("d")])]), n("e")];
    const rows = visibleEmbedRows(tree, () => true, 3);
    expect(rows.ids).toEqual(["a", "b", "c"]);
    expect(rows.hidden).toBe(2);
    expect(rows.depth.has("d")).toBe(false);
  });
});

describe("embedReachesPath", () => {
  const tree = [n("x", [n("y", [n("z")], true)])];

  it("is false with no path, or when no path block is in the tree", () => {
    expect(embedReachesPath(tree, [])).toBe(false);
    expect(embedReachesPath(tree, ["host", "other"])).toBe(false);
  });

  it("is true for the root (a block embedding itself) and for a collapsed descendant", () => {
    expect(embedReachesPath(tree, ["x"])).toBe(true);
    expect(embedReachesPath(tree, ["host", "z"])).toBe(true);
  });
});
