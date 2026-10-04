/**
 * R48-R49: pure text-transformation logic for the slash-menu-only `Insert` commands, independent
 * of `EditorHost` so it's exhaustively unit-testable.
 */
import {
  contentOffsetToEditText,
  joinBlockText,
  openingCodeFence,
  PROPERTY_LINE_RE,
  splitBlockText,
} from "@nooklet/core";
import type { ReplaceRangeSpec } from "../hosts/editor-host.js";

/**
 * `transform` — written against a block's plain content — applied to the content part of its
 * *editing text* only (B-153). Since B-101 the editor host's content is the editing text: content
 * plus `key:: value` lines. A command that rewrites the whole block would otherwise take those
 * lines with it: `/code` wrapped `list:: number` into the fence (where it is code, so the numbering
 * was deleted on flush), `/query` made `owner:: Dan` the query, and `/h1` put the caret at the end
 * of the buffer, the end of the last property line, so the next word typed went into its value.
 * The property lines are written back in their canonical place (`joinBlockText`) and the caret is
 * mapped from content into the new text. A text with no property lines is passed straight through.
 */
export function onContent(
  text: string,
  transform: (content: string) => ReplaceRangeSpec,
): ReplaceRangeSpec {
  const { content, properties } = splitBlockText(text);
  if (Object.keys(properties).length === 0) return transform(text);
  const r = transform(content);
  const next = content.slice(0, r.from) + r.text + content.slice(r.to);
  const rel = r.caretOffset ?? r.text.length;
  const caret = r.from + (typeof rel === "number" ? rel : rel.head);
  const joined = joinBlockText(next, properties);
  return {
    from: 0,
    to: text.length,
    text: joined,
    caretOffset: contentOffsetToEditText(joined, caret),
  };
}

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

/**
 * R49: a property line, in the block's editing text — which, since B-101, is written back as a
 * real property when the edit flushes (`@nooklet/core`'s `block-text.ts`), not as literal text.
 *
 * Where: right under line 1 and any property lines already there, the shape a markdown file has
 * (OUT-18) and the shape the buffer is built in, so the new line joins the others instead of
 * landing below a paragraph. A block that opens with a code fence takes it after the fence (inside,
 * it would be code). A trailing empty line — Shift+Enter then `/property` — is filled, not doubled.
 *
 * With no `key` the line is `:: ` and the caret sits before it: type the key, End, type the value.
 * A placeholder key would be written as a real (junk) property at the first typing pause, and
 * selecting it for overtyping needs a selection the editor host collapses. `:: ` alone is not a
 * property line, so nothing is written until there is a key.
 */
export function insertProperty(content: string, key = ""): ReplaceRangeSpec {
  const lines = content.split("\n");
  let from = content.length;
  let newline = content.length > 0 && !content.endsWith("\n");
  if (content !== "" && openingCodeFence(lines[0] ?? "") === null) {
    let i = 1;
    while (i < lines.length && PROPERTY_LINE_RE.test(lines[i] as string)) i++;
    const runEnd = lines.slice(0, i).join("\n").length;
    const fillsTrailingEmptyLine = i === lines.length - 1 && lines[i] === "";
    from = fillsTrailingEmptyLine ? runEnd + 1 : runEnd;
    newline = !fillsTrailingEmptyLine;
  }
  const prefix = newline ? "\n" : "";
  const text = `${prefix}${key}:: `;
  return {
    from,
    to: from,
    text,
    caretOffset: key === "" ? prefix.length : text.length,
  };
}

/**
 * R50 (B-646): the `/` the toolbar's slash button types. The slash menu opens on a `/` at the
 * start of a text run — the block's start or after whitespace (`../slash/trigger.ts`) — so mid-word
 * a space goes first; otherwise the button typed a `/` that opened nothing. A selection is
 * replaced, as typing would.
 */
export function insertSlash(content: string, start: number, end: number): ReplaceRangeSpec {
  const before = content.slice(0, start);
  const text = before === "" || /\s$/.test(before) ? "/" : " /";
  return { from: start, to: end, text, caretOffset: text.length };
}
