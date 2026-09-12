/**
 * R48-R49: pure text-transformation logic for the slash-menu-only `Insert` commands, independent
 * of `EditorHost` so it's exhaustively unit-testable.
 */
import type { ReplaceRangeSpec } from "../hosts/editor-host.js";

const HEADING_MARKER_RE = /^#{1,6} /;

/** R48: prefix with `#`/`##`/`###` + space, replacing any existing leading heading-marker run of
 * 1-6 `#`s (so re-applying a different level changes it rather than stacking markers). */
export function setHeading(content: string, level: 1 | 2 | 3): ReplaceRangeSpec {
  const stripped = content.replace(HEADING_MARKER_RE, "");
  const prefix = `${"#".repeat(level)} `;
  const text = prefix + stripped;
  return { from: 0, to: content.length, text, caretOffset: text.length };
}

/** R48: a two-line fence skeleton (empty middle line) when the block is empty, or the current
 * content wrapped in a fence otherwise. */
export function insertCodeFence(content: string): ReplaceRangeSpec {
  if (content === "") {
    const text = "```\n\n```";
    return { from: 0, to: 0, text, caretOffset: 4 }; // caret on the empty middle line
  }
  const text = `\`\`\`\n${content}\n\`\`\``;
  return { from: 0, to: content.length, text, caretOffset: text.length };
}

/** M7 (ADR 011): a ```` ```query ```` fence skeleton. Whatever the block already says becomes the
 * query — typing `TODO #work` and then `/query` is the natural order — with the caret at the end
 * of that line; an empty block gets an empty query line to type into. */
export function insertQueryFence(content: string): ReplaceRangeSpec {
  const query = content.trim();
  const head = "```query\n";
  const text = `${head}${query}\n\`\`\``;
  return { from: 0, to: content.length, text, caretOffset: head.length + query.length };
}

/** R48: a 2x2 GitHub-flavored-markdown table skeleton (header row + separator + one body row). */
export function insertTable(): ReplaceRangeSpec {
  const text = "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |";
  return { from: 0, to: 0, text, caretOffset: 2 }; // right after "| ", ready to type the header
}

/** R49: `{{embed [[Page]]}}`, pre-filled with `query` (empty when invoked with no target yet
 * selected), caret positioned right after the query so continuing to type re-triggers the same
 * page-fuzzy-match affordance as `[[` (§ autocomplete). */
export function embedPage(start: number, end: number, query = ""): ReplaceRangeSpec {
  const text = `{{embed [[${query}]]}}`;
  return { from: start, to: end, text, caretOffset: "{{embed [[".length + query.length };
}

/** R49: `{{embed ((id))}}` via the same block-ref search as `((`. */
export function embedBlock(start: number, end: number, query = ""): ReplaceRangeSpec {
  const text = `{{embed ((${query}))}}`;
  return { from: start, to: end, text, caretOffset: "{{embed ((".length + query.length };
}

/** R49: a `[[<journal title>]]` wikilink resolving to today's journal, written in the reader's
 * chosen display format rather than the ISO name the page is stored under (ADR 018) — every
 * recognised format resolves to the same page, so the text can read the way a person writes. */
export function insertToday(start: number, end: number, journalTitle: string): ReplaceRangeSpec {
  const text = `[[${journalTitle}]]`;
  return { from: start, to: end, text, caretOffset: text.length };
}

/** R49: a `key:: ` property line. The parser only recognizes a contiguous property-line run at
 * the very start or very end of the block's content (research 04 §4.2) — this inserts at the end,
 * on its own line, which is always valid regardless of the block's current shape. */
export function insertProperty(content: string, key: string): ReplaceRangeSpec {
  const needsNewline = content.length > 0 && !content.endsWith("\n");
  const prefix = needsNewline ? "\n" : "";
  const text = `${prefix}${key}:: `;
  return { from: content.length, to: content.length, text, caretOffset: text.length };
}
