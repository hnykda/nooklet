/**
 * Block-reference text, resolved for rendering.
 *
 * `((block-id))` is meant to render as the referenced block's own content — that is the whole
 * point of a block reference, and without it a reference is an opaque id nobody can read. The
 * renderer (`editor/render/tokens.tsx`) has always had a `resolveBlockRef` seam for this and
 * nothing was ever plugged into it.
 *
 * The awkward part is that rendering is synchronous while the block lives in the worker. So this
 * is a cache with a miss-triggered fetch: `lookupBlockText` answers immediately from what it has,
 * starts a query when it does not, and stores the result in a signal — which makes any component
 * that read the miss re-render once the text arrives. Each id is fetched at most once.
 */

import { createSignal } from "solid-js";
import { queryAs } from "../db/client.js";

/** `undefined` = not fetched yet, `null` = fetched and no such block (deleted, or another graph). */
const [texts, setTexts] = createSignal<Record<string, string | null>>({});
const inFlight = new Set<string>();

function fetchBlockText(id: string): void {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  void queryAs<{ content: string }>(
    "SELECT content FROM block WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [id],
  )
    .then((rows) => {
      setTexts((prev) => ({ ...prev, [id]: rows[0]?.content ?? null }));
    })
    .catch(() => {
      setTexts((prev) => ({ ...prev, [id]: null }));
    });
}

/**
 * The referenced block's content, or `undefined` while it is still being looked up (the renderer
 * falls back to a muted placeholder in the meantime, then re-renders).
 */
export function lookupBlockText(id: string): string | undefined {
  const known = texts()[id];
  if (known !== undefined) return known ?? undefined;
  fetchBlockText(id);
  return undefined;
}

/**
 * Drop everything cached, so an edited block updates everywhere it is referenced rather than
 * showing what it used to say.
 *
 * Whole-cache rather than per-id because the change bus reports which TABLES changed, not which
 * block ids (`db/worker-api.ts`'s `ChangeEvent`). Re-fetching a handful of referenced blocks is
 * cheap; showing stale text is not, and narrowing this would mean widening that event first.
 */
export function invalidateBlockRefs(): void {
  inFlight.clear();
  setTexts({});
}
