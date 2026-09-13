/**
 * R56-R58: trigger rules for the three autocomplete popups. Pure, editor-agnostic — mirrors
 * `slash/trigger.ts`'s shape (`match*` decides whether to open; `compute*Query` decides whether an
 * already-open popup should stay open and what its live query is).
 */

export interface AutocompleteMatch {
  /** Offset of the FIRST trigger character (e.g. the first `[` of `[[`). */
  from: number;
  query: string;
}

// R56: `matchBefore(/\[\[([^\]\n]*)$/)`.
const PAGE_REF_RE = /\[\[([^\]\n]*)$/;
// R57: `matchBefore(/(^|\s)#([^\s#]*)$/)` — start-of-run, like the slash trigger.
const TAG_RE = /(^|\s)#([^\s#]*)$/;
// R58: `matchBefore(/\(\(([^)\n]*)$/)`.
const BLOCK_REF_RE = /\(\(([^)\n]*)$/;

export function matchPageRefTrigger(textBeforeCaret: string): AutocompleteMatch | null {
  const m = PAGE_REF_RE.exec(textBeforeCaret);
  if (!m) return null;
  return { from: m.index, query: m[1] ?? "" };
}

export function matchTagTrigger(textBeforeCaret: string): AutocompleteMatch | null {
  const m = TAG_RE.exec(textBeforeCaret);
  if (!m) return null;
  const hashIndexInMatch = m[0].indexOf("#");
  return { from: m.index + hashIndexInMatch, query: m[2] ?? "" };
}

export function matchBlockRefTrigger(textBeforeCaret: string): AutocompleteMatch | null {
  const m = BLOCK_REF_RE.exec(textBeforeCaret);
  if (!m) return null;
  return { from: m.index, query: m[1] ?? "" };
}

/**
 * How many characters after the caret belong to the `[[link]]` (or `((ref))`) the caret sits inside,
 * closing delimiter included — 0 when the text after the caret does not close one.
 *
 * Walking the caret into an existing link re-detects the `[[` before it and opens the autocomplete
 * (B-203). A pick replaced only the query — trigger to caret — and left the rest of the old link
 * behind the new one: `[[Target]]arget]]` (B-294). The replaced range has to run to the link's own
 * closer. The tail may not contain an opener, so a `[[` typed straight before another link
 * (`[[|[[Other]]`) does not swallow that link.
 *
 * Not for `#tags`: a tag has no closer, so "the caret is inside an existing tag" cannot be told
 * apart from "`#` typed straight before a word" — B-380.
 */
export function existingRefTailLength(textAfterCaret: string, closer: "]]" | "))"): number {
  const m = (closer === "]]" ? PAGE_REF_TAIL_RE : BLOCK_REF_TAIL_RE).exec(textAfterCaret);
  return m ? m[0].length : 0;
}

const PAGE_REF_TAIL_RE = /^[^[\]\n]*\]\]/;
const BLOCK_REF_TAIL_RE = /^[^()\n]*\)\)/;

/** Shared dismiss/live-query logic for all three popups: `triggerLength` is 2 for `[[`/`((`
 * (their opening delimiter is two characters) and 1 for `#`. A popup closes when its opening
 * delimiter no longer sits at `from` (deleted back through it) or when the query now contains a
 * character the corresponding trigger regex's query class excludes (R56/R58: a `]`/`)`/newline;
 * R57: whitespace or another `#`) — checked directly against the live text rather than re-running
 * the open-trigger regex, for the same reason `slash/trigger.ts#computeSlashQuery` doesn't: only
 * the *first* character(s) need to still be the delimiter, not the whole remaining text.
 */
function computeQuery(
  textBeforeCaret: string,
  from: number,
  triggerLength: number,
  delimiterOk: (s: string) => boolean,
  queryCharOk: (ch: string) => boolean,
): string | null {
  if (textBeforeCaret.length < from + triggerLength) return null;
  const delimiter = textBeforeCaret.slice(from, from + triggerLength);
  if (!delimiterOk(delimiter)) return null;
  const query = textBeforeCaret.slice(from + triggerLength);
  for (const ch of query) {
    if (!queryCharOk(ch)) return null;
  }
  return query;
}

export function computePageRefQuery(textBeforeCaret: string, from: number): string | null {
  return computeQuery(
    textBeforeCaret,
    from,
    2,
    (d) => d === "[[",
    (ch) => ch !== "]" && ch !== "\n",
  );
}

export function computeTagQuery(textBeforeCaret: string, from: number): string | null {
  return computeQuery(
    textBeforeCaret,
    from,
    1,
    (d) => d === "#",
    (ch) => ch !== "#" && !/\s/.test(ch),
  );
}

export function computeBlockRefQuery(textBeforeCaret: string, from: number): string | null {
  return computeQuery(
    textBeforeCaret,
    from,
    2,
    (d) => d === "((",
    (ch) => ch !== ")" && ch !== "\n",
  );
}
