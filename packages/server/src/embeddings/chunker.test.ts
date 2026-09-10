import { describe, expect, it } from "vitest";
import {
  cleanBlockText,
  estimateTokens,
  formatBlockUnitText,
  formatPageUnitText,
  hashText,
  isEmbeddableBlock,
} from "./chunker.js";

describe("cleanBlockText", () => {
  it("drops key:: value property lines", () => {
    expect(cleanBlockText("scheduled:: 2026-09-12\nDo the thing")).toBe("Do the thing");
  });

  it("unwraps [[page links]] and #tags", () => {
    expect(cleanBlockText("See [[Projects/Nooklet]] and #urgent")).toBe(
      "See Projects/Nooklet and urgent",
    );
  });

  it("drops ((block-ref)) tokens", () => {
    expect(cleanBlockText("recall ((1k7f3q9xz2hb01)) from yesterday")).toBe(
      "recall from yesterday",
    );
  });

  it("strips markdown emphasis markers and collapses whitespace", () => {
    expect(cleanBlockText("**bold**   and _stuff_   here")).toBe("bold and stuff here");
  });
});

describe("estimateTokens", () => {
  it("estimates roughly chars/3", () => {
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("hashText", () => {
  it("is deterministic and content-sensitive", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
    expect(hashText("hello")).not.toBe(hashText("hello!"));
  });

  it("produces a 64-char hex sha256 digest", () => {
    expect(hashText("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isEmbeddableBlock", () => {
  it("accepts a block with enough of its own text", () => {
    expect(isEmbeddableBlock("a".repeat(24), false)).toBe(true);
    expect(isEmbeddableBlock("a".repeat(23), false)).toBe(false);
  });

  it("accepts a short block that has children", () => {
    expect(isEmbeddableBlock("hi", true)).toBe(true);
  });
});

describe("formatBlockUnitText", () => {
  it("prepends the breadcrumb joined with the arrow, then the block's own text", () => {
    const text = formatBlockUnitText(["Projects/Nooklet", "Sync design"], "fix reconnect bug", []);
    expect(text).toBe("Projects/Nooklet › Sync design\nfix reconnect bug");
  });

  it("skips empty breadcrumb segments", () => {
    const text = formatBlockUnitText(["Projects/Nooklet", ""], "do the thing", []);
    expect(text).toBe("Projects/Nooklet\ndo the thing");
  });

  it("flattens descendants depth-first with a '- ' prefix", () => {
    const text = formatBlockUnitText(["Page"], "parent", ["child one", "child two"]);
    expect(text).toBe("Page\nparent\n- child one\n- child two");
  });

  it("caps descendants at the token budget, keeping earlier ones and cutting the rest", () => {
    // Each descendant line is ~34 chars -> ~12 tokens with the "- " prefix; a tiny budget should
    // keep only the first one or two, never overflow it by much, and never throw.
    const many = Array.from({ length: 50 }, (_, i) => `descendant line number ${i} here`);
    const text = formatBlockUnitText(["Page"], "root", many, { maxTokens: 40 });
    const lines = text.split("\n");
    expect(lines.length).toBeLessThan(many.length);
    expect(lines[0]).toBe("Page");
    expect(lines[1]).toBe("root");
    // every kept line after the header+own-text is a flattened descendant
    for (const l of lines.slice(2)) expect(l.startsWith("- descendant line number")).toBe(true);
  });

  it("keeps every descendant when the budget is generous", () => {
    const lines10 = Array.from({ length: 10 }, (_, i) => `d${i}`);
    const text = formatBlockUnitText(["P"], "root", lines10, { maxTokens: 300 });
    for (const l of lines10) expect(text).toContain(`- ${l}`);
  });
});

describe("formatPageUnitText", () => {
  it("is title followed by flattened top-level lines", () => {
    const text = formatPageUnitText("2026-09-10", ["line a", "line b"]);
    expect(text).toBe("2026-09-10\n- line a\n- line b");
  });

  it("caps top-level lines at the token budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => `top level block content number ${i}`);
    const text = formatPageUnitText("Title", many, { maxTokens: 50 });
    const lines = text.split("\n");
    expect(lines.length).toBeLessThan(many.length);
    expect(lines[0]).toBe("Title");
  });
});
