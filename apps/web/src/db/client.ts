/**
 * Main-thread entry point to the DB worker. Owns the `Worker`/Comlink plumbing and wires the
 * `platform` adapter's lifecycle events (ADR 005) to the worker's sync client — this is the ONE
 * place `postMessage` async-ness meets the rest of the app. Everything above this file
 * (`../data/store.ts` and up) only ever sees plain async functions and Solid signals/resources.
 */
import type { ApplyOpsResult, Op } from "@nooklet/core";
import { newId } from "@nooklet/core";
import * as Comlink from "comlink";
import { createSignal } from "solid-js";
import { replicaScope, soleLegacyStateOwner } from "../data/bootstrap.js";
import { platform } from "../platform/index.js";
import type { SyncStatus } from "../sync/types.js";
import {
  type CheckpointScheduler,
  createCheckpointScheduler,
  deleteCheckpoint,
  migrateUnscopedCheckpoint,
  readCheckpoint,
} from "./capacitor-checkpoint.js";
import { leaderLockWaitMs, markLeaderTab } from "./leader-tab.js";
import {
  createUnappliedOpsJournal,
  discardScopeBatches,
  holdOwnerLock,
  migrateUnscopedBatches,
  type OwnerLocks,
  replayOrphanedBatches,
  type UnappliedOpsJournal,
} from "./unapplied-ops.js";
import type { ChangeEvent, InitResult, WorkerApi, WorkerInitOptions } from "./worker-api.js";

export type { ChangedTable, ChangeEvent, LifecycleKind } from "./worker-api.js";

let workerApi: Comlink.Remote<WorkerApi> | undefined;
let initPromise: Promise<InitResult> | undefined;

/**
 * Where this device's replica lives, once `initDb` has resolved (`undefined` before). Read by the
 * shell's sync indicator so an in-memory session says "not saved" where "synced" would otherwise
 * be — the one place someone glances at to know their notes are safe.
 */
const [storageState, setStorageState] = createSignal<
  { storage: InitResult["storage"]; error?: string } | undefined
>(undefined);
export const storageInfo = storageState;

/** `localStorage`, or `undefined` where it is missing or throws on access (privacy modes). */
function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function browserLocks(): OwnerLocks | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator.locks as OwnerLocks | undefined);
}

/** This page load's id: the owner of its B-247 batches, held as a Web Lock until it goes away. */
const pageLoadOwner = newId();
holdOwnerLock(browserLocks(), pageLoadOwner);

/**
 * Every write kept on the main thread until the worker has it (B-247, `./unapplied-ops.ts`), scoped
 * to the replica this page load opened (B-611). Created by `initDb`, which is the one place that
 * knows which replica that is — not at module load, where on a first launch `initBootstrap` has not
 * yet added the entry the worker is about to open.
 */
let unapplied: UnappliedOpsJournal | undefined;
let scope: string | undefined;
let checkpoints: CheckpointScheduler | undefined;

/** The replica this page load opened, as `data/bootstrap.ts#replicaScope` (set by `initDb`). For
 * main-thread state that belongs to one graph, like the journal draft copy (B-619). */
export function currentReplicaScope(): string {
  return scope ?? replicaScope(undefined);
}

function getWorker(): Comlink.Remote<WorkerApi> {
  if (!workerApi) {
    const worker = new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" });
    workerApi = Comlink.wrap<WorkerApi>(worker);
  }
  return workerApi;
}

/** Start the DB worker, bootstrap/pull as needed, and wire platform lifecycle events to the sync
 * loop (ADR 005: "pending ops are flushed on pause/resume/online"). Call once at app startup
 * (`main.tsx`); safe to call again (returns the same promise). */
