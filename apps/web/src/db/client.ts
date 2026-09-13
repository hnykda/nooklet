/**
 * Main-thread entry point to the DB worker. Owns the `Worker`/Comlink plumbing and wires the
 * `platform` adapter's lifecycle events (ADR 005) to the worker's sync client — this is the ONE
 * place `postMessage` async-ness meets the rest of the app. Everything above this file
 * (`../data/store.ts` and up) only ever sees plain async functions and Solid signals/resources.
 */
import type { ApplyOpsResult, Op } from "@nooklet/core";
import * as Comlink from "comlink";
import { createSignal } from "solid-js";
import { platform } from "../platform/index.js";
import type { SyncStatus } from "../sync/types.js";
import {
  createUnappliedOpsJournal,
  holdOwnerLock,
  type OwnerLocks,
  replayOrphanedBatches,
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

/** Every write kept on the main thread until the worker has it (B-247, `./unapplied-ops.ts`). */
const unapplied = createUnappliedOpsJournal({ storage: browserStorage() });
holdOwnerLock(browserLocks(), unapplied.owner);

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
    initPromise = api.init(opts).then((r) => {
      setStorageState({ storage: r.storage, error: r.storageError });
      return r;
    });
    for (const event of ["online", "offline", "visible", "hidden", "pause", "resume"] as const) {
      platform.lifecycle.on(event, () => void api.notifyLifecycle(event));
    }
    // Writes an earlier page load handed to its worker and never saw applied. Posted right behind
    // `init`, which the worker finishes (bootstrap included) before it runs anything else.
    const replay = () =>
      replayOrphanedBatches(unapplied, browserLocks(), (ops) => api.replayLocalOps(ops));
    // Once more a little later: the page load a reload replaced releases its owner lock when the
    // browser tears it down, and nothing promises that has happened by the time this one asks. In
    // Chromium it had, in every run of `reload-durability.spec.ts`; other engines are unmeasured.
    // Without this pass such a batch waits for the next start rather than being lost; it only
    // shortens that wait.
    void replay().then(() => setTimeout(() => void replay(), 5_000));
  }
  return initPromise;
}

export function applyOps(ops: Op[]): Promise<ApplyOpsResult> {
  // The copy is written BEFORE the message is posted and synchronously, so an unload at any
  // point after this line leaves the batch to be replayed (B-247).
  const key = unapplied.record(ops);
  const result = getWorker().applyLocalOps(ops);
  // Kept when the call fails: whatever failed, the next start retries it rather than losing it.
  void result.then(
    () => unapplied.settle(key),
    () => {},
  );
  return result;
}

/** Mint an HLC from the worker's single clock (see `worker-api.ts#nextHlc`). */
export function nextHlc(): Promise<string> {
  return getWorker().nextHlc();
}

/** This replica's device id, to pair with `nextHlc()`. */
export function getDeviceId(): Promise<string> {
  return getWorker().getDeviceId();
}

export function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return getWorker().query(sql, params);
}

/** Type-narrowing convenience for callers of `query()` that know their row shape — see
 * `worker-api.ts#query`'s doc for why the cast lives here, not in the worker. */
export async function queryAs<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await query(sql, params)) as unknown as T[];
}

export function getPageTree(pageId: string) {
  return getWorker().getPageTree(pageId);
}

export function getJournalStream(opts: Parameters<WorkerApi["getJournalStream"]>[0]) {
  return getWorker().getJournalStream(opts);
}

export function getSyncStatus(): Promise<SyncStatus> {
  return getWorker().getSyncStatus();
}

export function forceSync(): Promise<void> {
  return getWorker().forceSync();
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
