/**
 * The page-icon picker's "Recently used" row (B-647). Per device in `localStorage`, like the theme
 * (`app/theme.ts`): which icons this hand reaches for is a habit of the device's owner, not part
 * of the notes, so it is not synced. Logseq's picker keeps its "frequently used" list the same way
 * (in its local storage). Every access is guarded: private mode or blocked storage just means no
 * recents.
 */

const KEY = "nooklet.emoji-recents";
/** Three rows of the 8-column grid. */
export const MAX_RECENTS = 24;

export function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((e): e is string => typeof e === "string").slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecent(emoji: string): void {
  try {
    const next = [emoji, ...readRecents().filter((e) => e !== emoji)].slice(0, MAX_RECENTS);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the icon is set either way.
  }
}
