/**
 * The DB worker (research/03-sync.md §6.9): imports `@nooklet/core` and `WorkerDb` directly, so
 * every synchronous SQLite call — `applyOps`, `rebuild`, plain queries — happens right here, where
 * the driver genuinely is synchronous. Only the RPC surface this file `Comlink.expose`s
 * (`WorkerApi`, `./worker-api.ts`) is async; that async-ness lives at the `postMessage` boundary
 * ALONE, not inside `@nooklet/core`. This is the "recommended" split from the task brief: a
 * hand-rolled postMessage protocol was rejected in favor of Comlink because the entire point of
 * this file is to expose a handful of plain async methods, which is exactly Comlink's job (proxy
 * generation, structured-clone marshalling, promise-per-call) — writing that by hand would just
 * reimplement Comlink at higher risk for zero benefit, for a dependency that is 1.1 kB gzipped.
 *
 * Leader election (research/03 §6.9: "One writer tab elected with navigator.locks"): `opfs-sahpool`
 * allows exactly one open connection per database file (research/08 §1.3), so only one tab may
 * ever run this worker's `openDb()`. `becomeLeader()` blocks on a Web Lock until this tab is it.
 * NOTE: a non-leader tab's worker currently just waits forever on the lock rather than proxying
 * its calls to the leader tab over `BroadcastChannel` — multi-tab-at-once proxying is real, known
 * scope this milestone deliberately does not build (single tab is the primary target; see
 * apps/web/README.md), left as a documented follow-up for whoever picks up multi-tab.
 *
 * Excluded from the main `tsconfig.json` (DOM lib) and covered by `tsconfig.worker.json`
 * (WebWorker lib) instead — see that file's comment for why the two libs can't coexist in one
 * `tsconfig`.
 */
import type { Op } from "@nooklet/core";
import * as Comlink from "comlink";
import { createHttpTransport } from "../sync/http-transport.js";
import type { SyncStatus } from "../sync/types.js";
import { createResumeRetry, type ResumeRetry } from "./reopen-on-resume.js";
import { openSqliteWasmDriver, UNNAMESPACED_REPLICA } from "./sqlite-wasm-driver.js";
import type { ChangeEvent, InitResult, WorkerApi, WorkerInitOptions } from "./worker-api.js";
import { WorkerDb } from "./worker-core.js";

const LEADER_LOCK_NAME = "nooklet-db-writer";

/** ADR 025: the lock (and, in `openDb` below, the OPFS filename) must be namespaced per graph-list
 * entry, not just per origin — two graphs behind one origin (a desktop app that also points at a
 * remote graph) would otherwise contend for the same lock despite being entirely unrelated SQLite
 * files, leaving one of them a permanent, pointless "follower" of a graph it has nothing to do
 * with. Omitted `graphEntryId` (every pre-ADR-025 caller, every existing test) keeps today's bare
 * lock name — one graph, one lock, unchanged. */
function leaderLockName(graphEntryId: string | undefined): string {
  return graphEntryId ? `${LEADER_LOCK_NAME}:${graphEntryId}` : LEADER_LOCK_NAME;
}

/**
 * Take the writer lock if nobody holds it, and say so. The original version waited on the lock
 * unconditionally, so a second tab of the same graph sat on "Loading…" forever (B-81): its worker
 * was queued behind the first tab's, which holds the lock until it closes. A tab that does not
 * get the lock now becomes a FOLLOWER — it opens an in-memory replica bootstrapped from the
 * server, works normally, and reaches the leader through sync. If the leader closes, a reload
 * makes this tab the leader; taking over live would mean swapping storage under an open session.
 */
function tryBecomeLeader(graphEntryId: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request(leaderLockName(graphEntryId), { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return;
      }
      resolve(true);
      // Hold the lock for the worker's entire lifetime (until the tab closes); never resolves.
      return new Promise<void>(() => {});
    });
  });
}

