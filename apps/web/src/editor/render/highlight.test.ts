import { describe, expect, it } from "vitest";
import {
  _resetHighlightCache,
  canHighlight,
  HIGHLIGHT_LANGUAGES,
  highlightCode,
  highlightSync,
  resolveLanguage,
} from "./highlight.js";
import { LOADERS } from "./highlighter-impl.js";

describe("resolveLanguage", () => {
  it("maps the common aliases people type in fences to bundled grammars", () => {
    expect(resolveLanguage("js")).toBe("javascript");
    expect(resolveLanguage("TS")).toBe("typescript");
    expect(resolveLanguage("py")).toBe("python");
    expect(resolveLanguage("sh")).toBe("bash");
    expect(resolveLanguage("html")).toBe("xml");
    expect(resolveLanguage("yml")).toBe("yaml");
    expect(resolveLanguage("toml")).toBe("ini");
    expect(resolveLanguage("c++")).toBe("cpp");
    expect(resolveLanguage("rust")).toBe("rust");
  });

  it("uses only the first word of an info string", () => {
    expect(resolveLanguage('js title="x"')).toBe("javascript");
    expect(resolveLanguage("  python  ")).toBe("python");
  });

  it("is null for plain text, unknown languages and the query fence", () => {
    expect(resolveLanguage("")).toBeNull();
    expect(resolveLanguage("plaintext")).toBeNull();
    expect(resolveLanguage("text")).toBeNull();
    expect(resolveLanguage("brainfuck")).toBeNull();
    expect(resolveLanguage("query")).toBeNull();
    expect(canHighlight("mermaid")).toBe(false);
    expect(canHighlight("json")).toBe(true);
  });

  it("the facade's language list is exactly the impl's loader map (no grammar is unreachable, none is phantom)", () => {
    expect([...HIGHLIGHT_LANGUAGES].sort()).toEqual(Object.keys(LOADERS).sort());
  });
});

describe("highlightCode", () => {
  it("returns escaped, span-wrapped HTML for a bundled language and caches it", async () => {
    _resetHighlightCache();
    expect(highlightSync("const x = 1;", "js")).toBeNull();
    const html = await highlightCode("const x = 1; // <b>", "js");
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(highlightSync("const x = 1; // <b>", "js")).toBe(html);
    expect(highlightSync("const x = 1; // <b>", "javascript")).toBe(html);
  });

  it("is null for a language it cannot highlight", async () => {
    expect(await highlightCode("x", "")).toBeNull();
    expect(await highlightCode("x", "nope")).toBeNull();
  });

  it("does not throw on code that is illegal for the grammar", async () => {
    const html = await highlightCode("}}} ((( 'unterminated", "json");
    expect(typeof html).toBe("string");
  });
});
