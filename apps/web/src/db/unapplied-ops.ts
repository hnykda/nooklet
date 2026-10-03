/**
 * A synchronous, main-thread copy of every local write until the DB worker has made it durable
 * (B-247; `docs/proposals/002-pending-edits-durability.md` weighs the alternatives).
 *
 * Why it has to exist. A write is durable once the worker has run `applyLocal` — local state and
 * the `pending_op` outbox in one transaction. Until then it is a message in the worker's queue,
 * and the worker is often busy: ~2 s on a cold load of the owner's 952-page graph, most of a
 * second for a `[[` search, a few hundred ms answering a page load's queries. A document that
 * unloads in that window (reload, tab close, a crash) takes its worker and the queue with it. The
 * editor's `pagehide` flush does not help: it posts one more message into that same queue. Measured
 * on the real graph with nothing else loading the worker, an edit reloaded 100–300 ms after typing
 * was gone (`tools/probes/replica-busy-window.mjs`).
 *
 * So every batch is also written to `localStorage` — synchronous, so it has happened by the time
 * `applyOps` returns, and it survives the document — and removed when the worker answers. A batch
 * still there at the next start belongs to a page load that died before its worker answered, and
 * is replayed through the worker then. Replaying is safe to repeat: an op's id is its HLC, the
 * worker skips ids its replica already recorded, and fields merge last-writer-wins, so a batch
 * that did land (the answer was simply lost with the page) changes nothing.
 *
 * Whose batches. Two tabs share `localStorage`, and a tab must not replay a batch another LIVE tab
 * is still waiting on. Each page load holds a Web Lock named after itself for its whole life; the
 * browser releases it when the document goes away, so "no lock held" is exactly "that page load is
 * gone". Without the Locks API every other owner counts as gone, which is merely redundant.
 */
import { newId, type Op } from "@nooklet/core";

/** Versioned, so a later change of shape can ignore (and clear) entries it does not understand.
 * v2 (B-611) carries the replica the batch was written for: `v2:<scope>:<owner>:<seq>`, where
 * `scope` is `data/bootstrap.ts#replicaScope`, URI-encoded. A batch is only ever replayed by a
 * page load that opened the SAME replica. v1 had no scope, and an orphaned v1 batch replayed into
 * whichever graph the next page load opened: a local-only note written just before "Add a graph"
 * was pushed into the server graph. */
export const UNAPPLIED_KEY_PREFIX = "nooklet.unapplied-ops.v2:";
/** The unscoped format, read only by `migrateUnscopedBatches`. */
export const UNSCOPED_KEY_PREFIX = "nooklet.unapplied-ops.v1:";
/** Where an unscoped batch goes when it cannot be attributed to exactly one replica: kept (it is
 * someone's writing), never replayed. Same `<owner>:<seq>` suffix as v1. */
export const QUARANTINE_KEY_PREFIX = "nooklet.unapplied-ops.quarantine.v1:";
const OWNER_LOCK_PREFIX = "nooklet.unapplied-ops.owner:";

/** The part of `Storage` this needs — `localStorage` in the app, a Map-backed fake in tests. */
export interface JournalStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The part of `LockManager` this needs. */
export interface OwnerLocks {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[]; pending?: { name?: string }[] }>;
}

export interface UnappliedBatch {
  key: string;
  owner: string;
  seq: number;
  at: number;
  ops: Op[];
}

export interface UnappliedOpsJournal {
  /** This page load's id. */
  readonly owner: string;
  /** The replica this page load writes to (`replicaScope`). */
  readonly scope: string;
  /** Keep a copy of `ops` until `settle`. Returns the entry's key, or `undefined` when nothing could
   * be written (no storage, quota exceeded) — then the write is exactly as durable as before. */
  record(ops: readonly Op[]): string | undefined;
  settle(key: string | undefined): void;
  /** Batches of THIS scope written by page loads not in `liveOwners`, oldest first. Other scopes'
   * batches are left alone for their own graph's next start. Unreadable entries are removed. */
  orphaned(liveOwners: ReadonlySet<string>): UnappliedBatch[];
}

