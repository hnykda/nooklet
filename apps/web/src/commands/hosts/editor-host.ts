/**
 * `EditorHost` — the narrow seam between commands/ and the editor (BUILD item 4/5): everything a
 * slash-menu item, an autocomplete-popup selection, or a delegated structural `block.*` command
 * needs from the mounted `Surface`, and nothing else. The editor package implements this
 * interface for real; this package only ever calls it, and ships `createFakeEditorHost()` (below)
 * so its own tests (slash menu, autocomplete, format/insert commands) never need a real
 * CodeMirror instance.
 *
 * Design notes for whoever wires this up:
 * - `getSelection()` is the ONLY read path. It always returns the focused block's *whole* editing
 *   text (not just the selected substring) plus the selection's offsets into it, so a caller that
 *   wants "the whole block" (e.g. `block.setHeading1` prefixing content) can ignore `start`/`end`
 *   and a caller that wants "the current selection" (e.g. `format.bold` toggling a wrap) can slice
 *   `content.slice(start, end)` itself. A collapsed caret has `start === end`.
 * - The editing text is NOT the block's content (B-101, B-371): it is the editor's buffer, the
 *   content followed by the block's editable properties as `key:: value` lines, and the offsets are
 *   offsets into that buffer. For a block without properties the two are the same string, which is
 *   exactly why treating one as the other passes a quick test and then breaks on a real block
 *   (B-361). A caller that needs the content itself splits the buffer with `splitBlockText`, as
 *   `registrations/insert-logic.ts` and `registrations/templates.ts` do; `../../editor/editText.ts`
 *   is the boundary and explains it.
 * - `replaceRange()` is the ONLY write path for text commands. `from`/`to` are offsets into the
 *   *same* editing text `getSelection()` returned — commands/ never touches DOM ranges, CM6
 *   positions, or line/column pairs.
 * - `runStructuralCommand()` is the escape hatch for the `Block` category (split, indent, outdent,
 *   merge, move, focus navigation, collapse, expand, zoom, block selection, duplicate, copyRef,
 *   copySelection) plus
 *   `edit.paste` and `block.insertImage` (needs `platform.files.pick` + asset upload, both outside
 *   this package's scope) — this package registers those ids (so the registry/keymap/palette see
 *   a complete command set, R1) but their `run()` is a one-line delegate to this method. The
 *   editor package supplies the real per-command behavior; `ctx` is forwarded unchanged.
 * - `commitOps()` is for a command that builds its ops itself (from data the editor does not hold,
 *   like `/template`'s copy of another page's subtree) but whose result belongs in the editor's
 *   undo history. Writing them with `applyOps` directly is not the same thing: the history only
 *   sees what the tree commits, so Cmd/Ctrl+Z could not take them back (B-108).
 */

import type { Op } from "@nooklet/core";
import type { CommandContext } from "../types.js";

export interface EditorSelection {
  blockId: string;
  /** The focused block's whole editing text — its content, then its editable properties as
   * `key:: value` lines (B-101) — not just the selected substring, and not the bare content. The
   * field keeps its old name; `editor/editText.ts` is where the two are told apart. */
  content: string;
  /** Offsets into that editing text. `start === end` for a collapsed caret. */
  start: number;
  end: number;
}

export interface ReplaceRangeSpec {
  /** Offsets into the focused block's current editing text (`getSelection().content`). */
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

/** A batch of ops a command built, for the editor to commit as ONE undo step (`commitOps`). */
export interface OpBatch {
  /** Minted but NOT yet applied. The editor re-mints them with its own clock when it commits. */
  ops: Op[];
  /** A block that exists before the batch — the one the command acted on. Only the editor showing
   * it may commit the batch; a batch it cannot place is refused, never half-applied. */
  anchorId: string;
  /** Where the caret goes afterwards: `"end"` or an offset into that block's content. Omitted: it
   * stays where it is. */
  focus?: { blockId: string; caret: number | "end" };
}

/** What `nav.followLink` (R43) needs to know about the token under/adjacent to the caret. */
export type LinkAtCaret =
  | { type: "page"; name: string }
  | { type: "tag"; name: string }
  | { type: "block"; id: string }
  | { type: "url"; href: string };

export interface EditorHost {
  /** The focused block's editing text + selection, or `null` when no `Surface` is mounted
   * (`!editorFocused`). Every text-mutating command in this package calls this first. */
  getSelection(): EditorSelection | null;

  /** Replace `[from, to)` of the focused block's editing text with `text` and move the caret. This
   * is the only way anything in `commands/` mutates editor text. */
  replaceRange(spec: ReplaceRangeSpec): void;

  /** Delegate a `Block`-category structural command (or `edit.paste` / `block.insertImage`) that
   * this package registers but does not implement. `id` is the command id being delegated (so one
   * editor-side handler can switch on it); `ctx` is the same `CommandContext` the command's own
   * `run()` received. */
  runStructuralCommand(id: string, ctx: CommandContext): void | Promise<void>;

  /** Apply `batch` through the editor that shows `batch.anchorId`, as one step of its undo history.
   * `false` — nothing applied — when no mounted editor shows that block; the caller then writes the
   * ops itself (`applyOps`), which is still correct, just not undoable with Cmd/Ctrl+Z. */
  commitOps(batch: OpBatch): boolean;

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
  /** Every `commitOps` batch, accepted or not. */
  committed: OpBatch[];
  /** What `commitOps` answers; `true` by default (an editor shows the anchor). */
  acceptCommits: boolean;
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
  const committed: OpBatch[] = [];
  let acceptCommits = true;
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
    get acceptCommits() {
      return acceptCommits;
    },
    set acceptCommits(next) {
      acceptCommits = next;
    },
    structuralCalls,
    committed,
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
    commitOps(batch) {
      committed.push(batch);
      return acceptCommits;
    },
    getLinkAtCaret() {
      return linkAtCaret;
    },
  };
}
