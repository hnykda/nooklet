/**
 * The RPC surface the DB worker exposes over Comlink (`db.worker.ts` -> `client.ts`). Plain data
 * in, plain data out — every argument/return value must survive the structured clone algorithm
 * Comlink uses, so no `SqlDriver`, no class instances, no functions except the two callback
 * registration methods below (Comlink auto-proxies a function value crossing the boundary, so
 * `client.ts` wraps its callbacks with `Comlink.proxy(cb)` before passing them).
 *
 * This file has NO DOM/WebWorker-lib dependency (plain interfaces only) so it can be imported,
 * type-only, from both the main-thread `tsconfig.json` project and the worker's
 * `tsconfig.worker.json` project without a `lib` conflict.
 */
import type { ApplyOpsResult, Op } from "@nooklet/core";
import type { JournalDayEntry, JournalStreamOptions, PageTreeResult } from "../data/types.js";
import type { SyncStatus } from "../sync/types.js";

export type ChangedTable = "page" | "block" | "block_prop" | "page_prop";

/** Emitted after any write (local or pulled) that could invalidate a resource. Consumers
 * (`../data/store.ts`) invalidate by table name and, when known, by the specific page id(s)
 * touched — "keep it simple": a consumer that only cares about one page checks `pageIds`, a
 * consumer that cares about a whole class of data (e.g. "any block changed") checks `tables`. */
export interface ChangeEvent {
  tables: ChangedTable[];
  pageIds: string[];
}

export type LifecycleKind = "online" | "offline" | "visible" | "hidden" | "pause" | "resume";

export interface WorkerInitOptions {
  /** Base URL for the sync server; omit to run local-only (no transport configured, e.g. tests
   * or a not-yet-paired device). */
  syncBaseUrl?: string;
  /**
   * Bearer token for `/sync/*`. A plain string, not a getter, because these options are
   * structured-cloned to the worker and a function would throw `DataCloneError` — which is why
   * `getToken` below is only usable when a `WorkerDb` is constructed directly (tests).
   */
  token?: string;
  getToken?: () => string | undefined;
}

export interface InitResult {
  deviceId: string;
  /** Where the replica lives. `"memory"` means OPFS was unavailable and nothing is saved locally
   * this session (B-43) — the UI must say so rather than letting someone type for an hour into a
   * database that vanishes on reload. `"follower"` means another tab of this graph holds the
   * local copy (B-81): this tab works from an in-memory replica of the server and its writes
   * reach the other tab through sync, so nothing is lost — it just is not the tab that persists. */
  storage: "opfs" | "memory" | "follower";
  storageError?: string;
}

export interface WorkerApi {
  /** Open (or reuse) the OPFS-backed replica, apply schema if needed, start the sync client.
   * Safe to call once per worker lifetime; the client wrapper (`client.ts`) does this at startup. */
  init(opts: WorkerInitOptions): Promise<InitResult>;

  /** The ONLY way to mutate local state (editor/UI code never writes SQL directly): applies `ops`
   * and enqueues them for push, atomically. */
  applyLocalOps(ops: Op[]): Promise<ApplyOpsResult>;

  /**
   * `applyLocalOps` for a batch an earlier page load handed over and may never have seen applied
   * (`./unapplied-ops.ts`, B-247): ops whose id this replica has already recorded are skipped, so
   * a batch that did land is not queued for push a second time.
   */
  replayLocalOps(ops: Op[]): Promise<{ replayed: number; skipped: number }>;

  /**
   * Mint the next HLC for a local op, from the worker's single `SyncClient` clock. Main-thread
   * code MUST use this rather than constructing its own `Hlc`: an op's id is its HLC, so two
   * clock instances sharing this device's id (one per tab, say) can mint the same id twice, and
   * `applyOps` treats an already-known id as applied — silently dropping the second write.
   */
  nextHlc(): Promise<string>;

  /** This replica's device id, to pair with `nextHlc()` when building ops. */
  getDeviceId(): Promise<string>;

  /** "Give me this page's block tree" (task item 6). `undefined` if the page does not exist. */
  getPageTree(pageId: string): Promise<PageTreeResult | undefined>;

  /** "Give me the journal stream" (task item 6): today (virtual if empty) plus earlier non-empty
   * days, most recent first. */
  getJournalStream(opts: JournalStreamOptions): Promise<JournalDayEntry[]>;

  /** Escape hatch for read-only queries the two domain methods above don't cover yet (search,
   * references, tasks, properties — all later milestones' concern, not this one's). Positional
   * `?` params only, mirroring `SqlDriver.all`. Deliberately not generic: a Comlink RPC boundary
   * carries plain structurally-cloned data, not type information, so the generic cast belongs at
   * the call site — see `../data/store.ts`/`client.ts`'s typed wrapper around this method. */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;

  /** Register the (sole) change listener — a single slot; a second call replaces the first.
   * Call with `Comlink.proxy(cb)`. Only `client.ts` calls this, once, and fans out (B-130). */
  onChange(cb: (e: ChangeEvent) => void): Promise<void>;

  /** Register the (sole) sync-status listener; same single slot and fan-out as `onChange`. */
  onSyncStatus(cb: (s: SyncStatus) => void): Promise<void>;

  getSyncStatus(): Promise<SyncStatus>;

  /** Forward a platform lifecycle event (`../platform`) so the sync client can flush/pull
   * (ADR 005: "flushed on pause/resume/online"). `visibilitychange` cannot be observed from a
   * worker at all, and even `online`/`offline` are more reliably observed on the main thread, so
   * `client.ts` wires `platform.lifecycle.on(...)` to this method rather than the worker listening
   * for these events itself. */
  notifyLifecycle(kind: LifecycleKind): Promise<void>;

  /** Force an immediate push+pull, bypassing the debounce (e.g. a manual "sync now" affordance). */
  forceSync(): Promise<void>;
}
