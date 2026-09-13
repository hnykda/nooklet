/**
 * One block's *editing text*: its `content` with its properties written back in as `key:: value`
 * lines — what an editor shows while a block is being edited (Logseq's raw edit mode), and how
 * that text is split back into content + properties when the edit is written
 * (`docs/spec/markdown-grammar.md` §2.4, "Editing text", OUT-22a).
 *
 * Why this exists: the web editor used to put `content` alone into its buffer and write the buffer
 * back verbatim as `block.text`. A block's properties were therefore invisible while editing, and
 * a `key:: value` line typed there (or inserted by `/property`) became literal content that never
 * reached `block_prop` — while the very same text imported from a file, or sent through
 * `block.update`, IS a property (B-101). Splitting here with the outline parser's own line rules
 * (`outline.ts`'s `PROPERTY_LINE_RE`, key normalization, fence tracking) keeps all three writers in
 * agreement about what a property line is.
 *
 * Deliberately NOT trimmed the way `parseOutline` trims a finished file: this runs on text being
 * typed, where a trailing space or an empty last line is the user's next keystroke, not noise.
 *
 * Pure and platform-free, like the rest of core.
 */

import type { Properties } from "./model.js";
import { RESERVED_BLOCK_PROPS } from "./ops.js";
import {
  closesCodeFence,
  normalizePropertyKey,
  openingCodeFence,
  PROPERTY_LINE_RE,
} from "./outline.js";

/**
 * Whether a `key:: value` line with this (normalized) key is split out as a property in editing
 * text. The reserved keys are not: `id`/`collapsed`/`marker`/`priority` have their own syntax or
 * UI, and `scheduled`/`deadline`/`repeat`/`done` live in typed columns whose writes the reducer
 * validates — splitting them out of half-typed text (`scheduled:: 2026-0`) would mint rejected ops
 * on every pause. `heading` is folded into a `#` prefix by the parser (OUT-25), never stored. Those
 * lines stay ordinary content text, exactly as they were before this module existed.
 */
export function isEditTextProperty(key: string): boolean {
  return key !== "heading" && !RESERVED_BLOCK_PROPS.has(key);
}

/**
 * Whether property `key` = `value` is written into editing text as a `key:: value` line: only when
 * that line reads back as exactly this property. Keys that `isEditTextProperty` excludes never are;
 * neither is a value with a line break (its tail would be split off as content), a value with
 * leading or trailing whitespace (the split trims it), or a key the line regex cannot read back
 * (an imported `_foo` is stored as `-foo`). `block.update` accepts any string as a value, so an
 * agent can write such a property; putting it into the buffer made the first keystroke move
 * its tail into the block's text (B-152). Such a property stays out of the buffer, and so out of
 * the diff, exactly like `heading`.
 */
export function showsInEditText(key: string, value: string): boolean {
  if (!isEditTextProperty(key)) return false;
  const m = PROPERTY_LINE_RE.exec(`${key}:: ${value}`);
  return (
    m !== null && normalizePropertyKey(m[1] as string) === key && (m[2] as string).trim() === value
  );
}

interface TextLine {
  text: string;
  /** Offset of the line's first character in the whole text. */
  start: number;
  property: { key: string; value: string } | null;
}

function classifyLines(text: string): TextLine[] {
  const out: TextLine[] = [];
  let fence: string | null = null;
  let start = 0;
  for (const line of text.split("\n")) {
    let property: TextLine["property"] = null;
    if (fence !== null) {
      // Inside a fence nothing is a property — the same rule `finalizeNode` applies.
      if (closesCodeFence(line, fence)) fence = null;
    } else {
      const m = PROPERTY_LINE_RE.exec(line);
      const key = m ? normalizePropertyKey(m[1] as string) : null;
      if (m && key !== null && isEditTextProperty(key)) {
        property = { key, value: (m[2] as string).trim() };
      } else {
        fence = openingCodeFence(line);
      }
    }
    out.push({ text: line, start, property });
    start += line.length + 1;
  }
  return out;
}

export interface SplitBlockText {
  content: string;
  /** Editable properties only (`isEditTextProperty`); a repeated key's last line wins. */
  properties: Properties;
}

/** Editing text -> `{content, properties}`. Every property line is removed from the content,
 * wherever it sits outside a fence (the parser's rule, not only the canonical "after line 1"). */
export function splitBlockText(text: string): SplitBlockText {
  const properties: Properties = {};
  const kept: string[] = [];
  for (const line of classifyLines(text)) {
    if (line.property) properties[line.property.key] = line.property.value;
    else kept.push(line.text);
  }
  return { content: kept.join("\n"), properties };
}