export function initDb(opts: WorkerInitOptions = {}): Promise<InitResult> {
  if (!initPromise) {
    const api = getWorker();
    scope = replicaScope(opts.graphEntryId);
    const journal = createUnappliedOpsJournal({
      storage: browserStorage(),
      scope,
      owner: pageLoadOwner,
    });
    unapplied = journal;
    const replicaScopeNow = scope;
    // Option C (docs/proposals/004): only on Capacitor — web/PWA/desktop's OPFS never needs a
    // native-filesystem backstop. `readCheckpoint()` itself never fetches `@capacitor/filesystem`
    // outside Capacitor (lazy import inside it, same pattern as `platform/capacitor.ts`), and
    // resolves `undefined` on "no checkpoint yet" (every first run) as much as on a real read
    // failure — either way `init()` below proceeds with no restore.
    // B-611: the checkpoint is per replica now; the old device-wide file is sorted out first.
    const restoreBytes: Promise<Uint8Array | undefined> =
      platform.name === "capacitor"
        ? migrateUnscopedCheckpoint(soleLegacyStateOwner()).then(() =>
            readCheckpoint(replicaScopeNow),
          )
        : Promise.resolve(undefined);
    initPromise = restoreBytes
      .then((bytes) =>
        api.init({
          ...opts,
          restoreBytes: bytes,
          leaderLockWaitMs: opts.leaderLockWaitMs ?? leaderLockWaitMs(replicaScopeNow),
        }),
      )
      .then((r) => {
        setStorageState({ storage: r.storage, error: r.storageError });
        if (r.storage === "opfs") markLeaderTab(replicaScopeNow);
        return r;
      });
    for (const event of ["online", "offline", "visible", "hidden", "pause", "resume"] as const) {
      platform.lifecycle.on(event, () => void api.notifyLifecycle(event));
    }
    if (platform.name === "capacitor") {
      const scheduler = createCheckpointScheduler(() => api.exportSnapshot(), replicaScopeNow);
      checkpoints = scheduler;
      onChange(() => scheduler.onChange());
      platform.lifecycle.on("pause", () => scheduler.onPause());
    }
    // Writes an earlier page load handed to its worker and never saw applied. Posted right behind
    // `init`, which the worker finishes (bootstrap included) before it runs anything else.
    // B-611: only this replica's batches; unscoped ones from an older build are first attributed
    // to the one replica that could have written them, or quarantined.
    const replay = () =>
      replayOrphanedBatches(
        journal,
        browserLocks(),
        (ops) => api.replayLocalOps(ops),
        (live) => void migrateUnscopedBatches(browserStorage(), live, soleLegacyStateOwner()),
      );
    // Once more a little later: the page load a reload replaced releases its owner lock when the
    // browser tears it down, and nothing promises that has happened by the time this one asks. In
    // Chromium it had, in every run of `reload-durability.spec.ts`; other engines are unmeasured.
    // Without this pass such a batch waits for the next start rather than being lost; it only
    // shortens that wait.
    void replay().then(() => setTimeout(() => void replay(), 5_000));
  }
  return initPromise;
}

/**
 * B-582: `getWorker()` alone only lazily creates the `Worker`/Comlink proxy — it says nothing
 * about whether `WorkerApi.init()` has actually been dispatched and applied yet. `main.tsx` calls
 * `initDb(...)` and renders `<App/>` in the same tick without awaiting it, so every function below
 * used to call `getWorker().xyz(...)` directly and race the very first render's resources against
 * `init()` — a race `init()` was winning by luck until Option C's `readCheckpoint()` step
 * (`initDb` above) added one more microtask hop before `api.init(...)` is even dispatched, which
 * was enough to make it lose reliably (`WorkerApi.init() must be called before any other method`,
 * thrown from every worker call a first render made — `Sidebar.tsx`'s data among them, which is
 * why the symptom looked like "the sidebar doesn't open" rather than an obviously worker-wide
 * failure). `initDb()` is idempotent (`if (!initPromise)`) and by the time anything below is ever
 * called, `main.tsx` has already run its own `initDb(opts)` line — synchronously, before `<App/>`
 * ever renders — so awaiting it here with no args always resolves the SAME real init, never starts
 * a second, wrongly-configured one.
 */
async function readyWorker(): Promise<Comlink.Remote<WorkerApi>> {
  await initDb();
  return getWorker();
}

export async function applyOps(ops: Op[]): Promise<ApplyOpsResult> {
  // The copy is written BEFORE the message is posted and synchronously, so an unload at any
  // point after this line leaves the batch to be replayed (B-247). Deliberately before the
  // `readyWorker()` await below, not after — this must stay true regardless of init timing.
  const ready = readyWorker(); // runs `initDb` synchronously if nothing has, creating the journal
  const key = unapplied?.record(ops);
  const worker = await ready;
  const result = worker.applyLocalOps(ops);
  // Kept when the call fails: whatever failed, the next start retries it rather than losing it.
  void result.then(
    () => unapplied?.settle(key),
    () => {},
  );
  return result;
}

/**
 * B-631: "Discard the local copy and re-sync" — delete the replica THIS page load opened and the
 * client state kept for it here (its B-247 batches, its native checkpoint), and nothing else on the
 * device: every other graph's replica, local-only ones included, stays exactly as it was. The
 * caller also clears the journal-draft and shelf copies (`data/discard-replica.ts`) and reloads.
 * Rejects, having deleted nothing, when this page load does not own its replica's file.
 */
