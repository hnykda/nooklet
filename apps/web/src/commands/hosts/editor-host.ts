/**
 * `EditorHost` — the narrow seam between commands/ and the editor (BUILD item 4/5): everything a
 * slash-menu item, an autocomplete-popup selection, or a delegated structural `block.*` command
 * needs from the mounted `Surface`, and nothing else. The editor package implements this
 * interface for real; this package only ever calls it, and ships `createFakeEditorHost()` (below)
 * so its own tests (slash menu, autocomplete, format/insert commands) never need a real
 * CodeMirror instance.
 *
 * Design notes for whoever wires this up:
 * - `getSelection()` is the ONLY read path. It always returns the focused block's *whole* logical
 *   content (not just the selected substring) plus the selection's offsets into it, so a caller
 *   that wants "the whole block" (e.g. `block.setHeading1` prefixing content) can ignore
 *   `start`/`end` and a caller that wants "the current selection" (e.g. `format.bold` toggling a
 *   wrap) can slice `content.slice(start, end)` itself. A collapsed caret has `start === end`.
 * - `replaceRange()` is the ONLY write path for text commands. `from`/`to` are offsets into the
 *   *same* logical content string `getSelection()` returned — commands/ never touches DOM ranges,
 *   CM6 positions, or line/column pairs.
 * - `runStructuralCommand()` is the escape hatch for the `Block` category (split, indent, outdent,
 *   merge, move, focus navigation, collapse, expand, zoom, block selection, duplicate, copyRef,
 *   copySelection) plus
 *   `edit.paste` and `block.insertImage` (needs `platform.files.pick` + asset upload, both outside
 *   this package's scope) — this package registers those ids (so the registry/keymap/palette see
 *   a complete command set, R1) but their `run()` is a one-line delegate to this method. The
 *   editor package supplies the real per-command behavior; `ctx` is forwarded unchanged.
 */

import type { CommandContext } from "../types.js";

export interface EditorSelection {
  blockId: string;
  /** The focused block's whole logical content (not just the selected substring). */
  content: string;
  /** Offsets into `content`. `start === end` for a collapsed caret. */
  start: number;
  end: number;
}

export interface ReplaceRangeSpec {
  /** Offsets into the focused block's current `content` (as returned by `getSelection()`). */
  from: number;
  to: number;
  text: string;
  /** Where the caret/selection lands after the replacement, relative to `from`. A plain number
   * collapses the caret there; `{ anchor, head }` leaves a selection (e.g. `format.bold` toggling
   * a wrap around a selection keeps that selection over the same inner text, not just a collapsed
   * caret at the end of it). Defaults to `text.length` (collapsed, right after the inserted
   * text). */
  caretOffset?: number | { anchor: number; head: number };
}

/** What `nav.followLink` (R43) needs to know about the token under/adjacent to the caret. */
export type LinkAtCaret =
  | { type: "page"; name: string }
  | { type: "tag"; name: string }
  | { type: "block"; id: string }
  | { type: "url"; href: string };

export interface EditorHost {
  /** The focused block's content + selection, or `null` when no `Surface` is mounted
   * (`!editorFocused`). Every text-mutating command in this package calls this first. */
  getSelection(): EditorSelection | null;

  /** Replace `[from, to)` of the focused block's content with `text` and move the caret. This is
   * the only way anything in `commands/` mutates editor text. */
  replaceRange(spec: ReplaceRangeSpec): void;

  /** Delegate a `Block`-category structural command (or `edit.paste` / `block.insertImage`) that
   * this package registers but does not implement. `id` is the command id being delegated (so one
   * editor-side handler can switch on it); `ctx` is the same `CommandContext` the command's own
   * `run()` received. */
  runStructuralCommand(id: string, ctx: CommandContext): void | Promise<void>;

  /** The wikilink/tag/blockref/URL token the caret is in or immediately adjacent to (R43's
   * `caretInLink`), or `null`. Only called by `nav.followLink`, whose `when` already requires
   * `caretInLink`, so a real editor need not implement this precisely for every other case. */
  getLinkAtCaret(): LinkAtCaret | null;
}

/** A working fake for this package's own tests: an in-memory single-block "document" that
 * records every `replaceRange`/`runStructuralCommand` call so a test can assert on them. */
export function createFakeEditorHost(initial?: Partial<EditorSelection>): EditorHost & {
  state: EditorSelection | null;
  structuralCalls: Array<{ id: string; ctx: CommandContext }>;
  linkAtCaret: LinkAtCaret | null;
} {
  let state: EditorSelection | null =
    initial === undefined
      ? { blockId: "b1", content: "", start: 0, end: 0 }
      : {
          blockId: initial.blockId ?? "b1",
          content: initial.content ?? "",
          start: initial.start ?? 0,
          end: initial.end ?? 0,
        };
  const structuralCalls: Array<{ id: string; ctx: CommandContext }> = [];
  let linkAtCaret: LinkAtCaret | null = null;

  return {
    get state() {
      return state;
    },
    set state(next) {
      state = next;
    },
    get linkAtCaret() {
      return linkAtCaret;
    },
    set linkAtCaret(next) {
      linkAtCaret = next;
    },
    structuralCalls,
    getSelection() {
      return state;
    },
    replaceRange(spec) {
      if (!state) return;
      const before = state.content.slice(0, spec.from);
      const after = state.content.slice(spec.to);
      const content = before + spec.text + after;
      const rel = spec.caretOffset ?? spec.text.length;
      const [start, end] =
        typeof rel === "number"
          ? [spec.from + rel, spec.from + rel]
          : [spec.from + rel.anchor, spec.from + rel.head];
      state = { blockId: state.blockId, content, start, end };
    },
    runStructuralCommand(id, ctx) {
      structuralCalls.push({ id, ctx });
    },
    getLinkAtCaret() {
      return linkAtCaret;
    },
  };
}
