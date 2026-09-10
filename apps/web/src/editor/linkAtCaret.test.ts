import { describe, expect, it } from "vitest";
import { linkAtCaret } from "./linkAtCaret.js";

describe("linkAtCaret", () => {
  const content = "see [[Projects/Aurora]] and #urgent plus https://example.com/x now";

  it("finds a wikilink when the caret is inside it", () => {
    const at = content.indexOf("Aurora");
    expect(linkAtCaret(content, at)).toEqual({ type: "page", name: "Projects/Aurora" });
  });

  it("finds a tag", () => {
    expect(linkAtCaret(content, content.indexOf("urgent"))).toEqual({
      type: "tag",
      name: "urgent",
    });
  });

  it("finds a bare url", () => {
    expect(linkAtCaret(content, content.indexOf("example"))).toEqual({
      type: "url",
      href: "https://example.com/x",
    });
  });

  it("returns null in plain text between links", () => {
    expect(linkAtCaret(content, content.indexOf("and") + 1)).toBeNull();
  });

  it("counts a caret at either edge of a link as inside it", () => {
    const start = content.indexOf("[[");
    const end = content.indexOf("]]") + 2;
    expect(linkAtCaret(content, start)).toEqual({ type: "page", name: "Projects/Aurora" });
    expect(linkAtCaret(content, end)).toEqual({ type: "page", name: "Projects/Aurora" });
  });

  it("prefers the innermost link when one is nested inside emphasis", () => {
    const c = "**bold with [[Inner Page]] inside**";
    expect(linkAtCaret(c, c.indexOf("Inner"))).toEqual({ type: "page", name: "Inner Page" });
  });

  it("resolves a markdown link's href, not its label text", () => {
    const c = "click [the docs](https://docs.example.com) here";
    expect(linkAtCaret(c, c.indexOf("docs]"))).toEqual({
      type: "url",
      href: "https://docs.example.com",
    });
  });

  it("handles empty content and out-of-range offsets without throwing", () => {
    expect(linkAtCaret("", 0)).toBeNull();
    expect(linkAtCaret(content, 9999)).toBeNull();
  });
});
