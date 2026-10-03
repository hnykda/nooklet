/**
 * `WorkerDb`: every bit of the DB worker's logic that talks only to a `SqlDriver` and is
 * therefore testable with `@nooklet/core`'s Node driver, with NO sqlite-wasm/OPFS/Comlink/worker
 * dependency at all (see `worker-core.test.ts`). `db.worker.ts` is the thin, browser-only shell
 * around this class: it builds the real `SqlDriver` (`./sqlite-wasm-driver.ts`) and the real
 * `SyncTransport` (`../sync/http-transport.ts`), constructs a `WorkerDb`, and `Comlink.expose`s a
 * `WorkerApi` (`./worker-api.ts`) that mostly just forwards to this class's methods.
 *
 * This split is the answer to the "SqlDriver is sync, the worker boundary is async" tension the
 * task called out: `@nooklet/core`'s `applyOps`/`rebuild` run in here, synchronously, against
 * whatever `SqlDriver` was handed in (real OPFS db in production, in-memory Node db in tests) —
 * core's sync contract is honored because it never crosses a `postMessage` boundary. Only this
 * class's own methods (all synchronous, since queries are synchronous the moment the driver is)
 * get wrapped as `async` by `db.worker.ts`'s Comlink-exposed object, which is the one place the
 * sync/async boundary is actually crossed.
 */
import {
  type ApplyOpsResult,
  type BlockRow,
  getBlock,
  getPage,
  initSchema,
  listChildren,
  type Op,
  type PageRow,
  type SqlDriver,
} from "@nooklet/core";
import { buildBlockTree } from "../data/tree.js";
import type {
  BlockTreeNode,
  JournalDayEntry,
  JournalStreamOptions,
  PageTreeResult,
} from "../data/types.js";
import { SyncClient } from "../sync/sync-client.js";
import type { SyncStatus, SyncTransport } from "../sync/types.js";
import { ensureClientIndexes, initClientSchema } from "./schema-client.js";
import type { ChangedTable, ChangeEvent, LifecycleKind } from "./worker-api.js";

/** Apply `@nooklet/core`'s schema plus this app's client-only tables, but only on a genuinely
 * empty database — `initSchema`'s plain `CREATE TABLE` (no `IF NOT EXISTS`) would otherwise throw
 * on every subsequent worker start against the same OPFS file. */
function ensureSchema(driver: SqlDriver): void {
  const exists = driver.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'page'",
  );
  if (!exists) {
    initSchema(driver);
    initClientSchema(driver);
  }
  // Every open, fresh or not: an existing replica gets indexes added since it was created.
  ensureClientIndexes(driver);
}

/** Every block of a page, depth-first, reusing `@nooklet/core`'s exported `listChildren` so this
 * file never duplicates its row-mapping logic. One round trip per tree level, not per graph —
 * fine for the local, synchronous, in-worker SQLite this always runs against. */
function collectPageBlocks(
  driver: SqlDriver,
  pageId: string,
  parentId: string | null = null,
): BlockRow[] {
  const children = listChildren(driver, pageId, parentId);
  const all: BlockRow[] = [];
  for (const child of children) {
    all.push(child);
    all.push(...collectPageBlocks(driver, pageId, child.id));
  }
  return all;
}

/**
 * Every live block's generic properties on one page, in one query rather than one per block (the
 * journal stream builds a dozen page trees per render). `value IS NOT NULL`: a removed property is
 * a tombstone row with a null value, kept for last-writer-wins, not a property.
 */
function collectPageProperties(
  driver: SqlDriver,
  pageId: string,
): Map<string, Record<string, string>> {
  const rows = driver.all<{ block_id: string; key: string; value: string }>(
    `SELECT bp.block_id, bp.key, bp.value FROM block_prop bp
     JOIN block b ON b.id = bp.block_id
     WHERE b.page_id = ? AND b.deleted_at IS NULL AND bp.value IS NOT NULL
     ORDER BY bp.block_id, bp.key`,
    [pageId],
  );
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const bag = out.get(r.block_id);
    if (bag) bag[r.key] = r.value;
    else out.set(r.block_id, { [r.key]: r.value });
  }
  return out;
}

/** A page's whole block tree, generic properties included. */
function pageBlockTree(driver: SqlDriver, pageId: string): BlockTreeNode[] {
  return buildBlockTree(
    collectPageBlocks(driver, pageId),
    null,
    collectPageProperties(driver, pageId),
  );
}

function findPageByJournalDay(driver: SqlDriver, day: number): PageRow | null {
  const row = driver.get<{ id: string }>(
    "SELECT id FROM page WHERE journal_day = ? AND deleted_at IS NULL",
    [day],
  );
  return row ? (getPage(driver, row.id) ?? null) : null;
}

const ALL_TABLES: ChangedTable[] = ["page", "block", "block_prop", "page_prop"];

