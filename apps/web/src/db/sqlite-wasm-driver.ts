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
}

interface Sqlite3OpfsSAHPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => Sqlite3Db;
}

interface Sqlite3Namespace {
  installOpfsSAHPoolVfs(opts: { name?: string }): Promise<Sqlite3OpfsSAHPoolUtil>;
}

type Sqlite3InitModuleFn = (opts?: Record<string, unknown>) => Promise<Sqlite3Namespace>;

const sqlite3InitModule = sqlite3InitModuleRaw as unknown as Sqlite3InitModuleFn;

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
}

/** Open (creating on first run) the OPFS-backed replica and apply nooklet's server PRAGMAs where
 * sahpool supports them. One connection only (sahpool's constraint) — the caller (`db.worker.ts`)
 * must ensure only the elected leader tab ever calls this. */
export async function openSqliteWasmDriver(
  filename = "/nooklet.sqlite3",
): Promise<OpenedSqliteWasm> {
  const sqlite3 = await sqlite3InitModule();
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "nooklet-opfs-sahpool" });
  const db = new poolUtil.OpfsSAHPoolDb(filename);
  const driver = createSqliteWasmDriver(db);
  // docs/spec/sql-schema.md rule 29's client PRAGMAs, scaled for mobile memory; journal_mode is
  // left at sahpool's default (it manages its own durability model, not a real WAL file on OPFS).
  driver.exec("PRAGMA foreign_keys = ON");
  driver.exec("PRAGMA cache_size = -8000");
  driver.exec("PRAGMA temp_store = MEMORY");
  return { driver, close: () => db.close() };
}
