/**
 * Conformance suite against `docs/spec/corpus/`: every NN-slug.md / NN-slug.expected.json
 * pair in the grammar spec's synthetic test corpus (docs/spec/markdown-grammar.md §9).
 *
 * Only `{properties, blocks}` are checked here (the `tokens`/`blockContent` fields belong to
 * the not-yet-implemented `tokens.ts`, per the grammar spec's own note that `tokenizeContent`/
 * `classifyBlockContent` are a separate, later addition). A round-trip idempotence check is
 * also run for every case, per the spec's own test-suite description.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOutline, serializeOutline } from "./outline.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "..", "..", "docs", "spec", "corpus");

interface CorpusCase {
  description: string;
  properties: Record<string, string>;
  blocks: unknown[];
}

const mdFiles = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

describe("markdown-grammar.md corpus", () => {
  it("has at least 40 cases", () => {
    expect(mdFiles.length).toBeGreaterThanOrEqual(40);
  });

  for (const mdFile of mdFiles) {
    const slug = mdFile.replace(/\.md$/, "");
    const expected: CorpusCase = JSON.parse(
      readFileSync(join(corpusDir, `${slug}.expected.json`), "utf8"),
    );

    it(`${slug}: ${expected.description}`, () => {
      const text = readFileSync(join(corpusDir, mdFile), "utf8");
      const parsed = parseOutline(text);
      expect(parsed.properties).toEqual(expected.properties);
      expect(parsed.blocks).toEqual(expected.blocks);
    });

    it(`${slug}: round-trips to a stable tree`, () => {
      const text = readFileSync(join(corpusDir, mdFile), "utf8");
      const once = parseOutline(text);
      const twice = parseOutline(serializeOutline(once));
      expect(twice).toEqual(once);
    });
  }
});
