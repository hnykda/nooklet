import { describe, expect, it } from "vitest";
import {
  embedBlock,
  embedPage,
  insertCodeFence,
  insertProperty,
  insertQueryFence,
  insertSlash,
  insertTable,
  insertToday,
  onContent,
  setHeading,
} from "./insert-logic.js";

describe("setHeading (R48)", () => {
  it("prefixes plain content with the heading marker", () => {
    expect(setHeading("Hello", 1)).toEqual({ from: 0, to: 5, text: "# Hello", caretOffset: 7 });
    expect(setHeading("Hello", 2)).toEqual({ from: 0, to: 5, text: "## Hello", caretOffset: 8 });
    expect(setHeading("Hello", 3)).toEqual({ from: 0, to: 5, text: "### Hello", caretOffset: 9 });
  });

  it("replaces an existing heading marker instead of stacking", () => {
    expect(setHeading("# Hello", 2)).toEqual({ from: 0, to: 7, text: "## Hello", caretOffset: 8 });
    expect(setHeading("### Hello", 1)).toEqual({ from: 0, to: 9, text: "# Hello", caretOffset: 7 });
  });
});

describe("insertCodeFence (R48)", () => {
  it("inserts an empty skeleton with the caret on the blank middle line when the block is empty", () => {
    expect(insertCodeFence("")).toEqual({ from: 0, to: 0, text: "```\n\n```", caretOffset: 4 });
  });

  it("wraps existing content in a fence", () => {
    const result = insertCodeFence("const x = 1;");
    expect(result.text).toBe("```\nconst x = 1;\n```");
  });
});

describe("insertTable (R48)", () => {
  it("inserts a 2x2 GFM table skeleton", () => {
    const result = insertTable();
    expect(result.text).toBe("| Column 1 | Column 2 |\n| --- | --- |\n|  |  |");
  });
});

describe("embedPage / embedBlock (R49)", () => {
  it("pre-fills the query and places the caret right after it", () => {
    expect(embedPage(0, 0, "Recipes")).toEqual({
      from: 0,
      to: 0,
      text: "{{embed [[Recipes]]}}",
      caretOffset: "{{embed [[Recipes".length,
    });
  });

  it("defaults to an empty query", () => {
    expect(embedBlock(0, 0)).toEqual({
      from: 0,
      to: 0,
      text: "{{embed (())}}",
      caretOffset: "{{embed ((".length,
    });
  });
});

describe("insertToday (R49)", () => {
  it("inserts a wikilink to the given journal title", () => {
    const result = insertToday(0, 0, "Sep 10th, 2026");
    expect(result.text).toBe("[[Sep 10th, 2026]]");
  });
});

describe("insertProperty (R49)", () => {
  const apply = (content: string, key?: string) => {
    const r = insertProperty(content, key);
    const text = content.slice(0, r.from) + r.text + content.slice(r.to);
    return { text, caret: r.from + (r.caretOffset as number) };
  };

  it("appends key:: on a new line when the block already has content", () => {
    const result = insertProperty("Some text", "status");
    expect(result.text).toBe("\nstatus:: ");
    expect(result.from).toBe(9);
  });

  it("does not add a leading newline for an empty block", () => {
    const result = insertProperty("", "status");
    expect(result.text).toBe("status:: ");
  });

  it("does not double a trailing newline", () => {
    const result = insertProperty("line1\n", "status");
    expect(result.text).toBe("status:: ");
    expect(result.from).toBe(6);
  });

  it("goes under line 1 and the properties already there, not below the paragraph (B-101)", () => {
    expect(apply("title\na:: 1\nbody text", "b").text).toBe("title\na:: 1\nb:: \nbody text");
  });

  it("goes after a fence a block opens with, never inside it", () => {
    expect(apply("```js\ncode\n```", "lang").text).toBe("```js\ncode\n```\nlang:: ");
  });

  it("with no key, leaves `:: ` and the caret where the key is typed", () => {
    const { text, caret } = apply("start here");
    expect(text).toBe("start here\n:: ");
    expect(text.slice(caret)).toBe(":: ");
  });
});

