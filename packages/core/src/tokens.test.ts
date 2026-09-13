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
 * 3. Performance (§7): `tokenizeContent` over 20,000 synthetic blocks within a CPU-time budget, and
 *    a cost that grows linearly with line length.
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

// B-264: Logseq's display form. Before, the second `$` opened inline math and the fourth was left
// over as text, so `$$x$$` read as "$", a formula, "$".
describe("tokenizeLine: display math $$…$$", () => {
  it("is one math token with display set and the delimiters outside tex", () => {
    const line = "Display math $$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$ end";
    const toks = tokenizeLine(line);
    expect(toks.map((t) => t.kind)).toEqual(["text", "math", "text"]);
    const math = toks[1] as Extract<InlineToken, { kind: "math" }>;
    expect(math.display).toBe(true);
    expect(math.tex).toBe("\\int_0^1 x^2\\,dx = \\frac{1}{3}");
    expect(line.slice(math.start, math.end)).toBe("$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$");
  });

  it("works inside emphasis, as on the owner's graph", () => {
    const toks = tokenizeLine("*je to $$CO_2$$*");
    const em = toks[0] as Extract<InlineToken, { kind: "em" }>;
    expect(em.children.map((t) => t.kind)).toEqual(["text", "math"]);
    expect(em.children[1]).toMatchObject({ kind: "math", tex: "CO_2", display: true });
  });

  it("inline $…$ is not display math", () => {
    const math = tokenizeLine("$e^{i\\pi}+1=0$").find((t) => t.kind === "math");
    expect(math).toMatchObject({ tex: "e^{i\\pi}+1=0" });
    expect((math as Extract<InlineToken, { kind: "math" }>).display).toBeUndefined();
  });

  it("needs content and a closer, and keeps the price rule for the closer", () => {
    expect(tokenizeLine("$$ $$").some((t) => t.kind === "math")).toBe(false);
    expect(tokenizeLine("$$x").some((t) => t.kind === "math")).toBe(false);
    expect(tokenizeLine("$$5 and $$10").some((t) => t.kind === "math")).toBe(false);
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
  // Measured in PROCESS CPU TIME (`process.cpuUsage()`), never wall-clock. Wall-clock in a unit
  // suite measures the machine as much as the code: this test's first form, a 50 ms wall budget,
  // failed at 60-71 ms whenever other suites ran alongside; raised to 500 ms it still failed at
  // 1,488 ms when a dozen agents shared the machine (B-333), which teaches nobody anything and
  // trains people to re-run until green. CPU time counts only the work: probe
  // `tools/probes/cpu-vs-wall-under-load.ts` measured these 20,000 blocks at 18-20 ms CPU and wall
  // idle, and at 19-32 ms CPU but 144-684 ms wall at load average 85-142.
  //
  // What is worth catching is a change in kind, not a few milliseconds, so the budget stays an
  // order of magnitude above the real cost. It cannot see a cost that grows with LINE LENGTH —
  // these blocks are 70-90 characters — which is where a tokenizer really goes quadratic (a regex
  // that backtracks, a rescan per delimiter); the second test measures that as a ratio, which the
  // machine's speed cancels out of.
  const templates = [
    "Plain text block with a [[Wikilink Target]] and a #tag mid-sentence.",
    "A **bold** claim, an *em* aside, and a `code span` for good measure.",
    "See ((1k7f3q9xz2hav4)) and {{embed [[Some Page]]}} plus a [link](https://example.com/x).",
    "Price is $5 not math, but $E=mc^2$ genuinely is, #namespace/tag too.",
    "Multi\nline\nparagraph\nwith several hard breaks and a #tag on the third #line.",
    "~~gone~~ and ==kept== and _emphasis_ and normal_snake_case_var untouched.",
    "![alt](assets/1k7f3q9xz2hav9.png) plus checkbox [ ] and [x] done markers.",
  ];
  /** CPU milliseconds (user + system) spent in `fn`. */
  const cpuMs = (fn: () => void): number => {
    const start = process.cpuUsage();
    fn();
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  // Vitest's timeout (the 60_000 below) is wall-clock too, so it is only a hang guard.

  it("stays far away from quadratic", () => {
    const blocks = Array.from({ length: 20_000 }, (_, i) => templates[i % templates.length]);
    let tokenCount = 0;
    const elapsed = cpuMs(() => {
      for (const block of blocks) tokenCount += tokenizeContent(block as string).length;
    });
    expect(tokenCount).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  }, 60_000);

  it("costs the same per character on a line four times as long", () => {
    // One long paragraph line — the owner's largest page is 1.7 MB — made of the templates without
    // their hard breaks: ~83k and ~333k characters. Both sides tokenize the SAME number of
    // characters (the short line four times, the long one once), so linear work costs the same on
    // each and quadratic work costs ~4x more on the long side; 2 sits between with room either side.
    //
    // CPU time is not load-proof on its own (B-405): on a machine with performance and efficiency
    // cores (the M4 Pro this runs on has both), a busy scheduler parks a thread on an efficiency
    // core for whole quanta and bills roughly twice the CPU time for the same work. This test's
    // first form compared the best of three ~3 ms short runs with the best of three ~25 ms long
    // runs: the short minimum nearly always caught an undisturbed stretch, the long one often did
    // not, and at load average 100-140 the ratio read 8.16 and 8.32 against a limit of 8 (2 of 95
    // runs; median 5.8 against 4.4 idle). So the sides alternate, each window is only ~2 ms of
    // CPU — shorter than a quantum — and each side keeps the least-disturbed of fifteen: at the
    // same load the ratio then stayed in 0.92-1.18 over 45 runs (1.08-1.10 idle). Detection is
    // what it was: length-quadratic work planted in `tokenizeContent` (a rescan to the end from
    // every Nth character) fails for N = 512-2048 in both forms, and N = 4096 sits at the limit in
    // both, going either way from run to run.
    const unit = templates.map((t) => t.replaceAll("\n", " ")).join(" ");
    const line = (copies: number) => Array.from({ length: copies }, () => unit).join(" ");
    const short = line(160);
    const long = line(640);
    const tokenizeShort = () => {
      for (let i = 0; i < 4; i++) tokenizeContent(short);
    };
    const tokenizeLong = () => {
      tokenizeContent(long);
    };
    // Warm-up, so JIT compilation is billed to neither side.
    tokenizeShort();
    tokenizeLong();
    let shortMs = Number.POSITIVE_INFINITY;
    let longMs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 15; i++) {
      shortMs = Math.min(shortMs, cpuMs(tokenizeShort));
      longMs = Math.min(longMs, cpuMs(tokenizeLong));
    }
    expect(longMs / shortMs).toBeLessThan(2);
  }, 60_000);
});
