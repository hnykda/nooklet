/**
 * The "an agent just touched this" flash (ADR 015 §2.6/BUILD item 8): a tiny pub/sub so anything
 * that just ran a remote command (`./command-runner.ts`) or the `nav.revealBlock` command itself
 * can announce "flash block X," and `./RemoteFlashOverlay.tsx` (mounted once, floating above every
 * route) is the one place that turns that into a DOM effect — scroll-into-view plus a temporary,
 * distinctly-coloured CSS class, reusing the block row's existing `data-block-id` attribute
 * (`../editor/BlockRowView.tsx`) rather than adding a second "what element is this block" lookup.
 *
 * Kept decoupled from the editor package on purpose (no import of anything under `../editor/`):
 * this module only knows "flash block X," never how a block is rendered, so it costs nothing to
 * mount even before any editor surface exists and never risks a circular import.
 */

export interface FlashEvent {
  blockId: string;
  /** Who gets credited in the flash (ADR 015 §2.6: "a different colour from the human's own
   * accent"). Always "agent" for v1 — the only source of remote flashes today. */
  actor: "agent";
}

export type FlashListener = (event: FlashEvent) => void;

const listeners = new Set<FlashListener>();

/** Announce that a remote command just touched `blockId`. Safe to call with no listeners mounted
 * (e.g. in a test, or before `<RemoteFlashOverlay>` has mounted) — it is simply a no-op then. */
export function flashRemoteTouch(blockId: string): void {
  const event: FlashEvent = { blockId, actor: "agent" };
  for (const fn of listeners) fn(event);
}

export function subscribeFlash(fn: FlashListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