/**
 * `{content, properties}` -> editing text: line 1, then one `key:: value` line per editable
 * property, then the rest of the content — the canonical file shape (OUT-18).
 *
 * A content that OPENS with a fence cannot take property lines after line 1 (they would be inside
 * the fence and re-read as code — the serializer has exactly that bug, B-151). Those go after the
 * closed fence instead, or, for a fence that never closes, before line 1. Whatever the placement,
 * `splitBlockText(joinBlockText(c, p))` gives back `c` and `p`, as long as `c` has no editable
 * property line of its own — and when it does (literal text written before B-101 was fixed), the
 * split promotes that line to a property, which is what the same text in a file would have meant.
 */
export function joinBlockText(content: string, properties: Readonly<Properties>): string {
  const editable = Object.fromEntries(
    Object.entries(properties).filter(([key, value]) => showsInEditText(key, value)),
  );
  const lines = Object.entries(editable).map(([key, value]) => `${key}:: ${value}`);
  if (lines.length === 0) return content;
  const props = lines.join("\n");
  // An empty content still gets its (empty) line 1. Without it the caret of a fresh block — a new
  // numbered item after Enter — sits at the start of `list:: number`, and the first word typed
  // lands inside the property line instead of before it.
  if (content === "") return `\n${props}`;

  const nl = content.indexOf("\n");
  const first = nl === -1 ? content : content.slice(0, nl);
  if (openingCodeFence(first) === null) {
    return `${first}\n${props}${nl === -1 ? "" : content.slice(nl)}`;
  }
  const after = `${content}\n${props}`;
  const back = splitBlockText(after);
  return back.content === content && samePropertySet(back.properties, editable)
    ? after
    : `${props}\n${content}`;
}

/**
 * A caret offset in editing text -> the same place in the content. An offset inside a property
 * line maps to the end of the content line before it (or 0): that is where a split at that caret
 * would divide the content.
 */
export function editTextOffsetToContent(text: string, offset: number): number {
  let end = 0;
  let seen = false;
  for (const line of classifyLines(text)) {
    const lineEnd = line.start + line.text.length;
    if (line.property) {
      if (offset <= lineEnd) return end;
      continue;
    }
    const start = seen ? end + 1 : 0;
    seen = true;
    if (offset <= lineEnd) return start + Math.max(0, offset - line.start);
    end = start + line.text.length;
  }
  return end;
}

/** A content offset -> the same place in editing text built from that content. */
export function contentOffsetToEditText(text: string, offset: number): number {
  let end = 0;
  let seen = false;
  let lastLineEnd = 0;
  for (const line of classifyLines(text)) {
    if (line.property) continue;
    const start = seen ? end + 1 : 0;
    seen = true;
    if (offset <= start + line.text.length) return line.start + Math.max(0, offset - start);
    end = start + line.text.length;
    lastLineEnd = line.start + line.text.length;
  }
  return lastLineEnd;
}

/** Same keys, same values — insertion order ignored (`block_prop` has no order). */
export function samePropertySet(a: Readonly<Properties>, b: Readonly<Properties>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && b[k] === a[k]);
}

export type BlockTextPayload =
  | { kind: "block.text"; content: string }
  | { kind: "block.prop"; key: string; value: string | null };

/**
 * What writing `text` over a block that was `before` takes: a `block.text` when the content moved,
 * and one `block.prop` per editable key whose value moved (`null` for a line that was removed).
 *
 * Diffed against `before` — the block as it was when this edit began — and never against the
 * store's live properties, so a property another device or an agent set in the meantime is not
 * deleted just because this buffer never saw it. Properties of `before` the text could not show
 * (`showsInEditText`) are ignored: they were never in the text, so their absence says nothing.
 */
export function blockTextPayloads(
  before: { content: string; properties: Readonly<Properties> },
  text: string,
): BlockTextPayload[] {
  const next = splitBlockText(text);
  const out: BlockTextPayload[] = [];
  if (next.content !== before.content) out.push({ kind: "block.text", content: next.content });
  for (const [key, value] of Object.entries(before.properties)) {
    if (showsInEditText(key, value) && !Object.hasOwn(next.properties, key)) {
      out.push({ kind: "block.prop", key, value: null });
    }
  }
  for (const [key, value] of Object.entries(next.properties)) {
    if (before.properties[key] !== value) out.push({ kind: "block.prop", key, value });
  }
  return out;
}
