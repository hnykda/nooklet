/**
 * `SqlDriver` (`@nooklet/core`) over `@sqlite.org/sqlite-wasm`'s OPFS "SAHPool" VFS.
 *
 * WHY sahpool and not the SharedArrayBuffer-based `opfs` VFS: research/08-mobile.md §1.3 and
 * research/03-sync.md §6.9/§4 are explicit that the `opfs` VFS needs COOP/COEP response headers
 * (a deployment requirement we don't want to impose on every self-hosted install) and that it is
 * unusable from inside a Capacitor/Tauri custom-scheme webview (no cross-origin isolation there),
 * while `opfs-sahpool` needs neither and is also faster for the single-writer-tab shape this app
 * already has (leader election below). The cost is "one connection per DB" — which is exactly
 * `db.worker.ts`'s job to guarantee via `navigator.locks` (research/03 §6.9: "One writer tab
 * elected with navigator.locks").
 *
 * NOT unit tested — OPFS/WASM only exist in a real browser. `createSqliteWasmDriver` itself
 * mirrors `@nooklet/core/node-sqlite`'s `createNodeSqliteDriver` structure exactly (prepare-free
 * `exec`/`run`/`all`/`get`, a shared transaction/savepoint depth counter), so its *shape* is
 * proven correct there; only the sqlite-wasm OO1 API calls below are unverified. See
 * apps/web/README.md's "needs manual browser verification" list.
 */
import type { RunResult, Savepoint, SqlDriver } from "@nooklet/core";
// The upstream package ships its own (evolving) types; we only rely on a tiny slice of its OO1
// API, so we declare that slice ourselves and cast through `unknown` rather than depend on the
// package's exact type shape matching across versions.
import sqlite3InitModuleRaw from "@sqlite.org/sqlite-wasm";

interface Sqlite3Db {
  exec(opts: {
    sql: string;
    bind?: unknown[];
    rowMode?: "object";
    resultRows?: Record<string, unknown>[];
  }): unknown;
  changes(): number;
  selectValue(sql: string, bind?: unknown[]): unknown;
  close(): void;
  /** The raw `sqlite3*` C pointer — needed only for `capi.sqlite3_js_db_export` (Option C's
   * checkpoint export), verified against the installed `@sqlite.org/sqlite-wasm` source (it is
   * what the library's own internal export helper passes to that call). */
  pointer: number;
}

interface Sqlite3OpfsSAHPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => Sqlite3Db;
  /** Grow the pool to at least `min` files; resolves to the capacity. */
  reserveMinimumCapacity(min: number): Promise<number>;
  /** Filenames currently associated with a slot in the pool — used to tell "a fresh pool, nothing
   * under this name yet" from "an existing replica" before deciding whether to restore a checkpoint
   * (Option C: restoring over live data would be wrong; restoring into a pool with nothing under
   * this name at all is exactly the post-eviction case it exists for). */
  getFileNames(): string[];
  /** Write a full SQLite file's bytes into a pool slot under `name`, before that name is ever
   * opened with `OpfsSAHPoolDb` — sqlite-wasm's own supported import path (validates the file
   * header itself), verified against the installed package source. Synchronous. */
  importDb(name: string, bytes: Uint8Array): number;
}

/**
 * How many OPFS files the pool must hold before the database is opened: sqlite-wasm's own default
 * `initialCapacity`. SQLite needs one per file it opens: at least the database and, from the first
 * write on, its rollback journal.
 */
const MIN_POOL_CAPACITY = 6;

interface Sqlite3Namespace {
  installOpfsSAHPoolVfs(opts: { name?: string }): Promise<Sqlite3OpfsSAHPoolUtil>;
  /** The plain OO1 API; `new DB()` with no filename is an in-memory database. */
  oo1: { DB: new (filename?: string) => Sqlite3Db };
  /** The C API surface, for the one call Option C's checkpoint needs directly — verified against
   * the installed package source (`sqlite3.capi.sqlite3_js_db_export`). */
  capi: { sqlite3_js_db_export(pDb: number, schema?: number): Uint8Array };
}

type Sqlite3InitModuleFn = (opts?: Record<string, unknown>) => Promise<Sqlite3Namespace>;

