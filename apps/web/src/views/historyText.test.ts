import { describe, expect, it } from "vitest";
import { diffProperties, diffWords, formatWhen } from "./historyText.js";

describe("diffWords", () => {
  it("is empty for two empty strings and one 'same' run for identical text", () => {
    expect(diffWords("", "")).toEqual([]);
    expect(diffWords("a b", "a b")).toEqual([{ kind: "same", text: "a b" }]);
  });

  it("marks a replaced word as one removal and one addition, keeping the rest", () => {
    expect(diffWords("buy milk today", "buy bread today")).toEqual([
      { kind: "same", text: "buy " },
      { kind: "del", text: "milk" },
      { kind: "add", text: "bread" },
      { kind: "same", text: " today" },
    ]);
  });

  it("handles pure insertions and pure deletions at either end", () => {
    expect(diffWords("one", "one two")).toEqual([
      { kind: "same", text: "one" },
      { kind: "add", text: " two" },
    ]);
    expect(diffWords("zero one", "one")).toEqual([
      { kind: "del", text: "zero " },
      { kind: "same", text: "one" },
    ]);
    expect(diffWords("", "new")).toEqual([{ kind: "add", text: "new" }]);
    expect(diffWords("old", "")).toEqual([{ kind: "del", text: "old" }]);
  });

  it("falls back to whole-text removal + addition when the texts are huge", () => {
    const big = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    const parts = diffWords(big, `${big} x`);
    expect(parts.map((p) => p.kind)).toEqual(["del", "add"]);
  });

  it("reconstructs both sides from its parts", () => {
    const before = "the quick brown fox jumps over the lazy dog";
    const after = "the slow brown cat jumps over a lazy dog again";
    const parts = diffWords(before, after);
    const left = parts
      .filter((p) => p.kind !== "add")
      .map((p) => p.text)
      .join("");
    const right = parts
      .filter((p) => p.kind !== "del")
      .map((p) => p.text)
      .join("");
    expect(left).toBe(before);
    expect(right).toBe(after);
  });
});

describe("formatWhen", () => {
  const now = Date.parse("2026-09-12T15:00:00");
  it("says how recent while it is recent", () => {
    expect(formatWhen("2026-09-12T14:59:40", now)).toBe("just now");
    expect(formatWhen("2026-09-12T14:55:00", now)).toBe("5 minutes ago");
    expect(formatWhen("2026-09-12T14:59:00", now)).toBe("1 minute ago");
  });
  it("names the day once it is not", () => {
    expect(formatWhen("2026-09-12T09:05:00", now)).toBe("today 09:05");
    expect(formatWhen("2026-09-11T23:30:00", now)).toBe("yesterday 23:30");
    expect(formatWhen("2026-09-03T08:15:00", now)).toBe("3 Sep 2026 08:15");
  });
  it("passes an unparseable stamp through", () => {
    expect(formatWhen("not a date", now)).toBe("not a date");
  });
});

describe("diffProperties", () => {
  it("lists only the keys that differ, sorted, with both sides", () => {
    expect(diffProperties({ a: "1", b: "2", c: "3" }, { a: "1", b: "x", d: "4" })).toEqual([
      { key: "b", before: "2", after: "x" },
      { key: "c", before: "3", after: undefined },
      { key: "d", before: undefined, after: "4" },
    ]);
    expect(diffProperties(undefined, undefined)).toEqual([]);
  });
});
