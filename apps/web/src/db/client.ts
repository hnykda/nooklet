/**
 * Main-thread entry point to the DB worker. Owns the `Worker`/Comlink plumbing and wires the
 * `platform` adapter's lifecycle events (ADR 005) to the worker's sync client — this is the ONE
 * place `postMessage` async-ness meets the rest of the app. Everything above this file
 * (`../data/store.ts` and up) only ever sees plain async functions and Solid signals/resources.
 */
import type { ApplyOpsResult, Op } from "@nooklet/core";
import * as Comlink from "comlink";
import { platform } from "../platform/index.js";
import type { SyncStatus } from "../sync/types.js";
import type { ChangeEvent, WorkerApi, WorkerInitOptions } from "./worker-api.js";

export type { ChangedTable, ChangeEvent, LifecycleKind } from "./worker-api.js";

let workerApi: Comlink.Remote<WorkerApi> | undefined;
let initPromise: Promise<{ deviceId: string }> | undefined;

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
export function initDb(opts: WorkerInitOptions = {}): Promise<{ deviceId: string }> {
  if (!initPromise) {
    const api = getWorker();
    initPromise = api.init(opts);
    for (const event of ["online", "offline", "visible", "hidden", "pause", "resume"] as const) {
      platform.lifecycle.on(event, () => void api.notifyLifecycle(event));
    }
  }
  return initPromise;
}

export function applyOps(ops: Op[]): Promise<ApplyOpsResult> {
  return getWorker().applyLocalOps(ops);
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

/** Register the sole change listener (`../data/store.ts` is the only intended caller). Comlink
 * requires callbacks crossing the worker boundary to be explicitly wrapped as proxies. */
export function onChange(cb: (e: ChangeEvent) => void): void {
  void getWorker().onChange(Comlink.proxy(cb));
}

export function onSyncStatus(cb: (s: SyncStatus) => void): void {
  void getWorker().onSyncStatus(Comlink.proxy(cb));
}
