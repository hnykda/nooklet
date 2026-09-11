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

const [request, setRequest] = createSignal<string | undefined>(undefined);

/** Ask for the caret to land in `blockId` as soon as some tree can render it. */
export function requestBlockFocus(blockId: string): void {
  setRequest(blockId);
}

/** The outstanding request, if any. */
export const blockFocusRequest = request;

/** Called by the tree that took it. */
export function clearBlockFocusRequest(): void {
  setRequest(undefined);
}
