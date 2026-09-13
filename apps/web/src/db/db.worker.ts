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
import { openSqliteWasmDriver } from "./sqlite-wasm-driver.js";
import type { ChangeEvent, InitResult, WorkerApi, WorkerInitOptions } from "./worker-api.js";
import { WorkerDb } from "./worker-core.js";

const LEADER_LOCK_NAME = "nooklet-db-writer";

/**
 * Take the writer lock if nobody holds it, and say so. The original version waited on the lock
 * unconditionally, so a second tab of the same graph sat on "Loading…" forever (B-81): its worker
 * was queued behind the first tab's, which holds the lock until it closes. A tab that does not
 * get the lock now becomes a FOLLOWER — it opens an in-memory replica bootstrapped from the
 * server, works normally, and reaches the leader through sync. If the leader closes, a reload
 * makes this tab the leader; taking over live would mean swapping storage under an open session.
 */
function tryBecomeLeader(): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request(LEADER_LOCK_NAME, { ifAvailable: true }, (lock) => {
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
}

let dbPromise: Promise<OpenedDb> | undefined;

async function openDb(opts: WorkerInitOptions): Promise<OpenedDb> {
  const leader = await tryBecomeLeader();
  const opened = await openSqliteWasmDriver(undefined, { memory: !leader });
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
    onChange: (e) => safeCall(changeListener, e),
    onSyncStatus: (s) => safeCall(statusListener, s),
  });
  await db.start();
  return { db, storage, storageError };
}

function requireDb(): Promise<WorkerDb> {
  if (!dbPromise) throw new Error("WorkerApi.init() must be called before any other method");
  return dbPromise.then((o) => o.db);
}

const api: WorkerApi = {
  async init(opts) {
    if (!dbPromise) dbPromise = openDb(opts);
    const { db, storage, storageError } = await dbPromise;
    return { deviceId: db.getDeviceId(), storage, storageError };
  },

  async nextHlc() {
    const db = await requireDb();
    return db.nextHlc();
  },

  async getDeviceId() {
    const db = await requireDb();
    return db.getDeviceId();
  },

  async applyLocalOps(ops: Op[]) {
    const db = await requireDb();
    return db.applyLocalOps(ops);
  },

  async replayLocalOps(ops: Op[]) {
    const db = await requireDb();
    return db.replayLocalOps(ops);
  },

  async getPageTree(pageId: string) {
    const db = await requireDb();
    return db.getPageTree(pageId);
  },

  async getJournalStream(opts) {
    const db = await requireDb();
    return db.getJournalStream(opts);
  },

  async query(sql: string, params: unknown[] = []) {
    const db = await requireDb();
    return db.query(sql, params);
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
    const db = await requireDb();
    return db.getSyncStatus();
  },

  async notifyLifecycle(kind) {
    const db = await requireDb();
    db.notifyLifecycle(kind);
  },

  async forceSync() {
    const db = await requireDb();
    await db.forceSync();
  },
};

Comlink.expose(api);