export interface WorkerDbOptions {
  driver: SqlDriver;
  transport: SyncTransport;
  /** B-567: whether `transport` actually points anywhere. Defaults to `true` (every existing
   * caller/test already assumes a real or at-least-attempted target) so only `db.worker.ts` — the
   * one place that knows whether `WorkerInitOptions.syncBaseUrl` was genuinely omitted — needs to
   * opt out. When `false`, `start()` skips bootstrap/connectLive/pull entirely rather than
   * attempting (and, since B-566, timing out) against a target that is known not to exist, on
   * every single cold start for a device that will never have one — see
   * `docs/proposals/004-capacitor-storage-durability.md`'s sibling problem statement. */
  hasSyncTarget?: boolean;
  onChange?: (e: ChangeEvent) => void;
  onSyncStatus?: (s: SyncStatus) => void;
}

export class WorkerDb {
  readonly driver: SqlDriver;
  readonly sync: SyncClient;
  private readonly hasSyncTarget: boolean;
  private onChangeCb: ((e: ChangeEvent) => void) | undefined;

  constructor(opts: WorkerDbOptions) {
    this.driver = opts.driver;
    ensureSchema(this.driver);
    this.hasSyncTarget = opts.hasSyncTarget ?? true;
    this.onChangeCb = opts.onChange;
    this.sync = new SyncClient({
      driver: this.driver,
      transport: opts.transport,
      onStatus: opts.onSyncStatus,
      onAppliedOps: (ops) => this.notifyFromOps(ops),
      onBootstrap: () => this.notify(ALL_TABLES, []),
    });
    this.sync.init();
  }

  /** Bootstrap-if-needed, then start the live poke and an initial pull. Call once at startup;
   * safe to call even offline (bootstrap/pull failures just leave the client in "offline"
   * status — see `SyncClient`).
   *
   * B-569: `connectLive()` used to be called unguarded. It normally only ever registers a
   * `WebSocket` and returns, but its URL construction (`http-transport.ts#wsUrl`) throws
   * synchronously if resolving `/sync/live` against this worker's own `self.location` fails —
   * which it does in the Capacitor iOS shell with no server configured (`self.location` inside a
   * dedicated Worker loaded from the `capacitor://` scheme does not resolve a relative `URL()`
   * the way it does on web/PWA). An uncaught throw here rejects `start()`, which rejects the
   * cached `dbPromise` in `db.worker.ts#openDb` PERMANENTLY — every later `requireDb()` call
   * (`getPageTree`, `getJournalStream`, `query`: the outliner, the sidebar, everything) rejects
   * too, for the rest of this worker's life, and with no `ErrorBoundary` anywhere in the app
   * (B-400) the UI just freezes on whatever it rendered first — the "Loading…" placeholder.
   * `bootstrap()`'s failure was always tolerated this way; `connectLive()`/`pull()`'s needs to be
   * too, for the same reason: nothing here may be allowed to leave `start()` unable to resolve.
   *
   * B-567: none of the three calls below are even attempted when `hasSyncTarget` is `false` — a
   * failed `bootstrap()` never marks `isBootstrapped()`, so without this a device with definitively
   * nothing to reach would retry (and, since B-566, time out) on every cold start, not just the
   * first. A device that merely can't reach a *configured* target right now still retries exactly
   * as before; this only skips the attempt when there is provably no target at all. */
  async start(): Promise<void> {
    if (!this.hasSyncTarget) return;
    if (!this.sync.isBootstrapped()) {
      try {
        await this.sync.bootstrap();
      } catch {
        // No network yet / first run offline: proceed with an empty local replica. The editor
        // can still create pages/blocks locally; they queue in pending_op like anything else and
        // push once online. A real "am I usable yet" gate is a views-agent UI concern.
      }
    }
    try {
      this.sync.connectLive();
    } catch {
      // Same tolerance as bootstrap() above — a live connection is a nicety, not a precondition
      // for local usability, and the whole point of this method is that it cannot fail to return.
    }
    void this.sync.pull().catch(() => {});
  }

  onChange(cb: (e: ChangeEvent) => void): void {
    this.onChangeCb = cb;
  }

  getDeviceId(): string {
    return this.sync.getDeviceId();
  }

  /** The device's one authoritative clock (see `WorkerApi.nextHlc`'s note on why there must
   * only ever be one). */
  nextHlc(): string {
    return this.sync.nextHlc();
  }

  getSyncStatus(): SyncStatus {
    return this.sync.getStatus();
  }

  notifyLifecycle(kind: LifecycleKind): void {
    switch (kind) {
      case "online":
      case "resume":
      case "visible":
        this.sync.schedulePush(0);
        void this.sync.pull();
        return;
      case "offline":
      case "pause":
      case "hidden":
        // Nothing to do proactively; the next local edit still queues durably, and the next
        // online/resume/visible event (or the debounce timer already in flight) flushes it.
        return;
      default: {
        const exhaustive: never = kind;
        throw new Error(`unknown lifecycle kind: ${exhaustive as string}`);
      }
    }
  }

