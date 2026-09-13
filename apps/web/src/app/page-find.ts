/**
 * Find in page (audit §2 #16): the state shared by the `search.findInPage` command, the page view
 * that hosts the bar, and the bar itself (`views/PageFindBar.tsx`).
 *
 * Module-level signals, like `./context-menu.ts`, because the command runs in `CommandLayer` and
 * the bar lives inside `PageView`, which share no ancestor short of the app root.
 *
 * Only a page view registers as a host, and the command's `when` is `pageView` — so Cmd/Ctrl+F on
 * the journal stream, search, or any other view matches no binding and the browser's own find
 * runs, as before.
 */

import { createSignal } from "solid-js";
import type { EditorSelection } from "../commands/hosts/editor-host.js";
import { contentOffsetOf } from "../editor/editText.js";
import { requestBlockFocus, requestEditingEnd } from "../editor/focus-request.js";
import type { CaretSpec } from "../editor/types.js";

const [hostCount, setHostCount] = createSignal(0);
const [open, setOpen] = createSignal(false);
const [query, setQuery] = createSignal("");
const [focusTick, setFocusTick] = createSignal(0);

/** Where the caret was when the bar took the keyboard from the editor, for Escape to put back. */
let returnTo: { blockId: string; caret: CaretSpec } | null = null;

/** A page view calls this while mounted; the returned function unregisters it (and closes the bar
 * when the last host goes, so a stale bar never reappears on the next page). */
export function registerPageFindHost(): () => void {
  setHostCount((n) => n + 1);
  return () => {
    setHostCount((n) => n - 1);
    if (hostCount() === 0) closePageFind({ restoreFocus: false });
  };
}

/** Reactive: a page view is showing, so `search.findInPage` applies. The `pageView` when-key. */
export function pageFindAvailable(): boolean {
  return hostCount() > 0;
}

export const pageFindOpen = open;
export const pageFindQuery = query;
export const setPageFindQuery = setQuery;
/** Changes on every open request, including one while already open — the bar refocuses on it. */
export const pageFindFocusRequest = focusTick;

/**
 * Open the bar (or refocus it) and take the keyboard from the outline.
 *
 * `editing` is the editor's selection at the moment of the request, if a block was being edited.
 * Editing is ended rather than left running behind the bar: a tree that is still editing keeps
 * publishing `editorFocused`, and the keymap would then run block commands for keys typed into
 * the find input (`../editor/focus-request.ts#requestEditingEnd`).
 *
 * The caret is saved as an offset into the block's CONTENT. `editing` comes from the editor host,
 * whose text and offsets are the editing buffer — content plus property lines (B-101) — while a
 * focus request's caret is a content caret the tree maps into its buffer itself. Saved as-is, a
 * caret below a `list:: number` line came back that line's length further along (B-361).
 */
export function openPageFind(editing: EditorSelection | null): void {
  if (!pageFindAvailable()) return;
  if (editing) {
    const offset = contentOffsetOf(editing.content, editing.end);
    returnTo = { blockId: editing.blockId, caret: { offset } };
  } else if (!open()) returnTo = null;
  setOpen(true);
  setFocusTick((n) => n + 1);
  requestEditingEnd();
}

/**
 * Close the bar; the outline goes back to exactly what it was (the filter never wrote anything).
 * The query is kept, like a browser's find, and comes back selected on the next open.
 * `restoreFocus` puts the caret back where it was when the bar opened, if it was in a block.
 */
export function closePageFind(opts: { restoreFocus: boolean }): void {
  const target = returnTo;
  returnTo = null;
  if (!open()) return;
  setOpen(false);
  if (opts.restoreFocus && target) requestBlockFocus(target.blockId, target.caret);
}
