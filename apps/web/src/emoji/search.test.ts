import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { buildEmojiData, MAX_EMOJI_VERSION } from "./build-data.js";
import {
  browseSections,
  buildIndex,
  firstGrapheme,
  moveInGrid,
  queryTerms,
  rawEmoji,
  searchEmoji,
} from "./search.js";

// The real list, built the way the Vite plugin builds it: the tests below are about what the
// picker will actually find, not about a fixture.
const require = createRequire(import.meta.url);
const data = buildEmojiData(
  require("emojibase-data/en/data.json"),
  require("emojibase-data/en/messages.json"),
);
const index = buildIndex(data);
const found = (q: string) => searchEmoji(index, q).map((r) => r[0]);

describe("buildEmojiData", () => {
  it("keeps every group but the skin-tone components, with English names", () => {
    expect(data.emojis.length).toBeGreaterThan(1800);
    expect(data.groups[0]).toBe("smileys & emotion");
    expect(new Set(data.emojis.map((e) => e[3]))).not.toContain(2);
    expect(data.emojis.find((e) => e[0] === "🚀")?.[1]).toBe("rocket");
  });

  it(`drops glyphs newer than Emoji ${MAX_EMOJI_VERSION}, which older systems draw as a box`, () => {
    const raw = require("emojibase-data/en/data.json") as { emoji: string; version: number }[];
    const newer = raw.filter((e) => e.version > MAX_EMOJI_VERSION).map((e) => e.emoji);
    expect(newer.length).toBeGreaterThan(0);
    const kept = new Set(data.emojis.map((e) => e[0]));
    for (const e of newer) expect(kept).not.toContain(e);
  });
});

describe("searchEmoji", () => {
  it("finds by name, the exact name first", () => {
    expect(found("rocket")[0]).toBe("🚀");
  });

  it("finds by keyword", () => {
    expect(found("space")).toContain("🚀");
    expect(found("geek")).toContain("🤓");
  });

  it("matches word prefixes, every term", () => {
    expect(found("roc")).toContain("🚀");
    expect(found("red heart")[0]).toBe("❤️");
    expect(found("zzzzqx")).toEqual([]);
  });

  it("takes shortcode habits: colons and underscores", () => {
    expect(queryTerms(":thumbs_up:")).toEqual(["thumbs", "up"]);
    expect(found(":rocket:")[0]).toBe("🚀");
  });

  it("is case-insensitive", () => {
    expect(found("ROCKET")[0]).toBe("🚀");
  });
});

describe("rawEmoji", () => {
  it("takes a typed or pasted emoji whole, flags and ZWJ sequences included", () => {
    expect(rawEmoji("🚀")).toBe("🚀");
    expect(rawEmoji(" 🇨🇿 flag then words")).toBe("🇨🇿");
    expect(rawEmoji("👩‍🚀")).toBe("👩‍🚀");
    expect(rawEmoji("👍🏽")).toBe("👍🏽");
    expect(rawEmoji("★")).toBe("★");
  });

  it("leaves words alone, in any script, and ASCII punctuation", () => {
    expect(rawEmoji("rocket")).toBeNull();
    expect(rawEmoji("čaj")).toBeNull();
    expect(rawEmoji(":rocket")).toBeNull();
    expect(rawEmoji("+")).toBeNull();
    expect(rawEmoji("")).toBeNull();
    expect(rawEmoji("3")).toBeNull();
  });

  it("firstGrapheme keeps a flag intact", () => {
    expect(firstGrapheme("🇨🇿🔥")).toBe("🇨🇿");
  });
});

describe("browseSections", () => {
  it("puts recents first, then the groups in order, without components", () => {
    const sections = browseSections(data, ["🚀", "🫠"]);
    expect(sections[0]?.title).toBe("Recently used");
    expect(sections[0]?.rows.map((r) => r[0])).toEqual(["🚀", "🫠"]);
    expect(sections[1]?.title).toBe("smileys & emotion");
    expect(sections.map((s) => s.title)).not.toContain("components");
    expect(sections).toHaveLength(10);
  });

  it("offers a recent that is not in the list, named by itself", () => {
    const [recent] = browseSections(data, ["★"]);
    expect(recent?.rows[0]).toEqual(["★", "★", "", -1]);
  });

  it("has no recents section when there are none", () => {
    expect(browseSections(data, [])[0]?.title).toBe("smileys & emotion");
  });
});

describe("moveInGrid", () => {
  // Two sections of 8 columns: 10 cells (a full row and 2), then 5.
  const lengths = [10, 5];
  const move = (at: number, key: Parameters<typeof moveInGrid>[2]) =>
    moveInGrid(lengths, at, key, 8);

  it("enters the grid on Down from the field, and Up from the top row leaves it", () => {
    expect(move(-1, "ArrowDown")).toBe(0);
    expect(move(-1, "ArrowRight")).toBe(-1);
    expect(move(3, "ArrowUp")).toBe(-1);
  });

  it("Left/Right step through cells and stop at the ends", () => {
    expect(move(0, "ArrowLeft")).toBe(0);
    expect(move(4, "ArrowRight")).toBe(5);
    expect(move(14, "ArrowRight")).toBe(14);
  });

  it("Down moves a row, onto a shorter last row's last cell, then into the next section", () => {
    expect(move(1, "ArrowDown")).toBe(9);
    expect(move(5, "ArrowDown")).toBe(9); // row 2 has only cells 8, 9
    expect(move(9, "ArrowDown")).toBe(11); // column 1 of the next section (10 + 1)
    expect(move(14, "ArrowDown")).toBe(14); // nowhere further
  });

  it("Up crosses into the previous section's last row at the same column", () => {
    expect(move(11, "ArrowUp")).toBe(9); // column 1 → cell 9 (row 8..9)
    expect(move(14, "ArrowUp")).toBe(9); // column 4, that row is shorter → its last cell
    expect(move(9, "ArrowUp")).toBe(1);
  });

  it("skips empty sections and handles an empty grid", () => {
    expect(moveInGrid([3, 0, 2], 1, "ArrowDown", 8)).toBe(4);
    expect(moveInGrid([], -1, "ArrowDown", 8)).toBe(-1);
  });
});
