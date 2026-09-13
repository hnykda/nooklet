import { describe, expect, it } from "vitest";
import type { BlockTreeNode } from "../data/types.js";
import {
  breadcrumbLabel,
  foldNestedReferences,
  type LoadedReferenceTrees,
  referenceParents,
  visibleParents,
} from "./referenceNesting.js";

function node(id: string, content: string): BlockTreeNode {
  return { id, content, children: [], collapsed: false } as unknown as BlockTreeNode;
}

/** Journal day J: `ctx` > `ref` > `child` > `grand`; `other` top-level. `ctx` links nothing. */
function trees(requested = ["ref", "child", "grand", "other"]): LoadedReferenceTrees {
  return {
    status: "ok",
    requested: new Set(requested),
    ancestors: new Map([
      ["ref", ["ctx"]],
      ["child", ["ref", "ctx"]],
      ["grand", ["child", "ref", "ctx"]],
      ["other", []],
    ]),
    nodes: new Map([
      ["ref", node("ref", "about [[T]]")],
      ["child", node("child", "child line\nsecond line")],
      ["grand", node("grand", "grand")],
      ["other", node("other", "other [[T]]")],
    ]),
    ancestorText: new Map([["ctx", "Project notes"]]),
  };
}

const ref = (id: string) => ({ id, page: "J", text: id });

describe("foldNestedReferences", () => {
  it("lists only references no other listed reference contains", () => {
    const groups = [{ page: "J", refs: [ref("grand"), ref("ref"), ref("child"), ref("other")] }];
    expect(foldNestedReferences(groups, trees())[0]?.refs.map((r) => r.id)).toEqual([
      "ref",
      "other",
    ]);
  });

  it("a reference whose containing references the filter removed becomes a row again", () => {
    const filtered = [{ page: "J", refs: [ref("grand"), ref("other")] }];
    expect(foldNestedReferences(filtered, trees())[0]?.refs.map((r) => r.id)).toEqual([
      "grand",
      "other",
    ]);
  });

  it("holds back an id the trees were not asked about yet; keeps one the replica lacks", () => {
    const t = trees(["ref", "other", "missing"]);
    const groups = [{ page: "J", refs: [ref("ref"), ref("new"), ref("missing")] }];
    expect(foldNestedReferences(groups, t)[0]?.refs.map((r) => r.id)).toEqual(["ref", "missing"]);
  });

  it("without trees (a failed read) every reference stays a row", () => {
    const groups = [{ page: "J", refs: [ref("ref"), ref("child")] }];
    expect(foldNestedReferences(groups, undefined)).toEqual(groups);
  });

  it("drops a group left with nothing to show, keeps the others as they were", () => {
    const a = { page: "A", refs: [ref("new")] };
    const b = { page: "B", refs: [ref("other")] };
    const out = foldNestedReferences([a, b], trees());
    expect(out).toEqual([b]);
    expect(out[0]).toBe(b);
  });
});

describe("referenceParents / visibleParents", () => {
  it("outermost first, text from read nodes or from the ancestor text", () => {
    expect(referenceParents("grand", trees())).toEqual([
      { id: "ctx", content: "Project notes" },
      { id: "ref", content: "about [[T]]" },
      { id: "child", content: "child line\nsecond line" },
    ]);
    expect(referenceParents("other", trees())).toEqual([]);
    expect(referenceParents("unknown", trees())).toEqual([]);
    expect(referenceParents("ref", undefined)).toEqual([]);
  });

  it("leaves out a breadcrumb identical to the row above's, not a different one", () => {
    const base = trees();
    const t = { ...base, ancestors: new Map([...base.ancestors, ["sibling", ["ctx"]]]) };
    expect(visibleParents("sibling", "ref", t)).toEqual([]);
    expect(visibleParents("sibling", undefined, t)).toEqual([
      { id: "ctx", content: "Project notes" },
    ]);
    expect(visibleParents("child", "sibling", t)).toHaveLength(2);
  });
});

describe("breadcrumbLabel", () => {
  it("is the first non-blank line, trimmed", () => {
    expect(breadcrumbLabel("child line\nsecond line")).toBe("child line");
    expect(breadcrumbLabel("\n  \n  indented start \nmore")).toBe("indented start");
    expect(breadcrumbLabel("")).toBe("(empty)");
  });

  it("drops a heading's #s and skips lines that render as nothing inline (B-552)", () => {
    expect(breadcrumbLabel("## 🔖 Articles")).toBe("🔖 Articles");
    expect(breadcrumbLabel("###### [[Page]] heading\nbody")).toBe("[[Page]] heading");
    expect(breadcrumbLabel("```python\nprint(1)\n```")).toBe("print(1)");
    expect(breadcrumbLabel("~~~\n\n~~~")).toBe("(empty)");
    expect(breadcrumbLabel("---\nafter the rule")).toBe("after the rule");
    // Not headings: a tag, and seven #s.
    expect(breadcrumbLabel("#tag and text")).toBe("#tag and text");
    expect(breadcrumbLabel("####### seven")).toBe("####### seven");
  });
});
