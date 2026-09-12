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

const [handler, setHandler] = createSignal<PopupKeyHandler | null>(null);

/** Reactive: true while some popup has claimed the keys. Read by both dispatch contexts. */
export function isPopupOpen(): boolean {
  return handler() !== null;
}

/** Claim the popup keys. Returns the release function; call it when the popup closes. Only one
 * popup is ever open at a time (CommandLayer renders at most one), so the latest claim wins. */
export function claimPopupKeys(fn: PopupKeyHandler): () => void {
  setHandler(() => fn);
  return () => {
    if (handler() === fn) setHandler(null);
  };
}

/** Offer a key to the open popup. `true` means it was consumed and must go no further. */
export function dispatchPopupKey(key: string): boolean {
  const fn = handler();
  if (!fn || !POPUP_OWNED_KEYS.has(key)) return false;
  return fn(key);
}
