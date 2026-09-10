/**
 * The distinct "an agent just touched this" flash (ADR 015 §2.6/BUILD item 8) — extends the flash
 * `nav.followLink`'s block-ref case already uses (R43), in a different colour/label ("Agent"
 * rather than the human's own accent) so it reads unambiguously as "the AI did this." Mount once,
 * above the routes (`../app/CommandLayer.tsx`), same as `<SlashMenu>`/`<CommandPalette>`.
 *
 * Targets the block row via its existing `data-block-id` attribute
 * (`../editor/BlockRowView.tsx`) — no second "which DOM node is block X" lookup, and no edit to
 * `../editor/` needed. Polls briefly for the element to appear (`nav.revealBlock` may have just
 * navigated to a different page whose blocks are still mounting) before giving up silently, the
 * same "degrade quietly rather than throw" posture the rest of this feature takes for a window
 * that isn't in the expected state.
 */

import { onCleanup, onMount } from "solid-js";
import "./live.css";
import { subscribeFlash } from "./flash-bus.js";

const FLASH_CLASS = "vr-remote-flash";
const FLASH_DURATION_MS = 1600;
const POLL_INTERVAL_MS = 100;
const POLL_ATTEMPTS = 15; // ~1.5s, enough for a route change to render

function findBlockRow(blockId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`);
}

function flashElement(el: HTMLElement): void {
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add(FLASH_CLASS);
  setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_DURATION_MS);
}

/** Exported for tests: the poll-and-flash loop without the Solid lifecycle wrapper. */
export function flashBlockWhenReady(
  blockId: string,
  opts: { find?: (id: string) => HTMLElement | null; onFlash?: (el: HTMLElement) => void } = {},
): void {
  const find = opts.find ?? findBlockRow;
  const onFlash = opts.onFlash ?? flashElement;
  let attempts = 0;
  const tryNow = (): void => {
    const el = find(blockId);
    if (el) {
      onFlash(el);
      return;
    }
    attempts++;
    if (attempts < POLL_ATTEMPTS) setTimeout(tryNow, POLL_INTERVAL_MS);
    // Otherwise: give up quietly — the block may be on a page that failed to load, or the id is
    // stale. Nothing in ADR 015 requires surfacing this as an error to the human.
  };
  tryNow();
}

export function RemoteFlashOverlay() {
  onMount(() => {
    const unsubscribe = subscribeFlash((event) => flashBlockWhenReady(event.blockId));
    onCleanup(unsubscribe);
  });
  return null;
}
