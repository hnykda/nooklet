/**
 * B-712: how many of this device's changes to a graph have not reached its server — asked when
 * that graph is about to be removed from the device, which loses them.
 *
 * Only the OPEN graph's replica is loaded (one worker, one database), and the switcher only offers
 * to remove graphs that are NOT open. So the count is the one the sync engine last reported while
 * that graph was open here (`rememberPendingCount`, fed by `shell/SyncIndicator.tsx`), plus any
 * batch still in the B-247 journal for its replica (`db/unapplied-ops.ts`), which never reached
 * the worker at all. `undefined` when this device never recorded one: the caller treats that as
 * "may have some", never as zero.
 */
import { UNAPPLIED_KEY_PREFIX } from "../db/unapplied-ops.js";
import { type GraphListEntry, replicaKey, replicaScope } from "./bootstrap.js";

const KEY_PREFIX = "nooklet.pendingCount.";

export function rememberPendingCount(entryId: string, count: number): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${entryId}`, String(count));
  } catch {
    // Storage unavailable: the removal dialog then says it cannot tell, and asks for "delete".
  }
}

export function forgetPendingCount(entryId: string): void {
  try {
    localStorage.removeItem(`${KEY_PREFIX}${entryId}`);
  } catch {
    // Nothing to clean up.
  }
}

/** Ops in the B-247 journal for this entry's replica. */
function unappliedOps(entry: GraphListEntry): number {
  const prefix = `${UNAPPLIED_KEY_PREFIX}${encodeURIComponent(replicaScope(replicaKey(entry)))}:`;
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const batch = JSON.parse(localStorage.getItem(key) ?? "null") as { ops?: unknown } | null;
      if (Array.isArray(batch?.ops)) total += batch.ops.length;
    }
  } catch {
    // An unreadable entry counts as nothing extra; the recorded count still stands.
  }
  return total;
}

/** Changes this device made to `entry` that its server has not got, as far as this device knows. */
export function knownPendingCount(entry: GraphListEntry): number | undefined {
  let recorded: number | undefined;
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${entry.id}`);
    const n = raw === null ? Number.NaN : Number(raw);
    recorded = Number.isInteger(n) && n >= 0 ? n : undefined;
  } catch {
    recorded = undefined;
  }
  const journal = unappliedOps(entry);
  if (recorded === undefined) return journal > 0 ? journal : undefined;
  return recorded + journal;
}
