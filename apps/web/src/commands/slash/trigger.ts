/**
 * R53: the slash-menu trigger rule — pure functions only, so "fires at a text-run start, not
 * mid-word" is exhaustively unit-testable without any editor/DOM involvement. The editor calls
 * `matchSlashTrigger` on every document change at the caret's text-before-caret string to decide
 * whether to *open* the popup, and `computeSlashQuery` on every subsequent change (while it's
 * open) to decide whether it should stay open and what its live query is.
 */

export interface SlashMatch {
  /** Offset (into the block's content) where the triggering `/` sits. */
  from: number;
  /** The text typed after `/` so far (used for filtering, § R55). */
  query: string;
}

// `matchBefore(/(^|\s)\/([\w-]*)$/)`, applied to the text immediately before the caret.
const TRIGGER_RE = /(^|\s)\/([\w-]*)$/;

/**
 * `/` at the start of a text run: either the very first character of the block, or immediately
 * preceded by whitespace. `textBeforeCaret` is the block's content up to (not including) the
 * caret offset. Returns `null` for a mid-word `/` (`a/b` never opens it) or any text with no
 * trailing slash-run at all.
 */
export function matchSlashTrigger(textBeforeCaret: string): SlashMatch | null {
  const m = TRIGGER_RE.exec(textBeforeCaret);
  if (!m) return null;
  const query = m[2] ?? "";
  const slashIndexInMatch = m[0].indexOf("/");
  const from = m.index + slashIndexInMatch;
  return { from, query };
}

/**
 * Given an already-open popup's triggering offset `from` and the *current* text before the caret,
 * returns the live query, or `null` if the popup should now close.
 *
 * Two of R53's three close conditions are text-shape rules (Escape is a key event, handled by the
 * component, not here):
 * - "deleting back through the triggering `/`": the character at `from` is no longer `/` (either
 *   it was deleted, or the caret moved to/before that offset).
 * - "the query no longer matching `/[\w-]*` (e.g. a space is typed — the query cannot contain
 *   spaces because no slash-item label needs one)": a literal reading of `[\w-]*` would also
 *   reject the query `"/"` — reached by typing a second `/` right after the first — but R53's own
 *   very next clause says that specific case must NOT close the popup ("a second `/` typed
 *   immediately after the first (`//`) does not retrigger a new popup — the existing one, if
 *   open, simply has no matches and shows 'No results'"). Reconciling both sentences: what
 *   actually needs to be excluded is *whitespace* (R53's own stated reason — "no slash-item label
 *   needs one"), not every non-word character, so this checks for whitespace specifically rather
 *   than re-running the stricter open-trigger pattern.
 */
export function computeSlashQuery(textBeforeCaret: string, from: number): string | null {
  if (textBeforeCaret.length <= from || textBeforeCaret[from] !== "/") return null;
  const query = textBeforeCaret.slice(from + 1);
  if (/\s/.test(query)) return null;
  return query;
}
