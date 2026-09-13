/**
 * "Open this page's icon editor" from somewhere other than the icon slot itself — the page actions
 * menu (`./PageActions.tsx`), which is how a phone reaches it: the empty slot is revealed by hover,
 * a touch screen has none, so on a coarse pointer the slot is not shown at all and the menu offers
 * "Add icon" instead (B-225).
 *
 * A signal, not a plain variable or an event: the editor (`./PageIcon.tsx#PageIconEditor`) has to
 * be told reactively, and module-level state only reaches a component through tracking. Keyed by
 * page id so a request can never open another page's editor, and consumed by the editor that acts
 * on it — a request left standing would reopen the editor every time the page is visited again.
 */

import { createSignal } from "solid-js";

const [request, setRequest] = createSignal<string | null>(null);

/** Ask the icon editor of page `pageId` to open. */
export function requestPageIconEdit(pageId: string): void {
  setRequest(pageId);
}

/** The pending request's page id, if any. Tracked. */
export function pendingPageIconEdit(): string | null {
  return request();
}

/** Clear the request once an editor has opened for it. */
export function consumePageIconEdit(): void {
  setRequest(null);
}
