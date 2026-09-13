/**
 * Who gets Escape / Enter / Tab / ArrowUp / ArrowDown while a popup is open.
 *
 * R12 step 2 says the autocomplete and slash popups own those keys while they are open, and both
 * key resolvers already honour it: `keydown.ts#resolveCommand` and `keymap/dispatch.ts` return
 * "not mine" for them when `ctx.popupOpen` is true. What was missing was any way for either to
 * KNOW a popup was open — both contexts hard-coded `popupOpen: false` — and any way for the key to
 * then reach the popup, whose `onKeyDown` sat on an element that never had focus (the editor
 * keeps it). So ArrowDown scrolled the block, Enter split it, Escape dropped it into selection
 * mode, and the popup only ever closed as a side effect of the editor being torn down (B-65).
 *
 * The popup registers a handler here while it has a trigger; the editor's keymap asks first.
 * Module-level and Solid-reactive, like `../app/editor-host.ts`, because the popup and the editor
 * are siblings that share no ancestor short of the app root.
 */

import { createSignal } from "solid-js";

export type PopupKeyHandler = (key: string) => boolean;

export const POPUP_OWNED_KEYS: ReadonlySet<string> = new Set([
  "Escape",
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "Tab",
]);

export interface PopupKeyClaim {
  /**
   * The popup gets its keys from the editor (`BlockTree#dispatchKey` → `dispatchPopupKey`), which
   * offers it only keys WITHOUT Cmd/Ctrl/Alt — the autocomplete and the slash menu. A modified
   * Enter/Tab/arrow is then not the popup's, and the keymap must not hold it back for the popup:
   * it did, so Alt+Enter on a link the caret had walked into (which opens the `[[` autocomplete)
   * went to nobody (B-203). Leave it unset for an overlay whose own focused input receives every
   * key (the palette, the page picker): there, yielding modified keys is what keeps Cmd/Ctrl+Enter
   * or Alt+Up typed into the input from running against the block behind it.
   */
  editorFed?: boolean;
}

const [claim, setClaim] = createSignal<{ fn: PopupKeyHandler; editorFed: boolean } | null>(null);

/** Reactive: true while some popup has claimed the keys. Read by both dispatch contexts. */
export function isPopupOpen(): boolean {
  return claim() !== null;
}

/** Claim the popup keys. Returns the release function; call it when the popup closes. Only one
 * popup is ever open at a time (CommandLayer renders at most one), so the latest claim wins. */
export function claimPopupKeys(fn: PopupKeyHandler, options: PopupKeyClaim = {}): () => void {
  const entry = { fn, editorFed: options.editorFed ?? false };
  setClaim(() => entry);
  return () => {
    if (claim() === entry) setClaim(null);
  };
}

/** Is this keydown the open popup's to take (so the keymap must leave it alone)? False when no
 * popup is open. */
export function popupTakesKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
): boolean {
  const current = claim();
  if (!current || !POPUP_OWNED_KEYS.has(e.key)) return false;
  return !current.editorFed || !(e.metaKey || e.ctrlKey || e.altKey);
}

/** Offer a key to the open popup. `true` means it was consumed and must go no further. */
export function dispatchPopupKey(key: string): boolean {
  const current = claim();
  if (!current || !POPUP_OWNED_KEYS.has(key)) return false;
  return current.fn(key);
}
