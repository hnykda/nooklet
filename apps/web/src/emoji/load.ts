/**
 * The emoji list, loaded on the first open of the picker and kept. A dynamic import, so the data
 * is its own chunk and the main bundle does not carry it (B-647). Unlike mermaid's chunks it IS in
 * the PWA precache — deliberately: ~38 KB gzipped, and a picker that is empty the first time a
 * phone opens it offline would be the bug report. See `docs/progress/icon-picker.md`.
 */

import { buildIndex, type EmojiIndex } from "./search.js";

let pending: Promise<EmojiIndex> | undefined;

export function loadEmojiIndex(): Promise<EmojiIndex> {
  pending ??= import("virtual:emoji-data").then((m) => buildIndex(m.default));
  // A failed load (offline with an evicted cache) must not stick: the next open tries again.
  pending.catch(() => {
    pending = undefined;
  });
  return pending;
}
