import { describe, expect, it } from "vitest";
import { filterVisible, findRanges, foldForFind } from "./pageFilter.js";
import { tree as buildTree, makeBlock } from "./test-helpers.js";

/**
 * A        "Zahrada"
 *   A1     "řeka a most"
 *   A2     "nothing"
 * B        "collapsed parent" (collapsed)
 *   B1     "Reka under a collapsed block"
 *     B1a  "deep child"
 * C        "unrelated"
 */
function sample() {
  return buildTree(
    makeBlock({ id: "A", order: "a0", content: "Zahrada" }),
    makeBlock({ id: "A1", parentId: "A", order: "a0", content: "řeka a most" }),
    makeBlock({ id: "A2", parentId: "A", order: "a1", content: "nothing" }),
    makeBlock({ id: "B", order: "a1", content: "collapsed parent", collapsed: true }),
    makeBlock({ id: "B1", parentId: "B", order: "a0", content: "Reka under a collapsed block" }),
    makeBlock({ id: "B1a", parentId: "B1", order: "a0", content: "deep child" }),
    makeBlock({ id: "C", order: "a2", content: "unrelated" }),
  );
}

describe("foldForFind", () => {
  it("ignores case and diacritics", () => {
    expect(foldForFind("Řeka ŽLUŤOUČKÝ kůň")).toBe("reka zlutoucky kun");
    expect(foldForFind("İstanbul")).toBe("istanbul");
  });
});

describe("filterVisible", () => {
  it("is null for an empty or blank query, so the outline is shown unfiltered", () => {
    expect(filterVisible(sample(), "")).toBeNull();
    expect(filterVisible(sample(), "   ")).toBeNull();
  });

  it("shows matches with their ancestors, including matches under a collapsed block", () => {
    const r = filterVisible(sample(), "reka");
    expect(r?.matches).toEqual(["A1", "B1"]);
    expect(r?.rows.map((row) => [row.id, row.depth])).toEqual([
      ["A", 0],
      ["A1", 1],
      ["B", 0],
      ["B1", 1],
    ]);
    // The row keeps its real collapsed flag: the filter never pretends the block was expanded.
    expect(r?.rows.find((row) => row.id === "B")?.collapsed).toBe(true);
    expect(r?.rows.find((row) => row.id === "B1")?.hasChildren).toBe(true);
  });

  it("does not show a match's non-matching children", () => {
    const r = filterVisible(sample(), "collapsed");
    expect(r?.matches).toEqual(["B", "B1"]);
    expect(r?.rows.map((row) => row.id)).toEqual(["B", "B1"]);
  });

  it("matches the stored text, markup included, case- and diacritic-insensitively", () => {
    const t = buildTree(
      makeBlock({ id: "L", order: "a0", content: "see [[Zahrada]]" }),
      makeBlock({ id: "M", order: "a1", content: "ZAHRÁDKA" }),
    );
    expect(filterVisible(t, "[[zah")?.matches).toEqual(["L"]);
    expect(filterVisible(t, "zahra")?.matches).toEqual(["L", "M"]);
  });

  it("returns no rows and no matches when nothing matches", () => {
    expect(filterVisible(sample(), "xyzzy")).toEqual({ rows: [], matches: [] });
  });

  it("keeps the block being edited visible, with its ancestors, without calling it a match", () => {
    const r = filterVisible(sample(), "most", { keep: "B1a" });
    expect(r?.matches).toEqual(["A1"]);
    expect(r?.rows.map((row) => row.id)).toEqual(["A", "A1", "B", "B1", "B1a"]);
  });

  it("searches only the zoom root's subtree, root included", () => {
    const r = filterVisible(sample(), "a", { rootBlockId: "B1" });
    expect(r?.matches).toEqual(["B1"]);
    expect(r?.rows.map((row) => [row.id, row.depth])).toEqual([["B1", 0]]);
    expect(filterVisible(sample(), "a", { rootBlockId: "missing" })).toEqual({
      rows: [],
      matches: [],
    });
  });
});

describe("findRanges", () => {
  it("finds every non-overlapping occurrence, folded", () => {
    expect(findRanges("Řeka, reka, REKA", "reka")).toEqual([
      [0, 4],
      [6, 10],
      [12, 16],
    ]);
    expect(findRanges("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("maps back to original offsets where folding changed the length", () => {
    // "e" + COMBINING ACUTE ACCENT: two code units in the text, one after folding.
    const text = "cafe\u0301 bar";
    expect(text).toHaveLength(9);
    expect(findRanges(text, "caf\u00e9")).toEqual([[0, 5]]);
    // The mark folds away, and the highlight of "e" still covers it.
    expect(findRanges(text, "e")).toEqual([[3, 5]]);
    expect(findRanges(text, "bar")).toEqual([[6, 9]]);
  });

  it("handles characters outside the BMP", () => {
    expect(findRanges("🌱 řeka", "reka")).toEqual([[3, 7]]);
  });

  it("is empty for a blank query or no match", () => {
    expect(findRanges("anything", " ")).toEqual([]);
    expect(findRanges("anything", "zzz")).toEqual([]);
  });
});
