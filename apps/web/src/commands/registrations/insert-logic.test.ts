import { describe, expect, it } from "vitest";
import {
  embedBlock,
  embedPage,
  insertCodeFence,
  insertProperty,
  insertTable,
  insertToday,
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
  });
});
