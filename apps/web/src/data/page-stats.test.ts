import { describe, expect, it } from "vitest";
import { countWords } from "../../../../plugins/word-count/src/count.js";
import { tallyPageStats } from "./page-stats.js";

describe("tallyPageStats (B-645)", () => {
  it("counts blocks and words per page with the word-count plugin's rule", () => {
    const stats = tallyPageStats([
      { page_id: "a", content: "one two  three" },
      { page_id: "a", content: "see [[Some Page]]\n\tnext" },
      { page_id: "b", content: "" },
    ]);
    expect(stats.get("a")).toEqual({ blocks: 2, words: 3 + 4 });
    // An empty block is still a block, with no words.
    expect(stats.get("b")).toEqual({ blocks: 1, words: 0 });
    expect(stats.has("c")).toBe(false);
  });

  it("agrees with the plugin on whitespace-only and Czech text", () => {
    expect(countWords("   \n\t ")).toBe(0);
    expect(
      tallyPageStats([{ page_id: "x", content: "Příliš žluťoučký kůň" }]).get("x")?.words,
    ).toBe(3);
  });
});
