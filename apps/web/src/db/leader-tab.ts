/**
 * Whether this tab held a replica's writer lock in its previous page load.
 *
 * A server graph's worker takes the writer lock only if it is free at once (`db.worker.ts`), so a
 * second tab follows instead of hanging (B-81). But the commonest way to find the lock taken is a
 * reload or a full navigation in the SAME tab: the previous page load's worker still holds it while
 * it is torn down. Such a page came up as a follower, on an in-memory replica; what it pulled was
 * gone at the next load, so a page seen online "did not exist yet" offline (full e2e runs:
 * `mermaid-lazy-cache.spec.ts`, `sync-connection-states.spec.ts`, two documents with two device
 * ids in one test's trace).
 *
 * `sessionStorage` is per tab and survives reloads and navigations, so a mark set when this tab
 * became the leader tells the next page load to wait the teardown out. A new tab starts without it
 * and still follows at once. A duplicated tab copies `sessionStorage` and so waits, then follows.
 */

/** As long as a local-only graph waits (`db.worker.ts#LOCAL_ONLY_LOCK_WAIT_MS`). */
export const SAME_TAB_LOCK_WAIT_MS = 3_000;

function key(scope: string): string {
  return `nooklet.ledReplica:${scope}`;
}

function session(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/** How long this page load's worker should wait for the writer lock of replica `scope`. */
export function leaderLockWaitMs(scope: string, store: Storage | undefined = session()): number {
  try {
    return store?.getItem(key(scope)) === "1" ? SAME_TAB_LOCK_WAIT_MS : 0;
  } catch {
    return 0;
  }
}

/** Record that this tab holds replica `scope`'s writer lock (its storage came up `"opfs"`). */
export function markLeaderTab(scope: string, store: Storage | undefined = session()): void {
  try {
    store?.setItem(key(scope), "1");
  } catch {
    // Storage disabled: the next load just does not wait, as before.
  }
}
