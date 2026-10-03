/**
 * A synchronous copy of a journal day's draft (`views/VirtualJournalDay.tsx`) until its lines are
 * ops (B-619).
 *
 * The draft cannot build its ops on its own: they need the journal template and a pool of HLCs,
 * both worker round trips (`VirtualJournalDay#prepare`), and on a page load whose worker is still
 * busy those take long enough that a line closed with Enter sits on screen, unwritten, for a few
 * hundred ms. A reload or relaunch in that window lost it: the B-247 journal
 * (`../db/unapplied-ops.ts`) copies ops, and there were none yet. Measured with
 * `tools/probes/local-graphs/relaunch-loss.probe.ts` on emulated Capacitor: lost in 9 of 10
 * immediate relaunches, 0 of 9 with 300 ms or more before it.
 *
 * So the typed lines are kept in `localStorage` (synchronous, survives the document) from the
 * moment they exist until `commit` has handed the ops to `applyOps`, which records them in the
 * B-247 journal in the same synchronous step; from there that journal carries them. The next page
 * load that shows the day restores them (and writes them). Keyed by replica as well as day: a
 * draft belongs to the graph it was typed in (B-611), never to whichever graph opens next.
 */
import { currentReplicaScope } from "../db/client.js";
import { appendToJournalDay } from "./journal-day.js";

const PREFIX = "nooklet.journal-draft.v1:";

function key(day: number): string {
  return `${PREFIX}${encodeURIComponent(currentReplicaScope())}:${day}`;
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Keep `lines` (Enter-closed lines, then the textarea's text) for `day`; all empty clears it. */
export function saveDraftLines(day: number, lines: readonly string[]): void {
  const store = storage();
  if (!store) return;
  try {
    if (lines.every((line) => line === "")) store.removeItem(key(day));
    else store.setItem(key(day), JSON.stringify(lines));
  } catch {
    // Quota or disabled storage: the draft is exactly as durable as before this existed.
  }
}

export function readDraftLines(day: number): string[] | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(key(day));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((l) => typeof l === "string") && parsed.length > 0) {
      return parsed as string[];
    }
  } catch {
    // Unreadable: dropped below.
  }
  clearDraftLines(day);
  return undefined;
}

export function clearDraftLines(day: number): void {
  try {
    storage()?.removeItem(key(day));
  } catch {
    // nothing to do
  }
}

/**
 * A kept draft for a day that has a page by now (another device wrote the day, and sync brought it
 * in before this load's stream answered): its non-empty lines go at the end of that page, one block
 * each, like B-243's hand-off. Resolves to whether anything was written. The copy is cleared only
 * once every line is written, so a failure keeps it for the next load.
 */
export async function flushDraftIntoExistingDay(day: number): Promise<boolean> {
  const lines = readDraftLines(day)?.filter((line) => line !== "");
  if (!lines || lines.length === 0) return false;
  for (const line of lines) {
    if ((await appendToJournalDay(day, line)) === null) return false;
  }
  clearDraftLines(day);
  return true;
}