  async forceSync(): Promise<void> {
    await this.sync.flush();
    await this.sync.pull();
  }

  applyLocalOps(ops: readonly Op[]): ApplyOpsResult {
    return this.sync.applyLocal(ops);
  }

  /** See `WorkerApi.replayLocalOps`. The `op` table is the replica's record of every op id it
   * has applied — the same check `@nooklet/core`'s `applyOps` makes — but `applyLocal` would
   * still put an already-recorded op back into `pending_op` and push it again. */
  replayLocalOps(ops: readonly Op[]): { replayed: number; skipped: number } {
    const fresh = ops.filter(
      (op) => this.driver.get("SELECT 1 AS x FROM op WHERE id = ?", [op.id]) === undefined,
    );
    if (fresh.length > 0) this.sync.applyLocal(fresh);
    return { replayed: fresh.length, skipped: ops.length - fresh.length };
  }

  getPageTree(pageId: string): PageTreeResult | undefined {
    const page = getPage(this.driver, pageId);
    if (!page) return undefined;
    return { page, blocks: pageBlockTree(this.driver, pageId) };
  }

  getJournalStream(opts: JournalStreamOptions): JournalDayEntry[] {
    const entries: JournalDayEntry[] = [];

    const todayPage = findPageByJournalDay(this.driver, opts.today);
    entries.push({
      day: opts.today,
      page: todayPage,
      blocks: todayPage ? pageBlockTree(this.driver, todayPage.id) : [],
    });

    // Future days first, and ALL of them: a journal day ahead of today exists because something
    // was deliberately scheduled or written there, so hiding it is the one case where "empty days
    // are not shown" turns into "days you created are not shown". There are normally a handful,
    // so they are not counted against `maxDays` — that window exists to bound scrolling back
    // through years of history, which is a different problem.
    const later = this.driver.all<{ id: string; journal_day: number }>(
      `SELECT id, journal_day FROM page
       WHERE journal_day IS NOT NULL AND journal_day > ? AND deleted_at IS NULL
       ORDER BY journal_day DESC`,
      [opts.today],
    );

    const earlier = this.driver.all<{ id: string; journal_day: number }>(
      `SELECT id, journal_day FROM page
       WHERE journal_day IS NOT NULL AND journal_day < ? AND deleted_at IS NULL
       ORDER BY journal_day DESC LIMIT ?`,
      [opts.today, Math.max(0, opts.maxDays)],
    );
    for (const row of [...later, ...earlier]) {
      const page = getPage(this.driver, row.id);
      if (!page) continue;
      entries.push({
        day: row.journal_day,
        page,
        blocks: pageBlockTree(this.driver, page.id),
      });
    }
    return entries;
  }

  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
    return this.driver.all<T>(sql, params);
  }

  private notify(tables: ChangedTable[], pageIds: readonly string[]): void {
    this.onChangeCb?.({ tables, pageIds: [...new Set(pageIds)] });
  }

  /** Compute which tables/pages a batch of just-applied ops could have changed. Used for local
   * writes, pulled ops, and server corrections alike — see `SyncClient`'s `onAppliedOps`. */
  private notifyFromOps(ops: readonly Op[]): void {
    const tables = new Set<ChangedTable>();
    const pageIds = new Set<string>();
    for (const op of ops) {
      switch (op.payload.kind) {
        case "page.create":
        case "page.rename":
        case "page.delete":
          tables.add("page");
          pageIds.add(op.entity);
          break;
        case "page.prop":
          tables.add("page_prop");
          pageIds.add(op.entity);
          break;
        case "block.create":
          tables.add("block");
          pageIds.add(op.payload.place.pageId);
          break;
        case "block.place":
          tables.add("block");
          pageIds.add(op.payload.place.pageId);
          break;
        case "block.text":
        case "block.delete": {
          tables.add("block");
          const row = getBlock(this.driver, op.entity);
          if (row) pageIds.add(row.pageId);
          break;
        }
        case "block.prop": {
          tables.add("block_prop");
          // Reserved keys — marker, priority, scheduled, deadline, repeat, done, collapsed — are
          // routed by the reducer into the block ROW's own columns, not block_prop. A consumer
          // stamped on `block` (the Tasks view, the tree) therefore never heard about a task
          // being ticked (B-79). Over-invalidating one table on a property write is cheap;
          // missing the write is a list that never updates.
          tables.add("block");
          const row = getBlock(this.driver, op.entity);
          if (row) pageIds.add(row.pageId);
          break;
        }
        default: {
          const exhaustive: never = op.payload;
          void exhaustive;
        }
      }
    }
    this.notify([...tables], [...pageIds]);
  }
}