const sqlite3InitModule = sqlite3InitModuleRaw as unknown as Sqlite3InitModuleFn;

/**
 * Pure decision for Option C's restore step, pulled out so it is unit-testable without real
 * OPFS/WASM (unlike the rest of this file — see its header): restore only into a pool with nothing
 * under `filename` yet. An existing file means an ordinary replica that must never be overwritten
 * by a possibly-stale checkpoint; nothing under the name at all is exactly the post-eviction case
 * a checkpoint exists to recover from, and app uninstall (which the owner explicitly ruled out of
 * scope) wipes the checkpoint along with everything else in the sandbox, so it can never produce
 * this combination by itself.
 */
export function shouldRestoreCheckpoint(
  existingFileNames: readonly string[],
  filename: string,
  hasCheckpoint: boolean,
): boolean {
  return hasCheckpoint && !existingFileNames.includes(filename);
}

/** Wrap a sahpool `OpfsSAHPoolDb` (or any object satisfying `Sqlite3Db`, e.g. a fake in a future
 * browser-run test) as a `@nooklet/core` `SqlDriver`. */
export function createSqliteWasmDriver(db: Sqlite3Db): SqlDriver {
  let depth = 0;
  let savepointSeq = 0;

  const execRaw = (sql: string): void => {
    db.exec({ sql });
  };

  return {
    exec(sql: string): void {
      execRaw(sql);
    },
    run(sql: string, params: readonly unknown[] = []): RunResult {
      db.exec({ sql, bind: params as unknown[] });
      return {
        changes: db.changes(),
        lastInsertRowid: Number(db.selectValue("SELECT last_insert_rowid()")),
      };
    },
    all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
      const resultRows: Record<string, unknown>[] = [];
      db.exec({ sql, bind: params as unknown[], rowMode: "object", resultRows });
      return resultRows as T[];
    },
    get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T | undefined {
      const resultRows: Record<string, unknown>[] = [];
      db.exec({ sql, bind: params as unknown[], rowMode: "object", resultRows });
      return resultRows[0] as T | undefined;
    },
    // Mirrors @nooklet/core/node-sqlite's createNodeSqliteDriver transaction()/savepoint() shape
    // exactly — see that file's comments for why the depth counter is shared between the two.
    transaction<T>(fn: () => T): T {
      if (depth === 0) execRaw("BEGIN");
      depth++;
      try {
        const result = fn();
        depth--;
        if (depth === 0) execRaw("COMMIT");
        return result;
      } catch (err) {
        depth--;
        if (depth === 0) {
          try {
            execRaw("ROLLBACK");
          } catch {
            // best-effort: connection may already be broken.
          }
        }
        throw err;
      }
    },
    savepoint(): Savepoint {
      const name = `sp${++savepointSeq}`;
      execRaw(`SAVEPOINT ${name}`);
      depth++;
      let settled = false;
      return {
        release(): void {
          if (settled) return;
          settled = true;
          depth--;
          execRaw(`RELEASE ${name}`);
        },
        rollback(): void {
          if (settled) return;
          settled = true;
          depth--;
          try {
            execRaw(`ROLLBACK TO ${name}`);
            execRaw(`RELEASE ${name}`);
          } catch {
            // best-effort, mirroring transaction()'s ROLLBACK above.
          }
        },
      };
    },
  };
}

export interface OpenedSqliteWasm {
  driver: SqlDriver;
  close(): void;
  /**
   * `"opfs"` is the normal case: the replica lives in the origin's private file system and
   * survives reloads. `"memory"` means OPFS could not be opened and the database exists only for
   * this session — everything still works, nothing is saved locally, and the UI must say so.
   */
  storage: "opfs" | "memory";
  /** Why OPFS was unavailable, when it was. */
  storageError?: string;
  /** Raw SQLite file bytes for Option C's periodic native-filesystem checkpoint — `undefined` when
   * `storage` is `"memory"` (nothing durable to export). Reads live state on every call rather than
   * caching, so a caller can call it right before writing a checkpoint and get the current data. */
  exportBytes?: () => Uint8Array;
  /** Whether a checkpoint (`opts.restoreBytes`) was actually used to seed this replica — distinct
   * from `storage === "opfs"`, which is also true for an ordinary existing replica that needed no
   * restore. Lets a caller log/verify the restore path was taken, not just assume it from the
   * inputs it passed in. */
  restored: boolean;
}

