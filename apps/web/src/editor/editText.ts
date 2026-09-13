/**
 * The editor's side of "a block's properties live in its editing buffer" (B-101).
 *
 * While a block is edited, the single CM6 surface holds its *editing text* — content with its
 * editable properties as `key:: value` lines (`@nooklet/core`'s `block-text.ts`) — and not the bare
 * content. `EditableBlock` keeps the two apart (`content` + `properties`), so everything that reads
 * the tree keeps working on content, and this file is the boundary:
 *
 * - into the buffer: `editTextOf` for the text, `caretInEditText` for a `CaretSpec` (commands and
 *   clicks compute offsets into content; the surface needs offsets into the buffer);
 * - out of the buffer: `withEditText` for the block the buffer now describes, `contentOffsetOf` for
 *   a buffer caret (a split at the caret divides the content, not the buffer).
 *
 * For a block without properties every one of these is the identity, which is what keeps the
 * overwhelmingly common case exactly as it was before.
 */
import {
  contentOffsetToEditText,
  editTextOffsetToContent,
  joinBlockText,
  samePropertySet,
  showsInEditText,
  splitBlockText,
} from "@nooklet/core";
import type { CaretSpec, EditableBlock } from "./types.js";

type TextFields = Pick<EditableBlock, "content" | "properties">;

/** The buffer text for a block. */
export function editTextOf(block: TextFields): string {
  // Property lines in key order, always. The worker reads `block_prop` in key order, but the
  // optimistic tree appends a restored key at the end — so an undo that brought `a:: 1` back used to
  // redraw the buffer with it below `b:: 2`, a shuffle the person never made.
  const sorted = Object.fromEntries(
    Object.entries(block.properties).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return joinBlockText(block.content, sorted);
}

/**
 * `block` as `text` describes it: content and editable properties from the text, and any property
 * the text could never show (`heading`, a multi-line value — `showsInEditText`) carried over
 * untouched. Returns `block` itself when nothing
 * moved, so a caller can compare by reference.
 */
export function withEditText<T extends TextFields>(block: T, text: string): T {
  // The block's own editing text describes the block as it is, even when splitting it would not
  // give the block back: a content line shaped like `foo:: bar` (written as `foo\:: bar`, OUT-23a)
  // is text in the block and a property line in the split. Splitting it here put `foo` into the
  // editor's tree as a property the database did not have — attaching the editor does this with
  // the untouched buffer — and the first keystroke's diff then saw no property to write and a
  // line to drop: the text line was deleted (B-474).
  if (text === editTextOf(block)) return block;
  const split = splitBlockText(text);
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(block.properties)) {
    if (!showsInEditText(key, value)) properties[key] = value;
  }
  Object.assign(properties, split.properties);
  if (split.content === block.content && samePropertySet(properties, block.properties)) {
    return block;
  }
  return { ...block, content: split.content, properties };
}

/** Whether the buffer and the block agree — ignoring the order property lines happen to be in. */
export function editTextMatches(block: TextFields, text: string): boolean {
  return withEditText(block, text) === block;
}

/**
 * A content-relative caret -> the same place in the block's buffer. `start`/`end` mean the start
 * and end of the *content*: "click after the text and type" should extend the text, not the value
 * of whichever property line happens to come last.
 */
export function caretInEditText(block: TextFields, caret: CaretSpec): CaretSpec {
  if ("goalX" in caret) return caret;
  const text = editTextOf(block);
  if (text === block.content) return caret;
  const offset = "offset" in caret ? caret.offset : caret.at === "start" ? 0 : block.content.length;
  return { offset: contentOffsetToEditText(text, offset) };
}

/** A caret in the buffer -> the same place in the content. */
export function contentOffsetOf(text: string, offset: number): number {
  return editTextOffsetToContent(text, offset);
}
