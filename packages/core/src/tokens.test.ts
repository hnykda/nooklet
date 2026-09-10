/**
 * Tests for the inline tokenizer and block-content classifier
 * (`docs/spec/markdown-grammar.md` §2.7-2.9, §3).
 *
 * 1. A conformance suite against the `tokens`/`blockContent` corpus cases (35-48), per §9's
 *    `CorpusCase` schema: cases 35-47 carry `tokens` (the flat `tokenizeContent` stream for a
 *    single paragraph/quote block), case 48 carries `blockContent` (`classifyBlockContent` for
 *    all five non-paragraph content kinds). `parseOutline` is used to get each case's block
 *    content, since these corpus files are single-block (or, for case 48, single-level-of-
 *    siblings) per the spec's own schema note.
 * 2. Focused unit tests for grammar corners the corpus doesn't fully exercise: offsets over
 *    multi-byte/emoji content, strong/em delimiter-length edge cases, escaping edge cases,
 *    quote/heading multi-line assembly, fence closing-run length, table edge cases.
 * 3. A performance test: `tokenizeContent` over 20,000 synthetic blocks in < 50ms (§7).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OutlineNode } from "./model.js";
import { parseOutline } from "./outline.js";
import {
  type BlockContent,
  classifyBlockContent,
  type InlineToken,
  tokenizeContent,
  tokenizeLine,
} from "./tokens.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "..", "..", "docs", "spec", "corpus");

interface CorpusCase {
  description: string;
  properties: Record<string, string>;
  blocks: unknown[];
  tokens?: InlineToken[];
  blockContent?: BlockContent[];
}

const mdFiles = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

const relevantCases = mdFiles
  .map((mdFile) => {
    const slug = mdFile.replace(/\.md$/, "");
    const expected: CorpusCase = JSON.parse(
      readFileSync(join(corpusDir, `${slug}.expected.json`), "utf8"),
    );
    return { mdFile, slug, expected };
  })
  .filter(({ expected }) => expected.tokens !== undefined || expected.blockContent !== undefined);

describe("markdown-grammar.md corpus: tokens / blockContent (cases 35-48)", () => {
  it("covers at least 14 tokens/blockContent cases (35-47 tokens, 48 blockContent)", () => {
    const withTokens = relevantCases.filter((c) => c.expected.tokens !== undefined);
    const withBlockContent = relevantCases.filter((c) => c.expected.blockContent !== undefined);
    expect(withTokens.length).toBeGreaterThanOrEqual(13);
    expect(withBlockContent.length).toBeGreaterThanOrEqual(1);
  });

  for (const { mdFile, slug, expected } of relevantCases) {
    it(`${slug}: ${expected.description}`, () => {
      const text = readFileSync(join(corpusDir, mdFile), "utf8");
      const parsed = parseOutline(text);

      if (expected.tokens !== undefined) {
        const block = parsed.blocks[0] as OutlineNode | undefined;
        expect(block).toBeDefined();
        expect(tokenizeContent((block as OutlineNode).content)).toEqual(expected.tokens);
      }

      if (expected.blockContent !== undefined) {
        const actual = parsed.blocks.map((b) => classifyBlockContent(b.content));
        expect(actual).toEqual(expected.blockContent);
      }
    });
  }
});

describe("tokenizeLine: offsets over multi-byte content", () => {
  it("keeps emoji (surrogate-pair) offsets correct outside a tag", () => {
    const line = "😀 [[Target]] more 🎉";
    const toks = tokenizeLine(line);
    // "😀 " is 3 UTF-16 units (2 for the emoji + 1 space); wikilink starts right after.
    const wl = toks.find((t) => t.kind === "wikilink");
    expect(wl).toMatchObject({ start: 3, target: "Target" });
  });

  it("tokenizes a tag made entirely of astral emoji", () => {
    const line = "#🎉🎊 party";
    const toks = tokenizeLine(line);
    expect(toks[0]).toMatchObject({
      kind: "tag",
      start: 0,
      end: 5,
      name: "🎉🎊",
      multiWord: false,
    });
  });

  it("respects a non-zero base offset for a multi-byte prefix", () => {
    // Simulates classifyHeading's use of `base` for "## 😀 hi" -> tokenizeLine("😀 hi", 3).
    const toks = tokenizeLine("😀 hi", 3);
    expect(toks).toEqual([{ kind: "text", start: 3, end: 8 }]);
  });
});

describe("tokenizeLine: strong/em delimiter-length edge cases (§2.9)", () => {
  it("*** collapses to strong with the whole run spent on each side", () => {
    const toks = tokenizeLine("***text***");
    expect(toks).toEqual([
      { kind: "strong", start: 0, end: 10, children: [{ kind: "text", start: 3, end: 7 }] },
    ]);
  });

  it("an unterminated ** falls back to plain text, retried char by char", () => {
    const toks = tokenizeLine("**bold");
    expect(toks).toEqual([{ kind: "text", start: 0, end: 6 }]);
  });

  it("mixed nesting: *text **bold** more* recurses through both delimiters", () => {
    const toks = tokenizeLine("*text **bold** more*");
    expect(toks).toHaveLength(1);
    const em = toks[0] as Extract<InlineToken, { kind: "em" }>;
    expect(em.kind).toBe("em");
    expect(em.children.some((c) => c.kind === "strong")).toBe(true);
  });

  it("__strong__ (double underscore) is NOT recognized as a strong delimiter (Open issue 2)", () => {
    // Per the literal flanking rule (§2.9: "_" itself counts as a word char), the outer pair
    // (positions 0 and 9) and the inner pair (positions 1 and 8) each independently qualify as
    // em delimiters, so this collapses to nested em(em("strong")) rather than one strong token
    // and rather than plain text -- there is still no double-underscore *strong* spelling.
    const toks = tokenizeLine("__strong__");
    expect(toks).toEqual([
      {
        kind: "em",
        start: 0,
        end: 10,
        children: [
          {
            kind: "em",
            start: 1,
            end: 9,
            children: [{ kind: "text", start: 2, end: 8 }],
          },
        ],
      },
    ]);
  });

  it("closing run longer than opener's is still consumed as strong", () => {
    // "**a***" -> open run=2, close run found of len 3 (>=2), whole close run consumed.
    const toks = tokenizeLine("**a***");
    expect(toks).toEqual([
      { kind: "strong", start: 0, end: 6, children: [{ kind: "text", start: 2, end: 3 }] },
    ]);
  });

  it("intraword underscore guard: word char on either flanking side keeps it plain", () => {
    expect(tokenizeLine("a_b_c")).toEqual([{ kind: "text", start: 0, end: 5 }]);
    // Not flanked by a word char on the outside -> recognized.
    expect(tokenizeLine("(_word_)")).toEqual([
      { kind: "text", start: 0, end: 1 },
      { kind: "em", start: 1, end: 7, children: [{ kind: "text", start: 2, end: 6 }] },
      { kind: "text", start: 7, end: 8 },
    ]);
  });
});

describe("tokenizeLine: escaping edge cases (§6)", () => {
  it("a trailing lone backslash at end of line is plain text", () => {
    expect(tokenizeLine("abc\\")).toEqual([{ kind: "text", start: 0, end: 4 }]);
  });

  it("a backslash before a non-escapable char (letter) is plain text, not consumed", () => {
    // \a is not an escape (CommonMark rule); both chars stay plain.
    expect(tokenizeLine("\\a")).toEqual([{ kind: "text", start: 0, end: 2 }]);
  });

  it("escapes every character in the escapable set", () => {
    const chars = [
      "\\",
      "[",
      "]",
      "(",
      ")",
      "{",
      "}",
      "#",
      "*",
      "_",
      "~",
      "=",
      "`",
      "$",
      "|",
      "<",
      ">",
      "!",
      "^",
    ];
    for (const c of chars) {
      const toks = tokenizeLine(`\\${c}`);
      expect(toks).toEqual([{ kind: "escape", start: 0, end: 2, char: c }]);
    }
  });

  it("escaping is legal inside a link label", () => {
    const toks = tokenizeLine("[a \\] b](url)");
    const link = toks[0] as Extract<InlineToken, { kind: "link" }>;
    expect(link.kind).toBe("link");
    expect(link.href).toBe("url");
    expect(link.label.some((t) => t.kind === "escape")).toBe(true);
  });

  it("escape is not recognized inside an already-open code span", () => {
    const toks = tokenizeLine("`a\\`b`");
    // First backtick run of length 1 closes at the escaped-looking backtick: `a\` is the code.
    expect(toks[0]).toMatchObject({ kind: "code", code: "a\\" });
  });
});

describe("classifyBlockContent: fence closing-run length (CLS-F)", () => {
  it("a longer closing run (length >= opener's) still closes the fence", () => {
    const bc = classifyBlockContent("```js\nconst x = 1;\n````");
    expect(bc).toEqual({ kind: "fence", lang: "js", code: "const x = 1;" });
  });

  it("an unterminated fence runs to the end of the block", () => {
    const bc = classifyBlockContent("```js\nconst x = 1;");
    expect(bc).toEqual({ kind: "fence", lang: "js", code: "const x = 1;" });
  });

  it("a closing line with trailing content does not close the fence", () => {
    const bc = classifyBlockContent("```\ncode\n``` not really closing\nmore\n```");
    expect(bc).toEqual({ kind: "fence", lang: "", code: "code\n``` not really closing\nmore" });
  });
});

describe("classifyBlockContent: heading trailing paragraph (CLS-H)", () => {
  it("keeps a Shift+Enter trailing line as a hard-broken trailing paragraph", () => {
    const bc = classifyBlockContent("## Status\nNumbered:") as Extract<
      BlockContent,
      { kind: "heading" }
    >;
    expect(bc.kind).toBe("heading");
    expect(bc.level).toBe(2);
    expect(bc.title).toEqual([{ kind: "text", start: 3, end: 9 }]);
    expect(bc.trailing).toEqual([[{ kind: "text", start: 10, end: 19 }]]);
  });

  it("a heading with no space after the hash run is not a heading", () => {
    const bc = classifyBlockContent("##nospace");
    expect(bc.kind).toBe("paragraph");
  });
});

describe("classifyBlockContent: quote assembly (CLS-Q)", () => {
  it("preserves a blank line inside a quote and keeps offsets absolute", () => {
    const content = "> a\n\n> b";
    const bc = classifyBlockContent(content) as Extract<BlockContent, { kind: "quote" }>;
    expect(bc.kind).toBe("quote");
    expect(bc.lines).toEqual([
      [{ kind: "text", start: 2, end: 3 }],
      [],
      [{ kind: "text", start: 7, end: 8 }],
    ]);
  });

  it("falls back to paragraph when even one non-empty line lacks a leading >", () => {
    const bc = classifyBlockContent("> a\nb");
    expect(bc.kind).toBe("paragraph");
  });

  it("tokenizeContent flattens a quote's lines with br tokens at the real newline", () => {
    const content = "> a\n> b";
    expect(tokenizeContent(content)).toEqual([
      { kind: "text", start: 2, end: 3 },
      { kind: "br", start: 3, end: 4 },
      { kind: "text", start: 6, end: 7 },
    ]);
  });
});

describe("classifyBlockContent: table edge cases (CLS-T)", () => {
  it("supports left/right/center alignment colons", () => {
    const bc = classifyBlockContent("| L | R | C |\n| :-- | --: | :-: |\n| a | b | c |") as Extract<
      BlockContent,
      { kind: "table" }
    >;
    expect(bc.kind).toBe("table");
    expect(bc.align).toEqual(["left", "right", "center"]);
  });

  it("a ragged row falls back to paragraph", () => {
    const bc = classifyBlockContent("| a | b |\n| --- | --- |\n| only one |");
    expect(bc.kind).toBe("paragraph");
  });

  it("an escaped pipe inside a cell is not a separator", () => {
    const bc = classifyBlockContent("| a\\|b | c |\n| --- | --- |\n| x | y |") as Extract<
      BlockContent,
      { kind: "table" }
    >;
    expect(bc.kind).toBe("table");
    expect(bc.header).toHaveLength(2);
    const firstCell = bc.header[0] as InlineToken[];
    expect(firstCell.some((t) => t.kind === "escape" && t.char === "|")).toBe(true);
  });

  it("a setext-style underline with no pipes is not mistaken for a one-column table", () => {
    // "---" alone can't be `hr` either (CLS-R requires content to be exactly one line), so this
    // two-line content correctly falls through to the CLS-P default rather than a false table.
    const bc = classifyBlockContent("Title\n---");
    expect(bc.kind).toBe("paragraph" as BlockContent["kind"]);
  });
});

describe("classifyBlockContent: hr variants (CLS-R)", () => {
  it.each(["---", "***", "___", "----------"])("recognizes %s as hr", (line) => {
    expect(classifyBlockContent(line)).toEqual({ kind: "hr" });
  });

  it("a multi-line block is never classified as hr", () => {
    expect(classifyBlockContent("---\nmore").kind).not.toBe("hr");
  });
});

describe("tokenizeLine: wikilink and tag corners", () => {
  it("keeps an empty alias after a trailing pipe", () => {
    const toks = tokenizeLine("[[Target|]]");
    expect(toks).toEqual([
      {
        kind: "wikilink",
        start: 0,
        end: 11,
        target: "Target",
        targetStart: 2,
        targetEnd: 9,
        alias: "",
      },
    ]);
  });

  it("supports doubly-nested wikilinks recursively", () => {
    const toks = tokenizeLine("[[a [[b [[c]] d]] e]]");
    const outer = toks[0] as Extract<InlineToken, { kind: "wikilink" }>;
    expect(outer.target).toBe("a [[b [[c]] d]] e");
    expect(outer.nested).toHaveLength(1);
    const mid = (outer.nested as InlineToken[])[0] as Extract<InlineToken, { kind: "wikilink" }>;
    expect(mid.target).toBe("b [[c]] d");
    expect(mid.nested).toHaveLength(1);
  });

  it("a lone trailing-punctuation-only tag body still emits a tag token (grammar-level, not ref-level)", () => {
    const toks = tokenizeLine("#... x");
    expect(toks[0]).toMatchObject({ kind: "tag", name: "", multiWord: false });
  });

  it("an empty #[[]] multi-word tag still emits a tag token with an empty name", () => {
    const toks = tokenizeLine("#[[]]");
    expect(toks).toEqual([{ kind: "tag", start: 0, end: 5, name: "", multiWord: true }]);
  });
});

describe("tokenizeLine: math heuristic corners", () => {
  it("only tests the immediately next $ as a candidate closer, not a further one", () => {
    // The first "$" after "a" is whitespace-preceded (fails as closer), so opener "a" fails
    // entirely rather than skipping ahead to the later, valid-looking "$c$".
    const toks = tokenizeLine("$a $b$ $c$");
    expect(toks.filter((t) => t.kind === "math")).toHaveLength(2);
  });

  it("a $ followed by whitespace never opens math", () => {
    expect(tokenizeLine("$ 5")).toEqual([{ kind: "text", start: 0, end: 3 }]);
  });
});

describe("tokenizeContent: empty and edge content", () => {
  it("returns [] for empty content", () => {
    expect(tokenizeContent("")).toEqual([]);
  });

  it("classifyBlockContent of empty content is an empty paragraph line", () => {
    expect(classifyBlockContent("")).toEqual({ kind: "paragraph", lines: [[]] });
  });
});

describe("performance (§7): tokenizeContent over 20,000 synthetic blocks", () => {
  it("completes in under 50ms total", () => {
    const templates = [
      "Plain text block with a [[Wikilink Target]] and a #tag mid-sentence.",
      "A **bold** claim, an *em* aside, and a `code span` for good measure.",
      "See ((1k7f3q9xz2hav4)) and {{embed [[Some Page]]}} plus a [link](https://example.com/x).",
      "Price is $5 not math, but $E=mc^2$ genuinely is, #namespace/tag too.",
      "Multi\nline\nparagraph\nwith several hard breaks and a #tag on the third #line.",
      "~~gone~~ and ==kept== and _emphasis_ and normal_snake_case_var untouched.",
      "![alt](assets/1k7f3q9xz2hav9.png) plus checkbox [ ] and [x] done markers.",
    ];
    const blocks: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      blocks.push(templates[i % templates.length] as string);
    }

    const start = performance.now();
    let tokenCount = 0;
    for (const block of blocks) {
      tokenCount += tokenizeContent(block).length;
    }
    const elapsed = performance.now() - start;

    expect(tokenCount).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });
});