export async function discardThisReplica(): Promise<void> {
  const worker = await readyWorker();
  // Before the worker closes the file, so an export racing the close cannot write a checkpoint
  // of it afterwards.
  checkpoints?.stop();
  await worker.discardReplica();
  // Nothing more is recorded for a replica that no longer exists.
  unapplied = undefined;
  const thisScope = currentReplicaScope();
  discardScopeBatches(browserStorage(), thisScope);
  if (platform.name === "capacitor") await deleteCheckpoint(thisScope);
}

/** Mint an HLC from the worker's single clock (see `worker-api.ts#nextHlc`). */
export async function nextHlc(): Promise<string> {
  return (await readyWorker()).nextHlc();
}

/** This replica's device id, to pair with `nextHlc()`. */
export async function getDeviceId(): Promise<string> {
  return (await readyWorker()).getDeviceId();
}

export async function query(
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return (await readyWorker()).query(sql, params);
}

/** Type-narrowing convenience for callers of `query()` that know their row shape — see
 * `worker-api.ts#query`'s doc for why the cast lives here, not in the worker. */
export async function queryAs<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await query(sql, params)) as unknown as T[];
}

/** B-641: references from the replica's own index (`worker-api.ts#pageBacklinks`). */
export async function localPageBacklinks(
  target: string,
  opts: Parameters<WorkerApi["pageBacklinks"]>[1],
) {
  return (await readyWorker()).pageBacklinks(target, opts);
}

/** B-641: the link graph from the replica (`worker-api.ts#graphLinks`). */
export async function localGraphLinks(opts: Parameters<WorkerApi["graphLinks"]>[0]) {
  return (await readyWorker()).graphLinks(opts);
}

export async function getPageTree(pageId: string) {
  return (await readyWorker()).getPageTree(pageId);
}

export async function getJournalStream(opts: Parameters<WorkerApi["getJournalStream"]>[0]) {
  return (await readyWorker()).getJournalStream(opts);
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return (await readyWorker()).getSyncStatus();
}

export async function forceSync(): Promise<void> {
  return (await readyWorker()).forceSync();
}

// ---------------------------------------------------------------------------------------------
// Change and sync-status listeners
//
// The worker holds ONE change listener and ONE status listener (`db.worker.ts` assigns a single
// slot), but several modules here need them: `../data/store.ts`'s invalidation bus,
// `../data/history.ts`'s, and every `useSyncStatus()` caller. Forwarding each subscription to the
// worker made the last subscriber the only one — opening Trash silently stopped every other view
// from refreshing until a reload (B-130). So this module registers exactly one Comlink proxy per
// kind, on first use, and fans out to however many callbacks are subscribed.
// ---------------------------------------------------------------------------------------------

function fanOut<T>(
  register: (cb: (value: T) => void) => void,
): (cb: (value: T) => void) => () => void {
  const subscribers = new Set<(value: T) => void>();
  let registered = false;
  return (cb) => {
    // A wrapper per subscription, so subscribing the same function twice gives two independent
    // subscriptions and each unsubscribe removes only its own.
    const entry = (value: T): void => cb(value);
    subscribers.add(entry);
    if (!registered) {
      registered = true;
      register((value) => {
        // Snapshot: a callback that unsubscribes (or subscribes) while being notified must not
        // change who receives THIS event.
        for (const s of [...subscribers]) {
          try {
            s(value);
          } catch (err) {
            // One broken subscriber must not starve the rest of the app of change events.
            console.error("nooklet: a change listener threw", err);
          }
        }
      });
    }
    return () => {
      subscribers.delete(entry);
    };
  };
}

/** Subscribe to the worker's change events (local, pulled, corrected or bootstrapped writes).
 * Returns an unsubscribe. Comlink requires callbacks crossing the worker boundary to be wrapped
 * as proxies; that happens once, in `fanOut`. */
export const onChange: (cb: (e: ChangeEvent) => void) => () => void = fanOut<ChangeEvent>(
  (cb) => void getWorker().onChange(Comlink.proxy(cb)),
);

/** Subscribe to sync-status changes. Returns an unsubscribe. */
export const onSyncStatus: (cb: (s: SyncStatus) => void) => () => void = fanOut<SyncStatus>(
  (cb) => void getWorker().onSyncStatus(Comlink.proxy(cb)),
);