/**
 * How long a replica with no server waits for the writer lock before settling for a follower.
 * A follower's replica is in memory and, for a follower, "reaches the leader through sync" — but
 * with no server there is no sync, so everything written in it is gone at the next reload. And the
 * commonest way to start as a follower is not a second tab at all: it is a relaunch or reload,
 * where the previous page load's worker still holds the lock for a moment while it is torn down
 * (`tools/probes/local-graphs/relaunch-loss.probe.ts`: 1 relaunch in 10 came up as a follower).
 * Waiting that moment out keeps the local copy; a genuine second tab still gets its follower, late.
 */
const LOCAL_ONLY_LOCK_WAIT_MS = 3_000;

async function becomeLeader(
  graphEntryId: string | undefined,
  localOnly: boolean,
): Promise<boolean> {
  const deadline = Date.now() + (localOnly ? LOCAL_ONLY_LOCK_WAIT_MS : 0);
  for (;;) {
    if (await tryBecomeLeader(graphEntryId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

let changeListener: ((e: ChangeEvent) => unknown) | undefined;
let statusListener: ((s: SyncStatus) => unknown) | undefined;

/** Call a Comlink-proxied callback without letting a rejected/failed call crash the worker. */
function safeCall<A extends unknown[]>(
  fn: ((...args: A) => unknown) | undefined,
  ...args: A
): void {
  if (!fn) return;
  try {
    const r = fn(...args);
    if (r && typeof (r as Promise<unknown>).catch === "function")
      void (r as Promise<unknown>).catch(() => {});
  } catch {
    // ignore
  }
}

interface OpenedDb {
  db: WorkerDb;
  storage: InitResult["storage"];
  storageError?: string;
  /** Only meaningful for the leader (a follower's replica is in-memory, nothing to export) —
   * Option C's checkpoint read side (`api.exportSnapshot`). */
  exportBytes?: () => Uint8Array;
  unnamespacedReplica?: InitResult["unnamespacedReplica"];
  /** B-631: the leader's `OpenedSqliteWasm.discard` (this replica's file only). */
  discard?: () => string[];
}

async function openDb(opts: WorkerInitOptions): Promise<OpenedDb> {
  const leader = await becomeLeader(opts.graphEntryId, opts.syncBaseUrl === undefined);
  // Same reasoning as `leaderLockName` above: `undefined` keeps `openSqliteWasmDriver`'s own
  // unnamespaced default filename, exactly pre-ADR-025 behavior, for every caller that doesn't
  // pass a `graphEntryId`.
  const filename = opts.graphEntryId ? `/nooklet-${opts.graphEntryId}.sqlite3` : undefined;
  const opened = await openSqliteWasmDriver(filename, {
    memory: !leader,
    // A follower's driver is already forced to memory above, so restoring here would be pointless
    // (and `openSqliteWasmDriver` never reaches the pool code on that path anyway).
    restoreBytes: leader ? opts.restoreBytes : undefined,
    inspect: opts.inspectUnnamespaced ? UNNAMESPACED_REPLICA : undefined,
  });
  const { driver } = opened;
  const storage: OpenedDb["storage"] = leader ? opened.storage : "follower";
  const storageError = leader ? opened.storageError : "another tab of this graph holds the lock";
  const transport = createHttpTransport({
    baseUrl: opts.syncBaseUrl,
    getToken: opts.getToken ?? (() => opts.token),
  });
  const db = new WorkerDb({
    driver,
    transport,
    // B-567: `syncBaseUrl` omitted (not just empty) is `WorkerInitOptions`'s own documented way to
    // say "no target at all" — `main.tsx` now honors it. The transport object still gets built
    // above either way (constructing it is cheap and side-effect-free); what changes is whether
    // `WorkerDb.start()` ever calls it.
    hasSyncTarget: opts.syncBaseUrl !== undefined,
    // B-585: no server will run `ref-pages.ts` for these writes — none configured (Capacitor's
    // "Just this device"), or no credential (the web/desktop "Just this device": same origin, but
    // the token is fixed at startup and absent, so nothing ever pushes). Only then does the
    // client mint referenced pages itself; see `WorkerDbOptions.localReferencePages`.
    localReferencePages: opts.syncBaseUrl === undefined || !opts.token,
    onChange: (e) => safeCall(changeListener, e),
    onSyncStatus: (s) => safeCall(statusListener, s),
  });
  await db.start();
  return {
    db,
    storage,
    storageError,
    exportBytes: leader ? opened.exportBytes : undefined,
    unnamespacedReplica: leader ? opened.inspected : undefined,
    discard: leader ? opened.discard : undefined,
  };
}

/**
 * B (docs/proposals/004): `retry.call(fn)` replaces the old bare `requireDb().then(db => db.fn())`
 * for every method below — a query that fails after a `resume` event gets one reopen-and-retry
 * against a fresh `openDb()` (research/08 §1.3's OPFS-closes-on-background failure) instead of
 * propagating and leaving the app stuck, the same tolerance B-569 already gave the sync layer.
 * `initOpts` is remembered so a reopen can use the exact options `init()` was first called with.
 */
let retry: ResumeRetry<OpenedDb> | undefined;
let initOpts: WorkerInitOptions | undefined;

function requireRetry(): ResumeRetry<OpenedDb> {
  if (!retry) throw new Error("WorkerApi.init() must be called before any other method");
  return retry;
}

const api: WorkerApi = {
  async init(opts) {
    if (!retry) {
      initOpts = opts;
      retry = createResumeRetry(
        () => openDb(opts),
        () => openDb(initOpts as WorkerInitOptions),
      );
    }
    const { db, storage, storageError, unnamespacedReplica } = await retry.current();
    return { deviceId: db.getDeviceId(), storage, storageError, unnamespacedReplica };
  },

  async nextHlc() {
    return requireRetry().call((o) => o.db.nextHlc());
  },

  async getDeviceId() {
    return requireRetry().call((o) => o.db.getDeviceId());
  },

  async applyLocalOps(ops: Op[]) {
    return requireRetry().call((o) => o.db.applyLocalOps(ops));
  },

  async replayLocalOps(ops: Op[]) {
    return requireRetry().call((o) => o.db.replayLocalOps(ops));
  },

  async getPageTree(pageId: string) {
    return requireRetry().call((o) => o.db.getPageTree(pageId));
  },

  async getJournalStream(opts) {
    return requireRetry().call((o) => o.db.getJournalStream(opts));
  },

  async query(sql: string, params: unknown[] = []) {
    return requireRetry().call((o) => o.db.query(sql, params));
  },

  async onChange(cb) {
    // `openDb()` already wired `WorkerDb`'s onChange to `(e) => safeCall(changeListener, e)` —
    // `changeListener` is this module's shared mutable binding, so updating it here is enough;
    // no need to re-register with `WorkerDb` itself.
    changeListener = cb;
  },

  async onSyncStatus(cb) {
    statusListener = cb;
  },

  async getSyncStatus() {
    return requireRetry().call((o) => o.db.getSyncStatus());
  },

  async notifyLifecycle(kind) {
    // Arm the retry BEFORE the call below can itself hit the stale connection.
    if (kind === "resume") requireRetry().onResume();
    return requireRetry().call((o) => o.db.notifyLifecycle(kind));
  },

  async forceSync() {
    await requireRetry().call((o) => o.db.forceSync());
  },

  async exportSnapshot() {
    const o = await requireRetry().current();
    return o.exportBytes?.();
  },

  async discardReplica() {
    const o = await requireRetry().current();
    if (!o.discard) {
      throw new Error(
        o.storage === "follower"
          ? "another tab of this graph is open and holds its local copy; close it and try again"
          : "this browser could not open its local storage this session, so there is no local copy to remove now",
      );
    }
    // Stop pushing and pulling first: the replica is about to be closed under the sync client.
    o.db.sync.dispose();
    return o.discard();
  },
};

Comlink.expose(api);
