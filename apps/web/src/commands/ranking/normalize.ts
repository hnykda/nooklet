/** R70: query/candidate normalization applied everywhere fuzzysort is used, so diacritics fold
 * the same way the server's `unicode61`-with-diacritics-removed FTS tokenizer does (`č` -> `c`).
 * NFD splits `č` into `c` + a combining caron (U+030C); the regex strips every codepoint in the
 * U+0300-U+036F "Combining Diacritical Marks" block, written as an explicit `\u{...}` escape range
 * (rather than the literal combining glyphs the spec's prose uses) so the source stays unambiguous
 * in every editor/font. */
const COMBINING_DIACRITICS_START = 0x0300;
const COMBINING_DIACRITICS_END = 0x036f;
const COMBINING_DIACRITICS = new RegExp(
  `[\\u${COMBINING_DIACRITICS_START.toString(16).padStart(4, "0")}-\\u${COMBINING_DIACRITICS_END.toString(16).padStart(4, "0")}]`,
  "g",
);

export function normalizeForMatch(s: string): string {
  return s.normalize("NFD").replace(COMBINING_DIACRITICS, "").toLowerCase();
}
