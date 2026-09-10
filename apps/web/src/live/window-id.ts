/**
 * `window_id` (ADR 015 §2.2): a random id minted once per browser tab/window and kept in
 * `sessionStorage` so it survives a reload but not a new tab — "a fresh tab is a fresh window for
 * this purpose, matching what a human means by 'this window'." Never synced, never derived from
 * the sync `device_id` (one device routinely has several open tabs).
 *
 * Storage-agnostic (mirrors `../commands/ranking/mru.ts`'s `MruStorageAdapter` idiom) so tests
 * never touch a real `sessionStorage`.
 */

export interface WindowIdStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "nooklet.live.windowId";

function randomWindowId(): string {
  // Not a graph id (no Crockford-base32/14-char constraint applies here — this never appears in
  // the op log, only in the /ui/live handshake) — a plain random token is all identity requires.
  return crypto.randomUUID();
}

/** Returns this tab's `window_id`, minting and storing a fresh one on first call. Pass no adapter
 * to get a fresh id every call (tests, or a browser with storage disabled) — that is still a
 * valid (if less persistent) `window_id`, never a thrown error. */
export function getOrCreateWindowId(storage?: WindowIdStorageAdapter): string {
  if (!storage) return randomWindowId();
  try {
    const existing = storage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = randomWindowId();
    storage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return randomWindowId();
  }
}