export function createUnappliedOpsJournal(opts: {
  storage: JournalStorage | undefined;
  /** `data/bootstrap.ts#replicaScope` of the replica this page load opened. */
  scope: string;
  owner?: string;
  now?: () => number;
}): UnappliedOpsJournal {
  const { storage } = opts;
  const owner = opts.owner ?? newId();
  const prefix = `${UNAPPLIED_KEY_PREFIX}${encodeURIComponent(opts.scope)}:`;
  const now = opts.now ?? Date.now;
  let seq = 0;

  return {
    owner,
    scope: opts.scope,

    record(ops) {
      if (!storage || ops.length === 0) return undefined;
      // Zero-padded so keys of one owner sort in write order as plain strings.
      const key = `${prefix}${owner}:${String(seq++).padStart(8, "0")}`;
      try {
        storage.setItem(key, JSON.stringify({ at: now(), ops }));
        return key;
      } catch (err) {
        // Quota (a paste of thousands of blocks) or storage disabled: carry on without the copy.
        console.warn("nooklet: could not keep a copy of a write until it is saved", err);
        return undefined;
      }
    },

    settle(key) {
      if (!storage || key === undefined) return;
      try {
        storage.removeItem(key);
      } catch {
        // Nothing to do: a leftover entry is replayed once and skipped as already recorded.
      }
    },

    orphaned(liveOwners) {
      if (!storage) return [];
      const found: UnappliedBatch[] = [];
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const colon = rest.lastIndexOf(":");
        const entryOwner = rest.slice(0, colon);
        if (colon <= 0 || liveOwners.has(entryOwner)) continue;
        try {
          const parsed = JSON.parse(storage.getItem(key) ?? "") as { at: number; ops: Op[] };
          if (!Array.isArray(parsed.ops) || typeof parsed.at !== "number") throw new Error("shape");
          found.push({
            key,
            owner: entryOwner,
            seq: Number(rest.slice(colon + 1)),
            at: parsed.at,
            ops: parsed.ops,
          });
        } catch {
          console.warn(`nooklet: dropping an unreadable unsaved-write entry ${key}`);
          storage.removeItem(key);
        }
      }
      // Oldest page load first, and within one in write order. HLCs decide every field anyway;
      // the order only matters for structure, where it should be the order things happened.
      return found.sort((a, b) => a.at - b.at || a.owner.localeCompare(b.owner) || a.seq - b.seq);
    },
  };
}

/**
 * B-611 migration: every unscoped (v1) batch whose page load is gone is either given to `owner` —
 * the one replica that could have written it (`data/bootstrap.ts#soleLegacyStateOwner`) — or, when
 * that is ambiguous (`owner` undefined), moved to the quarantine prefix, where nothing replays it.
 * A v1 batch of a page load still alive (an old build in another tab) is left for that tab to
 * settle. Returns how many were attributed and quarantined.
 */
export function migrateUnscopedBatches(
  storage: JournalStorage | undefined,
  liveOwners: ReadonlySet<string>,
  owner: string | undefined,
): { attributed: number; quarantined: number } {
  const counts = { attributed: 0, quarantined: 0 };
  if (!storage) return counts;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(UNSCOPED_KEY_PREFIX)) keys.push(key);
  }
  for (const key of keys) {
    const rest = key.slice(UNSCOPED_KEY_PREFIX.length);
    const colon = rest.lastIndexOf(":");
    if (colon > 0 && liveOwners.has(rest.slice(0, colon))) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    const target =
      owner === undefined
        ? `${QUARANTINE_KEY_PREFIX}${rest}`
        : `${UNAPPLIED_KEY_PREFIX}${encodeURIComponent(owner)}:${rest}`;
    try {
      storage.setItem(target, value);
      storage.removeItem(key);
      if (owner === undefined) counts.quarantined++;
      else counts.attributed++;
    } catch (err) {
      // Left where it is: still unscoped, so still never replayed by this build.
      console.warn(`nooklet: could not migrate the unsaved-write entry ${key}`, err);
    }
  }
  if (counts.quarantined > 0) {
    console.warn(
      `nooklet: ${counts.quarantined} unsaved write(s) from before graphs were kept apart could ` +
        `not be matched to one graph; kept under ${QUARANTINE_KEY_PREFIX}* and not replayed.`,
    );
  }
  return counts;
}

/** Hold this page load's owner lock until the document goes away. */
export function holdOwnerLock(locks: OwnerLocks | undefined, owner: string): void {
  if (!locks) return;
  void locks
    .request(`${OWNER_LOCK_PREFIX}${owner}`, () => new Promise<void>(() => {}))
    .catch(() => {});
}

/** Owners whose page load is still alive: their lock is held (or requested). Always includes
 * `self`. Without the Locks API that is all it can say. */
export async function liveOwners(
  locks: OwnerLocks | undefined,
  self: string,
): Promise<Set<string>> {
  const live = new Set([self]);
  if (!locks) return live;
  try {
    const snapshot = await locks.query();
    for (const l of [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]) {
      if (l.name?.startsWith(OWNER_LOCK_PREFIX)) live.add(l.name.slice(OWNER_LOCK_PREFIX.length));
    }
  } catch {
    // Treat every other owner as gone; a replay of a batch that did land is a no-op.
  }
  return live;
}

/**
 * Replay every orphaned batch through `apply` (the worker's `replayLocalOps`), oldest first, and
 * remove each once it has been applied. A batch whose replay fails is KEPT for the next start:
 * the failure may be this session's (a replica that did not open), and dropping it would be the
 * very loss this module exists to prevent. Resolves to the number of batches replayed.
 */
export async function replayOrphanedBatches(
  journal: UnappliedOpsJournal,
  locks: OwnerLocks | undefined,
  apply: (ops: Op[]) => Promise<unknown>,
  migrate?: (live: ReadonlySet<string>) => void,
): Promise<number> {
  const live = await liveOwners(locks, journal.owner);
  // Before reading this scope's batches, so a v1 batch attributed to this replica replays now.
  migrate?.(live);
  const batches = journal.orphaned(live);
  let replayed = 0;
  for (const batch of batches) {
    try {
      await apply(batch.ops);
      journal.settle(batch.key);
      replayed++;
    } catch (err) {
      console.error("nooklet: replaying an unsaved write failed; kept for the next start", err);
    }
  }
  return replayed;
}
