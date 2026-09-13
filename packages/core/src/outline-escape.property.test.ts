/**
 * OUT-23a (B-342) under random text, not just the shapes someone thought of: content built from
 * the fragments the escape and the parser care about — `::`, runs of backslashes, `SCHEDULED`,
 * `<…>`, `:LOGBOOK:`, `:END:`, fences, a marker word, Czech — next to every head, id and property a
 * block can carry.
 *
 * Why a property test: the escape has to agree with the parser line by line (which lines are
 * consumed, where fences open, what line 1 is once its head and id are off). The fixed cases in
 * `outline.test.ts` pin the shapes B-342 named; this is what shows no other combination of them was
 * made lossy. Run against the base `outline.ts` (52e5d20) the first property fails and the second
 * holds; a 100k-run version of both (mirror-escape-verify, scratch `fuzz.ts`) found no block that
 * round-tripped before the escape and does not after it.
 *
 * Shapes that are lossy for reasons older than OUT-23a are kept out of the first property, each
 * named: a later line that looks like a bullet (B-470), a plain block whose line 1 starts with a
 * marker word (B-471), leading whitespace on line 1 (taken off after a head), whitespace-only and
 * trailing whitespace (the parser trims them), and an empty line 1.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { OutlineNode, ParsedPage, Properties } from "./model.js";
import { parseOutline, serializeOutline } from "./outline.js";

const FRAGMENTS = [
  "foo",
  "k",
  "scheduled",
  "SCHEDULED",
  "DEADLINE",
  "TODO",
  "::",
  ":",
  "\\",
  "\\",
  " ",
  "\t",
  "<2026-09-20 Sun>",
  "<bad>",
  ":LOGBOOK:",
  ":END:",
  "```",
  "~~~",
  "js",
  "č",
  "id",
  "collapsed",
  ">",
  ".",
];

const line = (fragments: readonly string[]) =>
  fc.array(fc.constantFrom(...fragments), { maxLength: 6 }).map((parts) => parts.join(""));

/** Content text the grammar before OUT-23a could already carry, apart from the escape's shapes. */
const content = fc
  .array(line(FRAGMENTS), { minLength: 1, maxLength: 5 })
  .map((lines) =>
    lines
      .join("\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n+$/, ""),
  )
  .filter((text) => {
    const lines = text.split("\n");
    const first = lines[0] as string;
    if (first === "" || /^\s/.test(first) || /^TODO(\s|$)/.test(first)) return false;
    // A whitespace-only line is trimmed to "" by the parser.
    if (lines.some((l) => l !== "" && l.trim() === "")) return false;
    // B-470: a later line shaped like a bullet comes back as a child block.
    return !lines.some((l) => /^\s*([-*+]|\d+\.)(\s|$)/.test(l));
  });

const block = fc.record({
  content,
  marker: fc.constantFrom(null, "TODO" as const),
  priority: fc.constantFrom(null, "A" as const),
  properties: fc.constantFrom<Properties>({}, { foo: "bar" }),
  collapsed: fc.boolean(),
  withId: fc.boolean(),
  ids: fc.constantFrom("present" as const, "none" as const),
});

const filler: OutlineNode = {
  content: "before",
  marker: null,
  priority: null,
  properties: {},
  collapsed: false,
  children: [],
};

describe("OUT-23a escape under random content (mirror-escape-verify)", () => {
  it("serialize -> parse gives back every block, whatever shapes and backslashes its text has", () => {
    fc.assert(
      fc.property(block, ({ withId, ids, ...fields }) => {
        const node: OutlineNode = { ...fields, children: [] };
        if (withId) node.id = "1k7f3q9xz2hav5";
        const expected: OutlineNode = { ...node };
        if (ids === "none") delete expected.id;
        // A leading block, so an empty-text block is never read as the page-properties pre-block.
        const page: ParsedPage = { properties: {}, blocks: [filler, node] };
        const text = serializeOutline(page, { ids });
        expect(parseOutline(text).blocks, text).toEqual([filler, expected]);
      }),
      { numRuns: 3000, seed: 342 },
    );
  });

  it("any outline text reads the same after one serialize -> parse (the escape is a fixed point)", () => {
    const raw = fc
      .array(line([...FRAGMENTS, "-", " ^1k7f3q9xz2hav4", "[#A]"]), { minLength: 1, maxLength: 6 })
      // Trailing whitespace off, as the parser leaves it: a line 1 ending ` ^id ` is text on the
      // first read and an id on the second (B-476, older than OUT-23a).
      .map((lines) => `- ${lines.map((l) => l.replace(/[ \t]+$/, "")).join("\n  ")}\n`);
    fc.assert(
      fc.property(raw, (text) => {
        const once = parseOutline(text);
        expect(parseOutline(serializeOutline(once)), text).toEqual(once);
      }),
      { numRuns: 3000, seed: 23 },
    );
  });
});
