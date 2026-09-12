import { describe, expect, it } from "vitest";
import { linkFirstMention } from "./page-link-unlinked.js";

const aurora = { name: "Aurora", key: "aurora" };
const nested = { name: "Projects/Aurora", key: "projects/aurora" };

describe("linkFirstMention", () => {
  it("wraps the first whole-word mention, keeping the author's own casing", () => {
    expect(linkFirstMention("Talked about aurora today, aurora again", aurora)).toEqual({
      content: "Talked about [[aurora]] today, aurora again",
    });
  });

  it("writes the full name for a namespaced page, since the short name would link elsewhere", () => {
    expect(linkFirstMention("Quoted pricing for the Aurora launch", nested)).toEqual({
      content: "Quoted pricing for the [[Projects/Aurora]] launch",
    });
  });

  it("matches whole words only: punctuation is a boundary, a letter is not", () => {
    expect(linkFirstMention("see aurora-project for details", aurora)).toEqual({
      content: "see [[aurora]]-project for details",
    });
    expect(linkFirstMention("Auroras are pretty", aurora)).toEqual({
      skipped: "no whole-word match",
    });
    // Unicode letters count as word characters: "Aleš" is not a mention of "Ale".
    expect(linkFirstMention("Aleš came by", { name: "Ale", key: "ale" })).toEqual({
      skipped: "no whole-word match",
    });
  });

  it("skips a mention inside inline code, a fence, a tag, a link, a URL or a property line", () => {
    expect(linkFirstMention("run `aurora --help` first", aurora)).toEqual({
      skipped: "inside code",
    });
    expect(linkFirstMention("```\naurora\n```", aurora)).toEqual({ skipped: "inside code" });
    expect(linkFirstMention("tagged #Aurora", aurora)).toEqual({ skipped: "part of a tag" });
    expect(linkFirstMention("[Aurora](https://example.com)", aurora)).toEqual({
      skipped: "inside a link or reference",
    });
    expect(linkFirstMention("https://aurora.example.com/docs", aurora)).toEqual({
      skipped: "part of a URL",
    });
    expect(linkFirstMention("[docs](https://x.y/aurora)", aurora)).toEqual({
      skipped: "part of a URL",
    });
    expect(linkFirstMention("project:: Aurora", aurora)).toEqual({
      skipped: "on a property line",
    });
    expect(linkFirstMention("{{embed Aurora}}", aurora)).toEqual({
      skipped: "inside a link or reference",
    });
  });

  it("links the first SAFE mention when an earlier one is unsafe", () => {
    expect(linkFirstMention("`aurora` is the codename; aurora ships Monday", aurora)).toEqual({
      content: "`aurora` is the codename; [[aurora]] ships Monday",
    });
  });

  it("finds a mention on a continuation line, not only the first line", () => {
    expect(linkFirstMention("first line\nmentions Aurora here", aurora)).toEqual({
      content: "first line\nmentions [[Aurora]] here",
    });
  });

  it("escapes regex metacharacters in the page name", () => {
    expect(linkFirstMention("read C++ (the book)", { name: "C++", key: "c++" })).toEqual({
      content: "read [[C++]] (the book)",
    });
  });
});