describe("insertQueryFence (M7, ADR 011)", () => {
  it("inserts an empty query skeleton with the caret on the query line", () => {
    expect(insertQueryFence("")).toEqual({
      from: 0,
      to: 0,
      text: "```query\n\n```",
      caretOffset: "```query\n".length,
    });
  });

  it("turns the block's existing text into the query, caret at its end", () => {
    const r = insertQueryFence("TODO #work ");
    expect(r.text).toBe("```query\nTODO #work\n```");
    expect(r).toMatchObject({ from: 0, to: 11, caretOffset: "```query\nTODO #work".length });
  });
});

describe("onContent (B-153): whole-block commands leave property lines alone", () => {
  const apply = (text: string, spec: ReturnType<typeof onContent>) => {
    const out = text.slice(0, spec.from) + spec.text + text.slice(spec.to);
    return { text: out, caret: spec.from + (spec.caretOffset as number) };
  };

  it("/code wraps the text, and the numbering stays a property after the fence", () => {
    const text = "npm install\nlist:: number";
    const { text: out, caret } = apply(text, onContent(text, insertCodeFence));
    expect(out).toBe("```\nnpm install\n```\nlist:: number");
    expect(out.slice(0, caret)).toBe("```\nnpm install\n```");
  });

  it("/code in an empty numbered item puts the caret on the fence's middle line", () => {
    const text = "\nlist:: number";
    const { text: out, caret } = apply(text, onContent(text, insertCodeFence));
    expect(out).toBe("```\n\n```\nlist:: number");
    expect(caret).toBe(4);
  });

  it("/query takes only the text as the query", () => {
    const text = "TODO #work\nowner:: Dan";
    const { text: out, caret } = apply(text, onContent(text, insertQueryFence));
    expect(out).toBe("```query\nTODO #work\n```\nowner:: Dan");
    expect(out.slice(0, caret)).toBe("```query\nTODO #work");
  });

  it("/h1 leaves the caret at the end of the title, not of the last property line", () => {
    const text = "Title\nlist:: number\nbody";
    const { text: out, caret } = apply(
      text,
      onContent(text, (c) => setHeading(c, 1)),
    );
    expect(out).toBe("# Title\nlist:: number\nbody");
    expect(out.slice(caret)).toBe("");
    // Content-wise the caret is at the end of the content, which is the end of `body`.
    const single = "Title\nlist:: number";
    const r = apply(
      single,
      onContent(single, (c) => setHeading(c, 1)),
    );
    expect(r.text).toBe("# Title\nlist:: number");
    expect(r.text.slice(0, r.caret)).toBe("# Title");
  });

  it("is the command itself for a block without properties", () => {
    expect(onContent("plain", insertCodeFence)).toEqual(insertCodeFence("plain"));
  });
});

describe("insertSlash (R50, B-646)", () => {
  it("types a bare `/` at the block's start and after whitespace", () => {
    expect(insertSlash("", 0, 0)).toEqual({ from: 0, to: 0, text: "/", caretOffset: 1 });
    expect(insertSlash("ab ", 3, 3)).toEqual({ from: 3, to: 3, text: "/", caretOffset: 1 });
    expect(insertSlash("ab\ncd", 3, 3)).toEqual({ from: 3, to: 3, text: "/", caretOffset: 1 });
  });

  it("puts a space before it mid-word, where a bare `/` would not open the menu", () => {
    expect(insertSlash("abc", 3, 3)).toEqual({ from: 3, to: 3, text: " /", caretOffset: 2 });
    expect(insertSlash("abc def", 1, 2)).toEqual({ from: 1, to: 2, text: " /", caretOffset: 2 });
  });
});
