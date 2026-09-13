/**
 * "Put the caret in this block, once it exists."
 *
 * A module-level request rather than a prop, because the component that *asks* is routinely not
 * the component that can *answer*. Creating the first block of a new journal day is the case that
 * forced this: `VirtualJournalDay` mints the block and then unmounts, because the journal stream
 * sees a real page appear and swaps in its own `BlockTree`. A prop on the old tree dies with it,
 * so Enter committed the text and left you with no cursor anywhere.
 *
 * Whichever `BlockTree` turns out to contain the block claims the request and clears it, so it is
 * consumed exactly once no matter how many trees are on screen (the journal stream renders one
 * per day).
 */

import { createSignal } from "solid-js";
import type { CaretSpec } from "./types.js";

const [request, setRequest] = createSignal<string | undefined>(undefined);
let requestedCaret: CaretSpec | undefined;

/** Ask for the caret to land in `blockId` as soon as some tree can render it — at `caret`, or at
 * the end of the block when none is given. */
export function requestBlockFocus(blockId: string, caret?: CaretSpec): void {
  requestedCaret = caret;
  setRequest(blockId);
}

/** The outstanding request, if any. */
export const blockFocusRequest = request;

/** Where the outstanding request wants the caret; `undefined` means the end. Not a signal: it is
 * read together with `blockFocusRequest()`, which is. */
export function blockFocusCaret(): CaretSpec | undefined {
  return requestedCaret;
}

/** Called by the tree that took it. */
export function clearBlockFocusRequest(): void {
  requestedCaret = undefined;
  setRequest(undefined);
}

/**
 * "Stop editing, wherever that is": every `BlockTree` ends its editing session (flushing what was
 * typed) and drops its block selection when this is called.
 *
 * For a control outside the outline that takes the keyboard without a click — the find-in-page
 * bar opened by Cmd/Ctrl+F. A click already ends editing (B-74); a keyboard focus change does not,
 * and a tree still editing keeps publishing `editorFocused`, so Enter typed into that control ran
 * `block.split` on the block the caret had left.
 */
const [endEditingTick, setEndEditingTick] = createSignal(0);

export function requestEditingEnd(): void {
  setEndEditingTick((n) => n + 1);
}

/** Reactive; changes on every `requestEditingEnd()`. */
export const editingEndRequest = endEditingTick;
