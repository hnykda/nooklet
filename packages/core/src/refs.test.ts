import { describe, expect, it } from "vitest";
import { extractRefs, splitList } from "./refs.js";

describe("extractRefs", () => {
  it("finds page refs, tags and block refs", () => {
    const r = extractRefs(
      "See [[Page One]] and #tag and ((64f1a2b3-0000-4000-8000-000000000001)) #[[multi word]]",
    );
    expect(r.pageRefs).toEqual(["Page One"]);
    expect(r.tags).toEqual(["tag", "multi word"]);
    expect(r.blockRefs).toEqual(["64f1a2b3-0000-4000-8000-000000000001"]);
  });

  it("[[Target|label]] refs the target, not 'target|label' (B-86)", () => {
    const r = extractRefs("see [[Target|the target]], [[Plain]] and [[a|see [[nested]]]]");
    expect(r.pageRefs).toEqual(["Target", "Plain", "a", "nested"]);
  });

  it("does not treat org-mode block directives (#+BEGIN_QUOTE) as tags", () => {
    const r = extractRefs("#+BEGIN_QUOTE\nquoted text #real\n#+END_QUOTE");
    expect(r.tags).toEqual(["real"]);
  });

  it("ignores code spans and fences", () => {
    const r = extractRefs("`[[no]]` and ``x [[no]] `` but [[yes]]\n```\n[[no]] #no\n```\n#yes");
    expect(r.pageRefs).toEqual(["yes"]);
    expect(r.tags).toEqual(["yes"]);
  });

  it("does not treat headings, URLs fragments or lone hashes as tags", () => {
    const r = extractRefs(
      "# Heading\nhttps://x.com/a#frag ## also\n# \n#real, #other. (#paren) [#brackets]",
    );
    expect(r.tags).toEqual(["real", "other", "paren", "brackets"]);
  });

  it("supports namespaced and unicode tags", () => {
    const r = extractRefs("#a/b #čeština #v1.0");
    expect(r.tags).toEqual(["a/b", "čeština", "v1.0"]);
  });

  it("handles nested wikilinks", () => {
    const r = extractRefs("[[outer [[inner]] x]]");
    expect(r.pageRefs).toEqual(["outer [[inner]] x", "inner"]);
  });

  it("handles embeds", () => {
    const r = extractRefs(
      "{{embed [[Some Page]]}} {{embed ((64f1a2b3-0000-4000-8000-000000000001))}}",
    );
    expect(r.pageRefs).toEqual(["Some Page"]);
    expect(r.blockRefs).toEqual(["64f1a2b3-0000-4000-8000-000000000001"]);
  });

  it("reads tags and alias properties as lists and other properties as text", () => {
    const r = extractRefs("body", {
      tags: "a, [[b c]], #d",
      alias: "x, y",
      type: "[[book]] #genre",
      plain: "nothing",
    });
    expect(r.tags).toEqual(["a", "b c", "d", "genre"]);
    expect(r.pageRefs).toEqual(["x", "y", "book"]);
  });

  it("dedupes", () => {
    const r = extractRefs("[[a]] [[a]] #t #t");
    expect(r.pageRefs).toEqual(["a"]);
    expect(r.tags).toEqual(["t"]);
  });
});

describe("splitList", () => {
  it("splits on commas outside brackets", () => {
    expect(splitList("a, [[b, c]], d")).toEqual(["a", "[[b, c]]", "d"]);
  });
});