/**
 * Open (creating on first run) the OPFS-backed replica and apply nooklet's server PRAGMAs where
 * sahpool supports them. One connection only (sahpool's constraint) — the caller (`db.worker.ts`)
 * must ensure only the elected leader tab ever calls this.
 *
 * Falls back to an in-memory database when OPFS is unavailable (B-43). Before this, an OPFS
 * failure left every worker RPC rejecting with WebKit's `UnknownError: The operation failed for
 * an unknown transient reason` and the app rendered nothing — no message, no way in. A browser
 * without OPFS-in-workers (Playwright's WebKit, some privacy modes, some embedded webviews) now
 * gets a working app whose local copy simply does not persist; with sync configured, the server
 * still has everything, so the loss is a re-bootstrap on the next load, not data.
 *
 * `opts.restoreBytes` (Option C, docs/proposals/004-capacitor-storage-durability.md): only used
 * when the pool has nothing under `filename` yet (`poolUtil.getFileNames()`) — an ordinary existing
 * replica must never be overwritten by a possibly-stale checkpoint, but a pool with nothing under
 * this name at all is exactly the post-eviction case a checkpoint exists to recover from. Restoring
 * happens via `poolUtil.importDb`, sqlite-wasm's own supported path, BEFORE `OpfsSAHPoolDb` ever
 * opens the name — the constructor is what actually associates/opens a pool slot, so this must run
 * first, not as a patch-up after.
 */
export async function openSqliteWasmDriver(
  filename = "/nooklet.sqlite3",
  opts: { memory?: boolean; restoreBytes?: Uint8Array } = {},
): Promise<OpenedSqliteWasm> {
  const sqlite3 = await sqlite3InitModule();
  let db: Sqlite3Db;
  let storage: OpenedSqliteWasm["storage"] = "opfs";
  let storageError: string | undefined;
  let restored = false;
  try {
    // A follower tab (B-81) asks for memory outright: sahpool allows one connection per file, and
    // the leader tab holds it.
    if (opts.memory) throw new Error("memory requested by the caller");
    const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "nooklet-opfs-sahpool" });
    // Topped up on EVERY start, not left to the install (B-323). sqlite-wasm fills the pool only
    // when it finds it empty, one file at a time and asynchronously, so a first start torn down
    // part-way (a reload or navigation in its first tenth of a second) leaves one to five files and
    // no later start adds any. With one, the database took it, the journal had nowhere to go, the
    // schema's first CREATE failed with SQLITE_CANTOPEN, and the app sat on "Loading…" on every
    // start after — the pool lives in OPFS. `e2e/tests/opfs-pool.spec.ts` builds that state.
    await poolUtil.reserveMinimumCapacity(MIN_POOL_CAPACITY);
    if (shouldRestoreCheckpoint(poolUtil.getFileNames(), filename, Boolean(opts.restoreBytes))) {
      poolUtil.importDb(filename, opts.restoreBytes as Uint8Array);
      restored = true;
    }
    db = new poolUtil.OpfsSAHPoolDb(filename);
  } catch (err) {
    storage = "memory";
    storageError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (!opts.memory) {
      console.warn(
        `[nooklet] OPFS is unavailable (${storageError}); running on an in-memory database. ` +
          "Nothing is saved locally this session.",
      );
    }
    db = new sqlite3.oo1.DB();
  }
  const driver = createSqliteWasmDriver(db);
  // docs/spec/sql-schema.md rule 29's client PRAGMAs, scaled for mobile memory; journal_mode is
  // left at sahpool's default (it manages its own durability model, not a real WAL file on OPFS).
  driver.exec("PRAGMA foreign_keys = ON");
  driver.exec("PRAGMA cache_size = -8000");
  driver.exec("PRAGMA temp_store = MEMORY");
  return {
    driver,
    close: () => db.close(),
    storage,
    storageError,
    restored,
    exportBytes:
      storage === "opfs" ? () => sqlite3.capi.sqlite3_js_db_export(db.pointer) : undefined,
  };
}
