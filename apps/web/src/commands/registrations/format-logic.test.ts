import { describe, expect, it } from "vitest";
import { buildLinkInsertion, toggleWrap } from "./format-logic.js";

describe("toggleWrap — wrapping a selection (R45)", () => {
  it("wraps the selection in the marker pair", () => {
    const result = toggleWrap("hello world", 0, 5, "**");
    expect(result).toEqual({
      from: 0,
      to: 5,
      text: "**hello**",
      caretOffset: { anchor: 2, head: 7 },
    });
  });

  it("unwraps when the selection is already wrapped in the exact marker pair", () => {
    const result = toggleWrap("**hello** world", 2, 7, "**");
    expect(result).toEqual({ from: 0, to: 9, text: "hello", caretOffset: { anchor: 0, head: 5 } });
  });

  it("supports asymmetric open/close markers (format.insertLink-style)", () => {
    const result = toggleWrap("[hi]", 1, 3, "[", "]");
    expect(result.text).toBe("hi");
  });

  it("does not unwrap when only one side matches (not an exact pair)", () => {
    const result = toggleWrap("**hello* world", 2, 7, "**");
    expect(result.text).toBe("**hello**");
  });
});

describe("toggleWrap — collapsed caret (R45 type-ahead)", () => {
  it("inserts an empty pair with the caret between the markers", () => {
    const result = toggleWrap("hello", 5, 5, "**");
    expect(result).toEqual({ from: 5, to: 5, text: "****", caretOffset: 2 });
  });

  it("removes an already-empty pair straddling the caret", () => {
    const result = toggleWrap("****", 2, 2, "**");
    expect(result).toEqual({ from: 0, to: 4, text: "", caretOffset: 0 });
  });
});

describe("toggleWrap — every marker pair from the spec table (R45)", () => {
  it.each([
    ["**", "**"],
    ["*", "*"],
    ["~~", "~~"],
    ["==", "=="],
    ["`", "`"],
  ])("wraps with %s...%s", (open, close) => {
    const result = toggleWrap("word", 0, 4, open, close);
    expect(result.text).toBe(`${open}word${close}`);
  });
});

describe("buildLinkInsertion (R46)", () => {
  it("wraps a selection as [selected text](), caret inside the parens", () => {
    const result = buildLinkInsertion("see nooklet docs", 4, 11);
    expect(result).toEqual({ from: 4, to: 11, text: "[nooklet]()", caretOffset: 10 });
  });

  it("inserts []() with the caret inside the brackets when there is no selection", () => {
    const result = buildLinkInsertion("hello", 5, 5);
    expect(result).toEqual({ from: 5, to: 5, text: "[]()", caretOffset: 1 });
  });
});
