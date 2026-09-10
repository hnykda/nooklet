/**
 * Node-only `SqlDriver` adapter over `node:sqlite`'s `DatabaseSync`.
 *
 * IMPORTANT: this file imports `node:sqlite` and MUST NOT be re-exported from `./index.ts` (the
 * package's main barrel, which runs in the browser too — ADR 001). It exists so:
 *   - `packages/core/src/sync/*.test.ts` can exercise `applyOps`/`rebuild` against a real
 *     database instead of a fake/mock driver, and
 *   - `packages/server` can reuse it later (Node is the server runtime) instead of re-writing
 *     the same adapter, by importing it via the package's `./node-sqlite` subpath export
 *     (see `package.json`'s `exports` map) rather than the main `.` entry point.
 * A browser bundler that only ever imports `@nooklet/core`'s main entry point never reaches this
 * file, so it never sees a `node:sqlite` import.
 */

import type { SQLInputValue, StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { RunResult, Savepoint, SqlDriver } from "./driver.js";

/**
 * `applyOps`/`rebuild` only ever bind `null`/`number`/`string` (and here, `bigint` for a
 * generated column read-back) through `SqlDriver`'s deliberately storage-agnostic `unknown[]`
 * params — all values `node:sqlite`'s `SQLInputValue` already accepts. This cast is the one spot
 * that reconciles the driver-agnostic interface with `node:sqlite`'s concrete parameter type.
 */
function toSqlParams(params: readonly unknown[]): SQLInputValue[] {
  return params as SQLInputValue[];
}

export function createNodeSqliteDriver(db: DatabaseSync): SqlDriver {
  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };

  // Shared between `transaction()` and `savepoint()` below: whichever of the two is outermost on
  // this connection owns depth 0 -> 1, and everything nested — whether more `transaction()` calls
  // or more `savepoint()` calls — just increments/decrements past that, never issuing its own
  // `BEGIN` while depth > 0. This is exactly what lets `serverApplyOps` (which always calls
  // `transaction()`) run, unmodified, inside a trial's open `Savepoint`.
  let depth = 0;
  let savepointSeq = 0;

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, params: readonly unknown[] = []): RunResult {
      const r = prepare(sql).run(...toSqlParams(params));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T[] {
      return prepare(sql).all(...toSqlParams(params)) as T[];
    },
    get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): T | undefined {
      return prepare(sql).get(...toSqlParams(params)) as T | undefined;
    },
    transaction<T>(fn: () => T): T {
      if (depth === 0) db.exec("BEGIN");
      depth++;
      try {
        const result = fn();
        depth--;
        if (depth === 0) db.exec("COMMIT");
        return result;
      } catch (err) {
        depth--;
        if (depth === 0) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // best-effort: if the connection is already broken, nothing more to do.
          }
        }
        throw err;
      }
    },
    savepoint(): Savepoint {
      // Unlike `transaction()`, this unconditionally issues `SAVEPOINT` (never `BEGIN`) — SQLite
      // itself treats a `SAVEPOINT` opened with no transaction already in progress as implicitly
      // starting one, and `RELEASE`ing that outermost savepoint later commits it, exactly like
      // `COMMIT` would (https://sqlite.org/lang_savepoint.html). So depth 0 needs no special case
      // here: it "just works" for the same reason `transaction()` needs the special case (it uses
      // the different `BEGIN`/`COMMIT` statements, which SQLite does NOT let nest).
      const name = `sp${++savepointSeq}`;
      db.exec(`SAVEPOINT ${name}`);
      depth++;
      let settled = false;
      return {
        release(): void {
          if (settled) return;
          settled = true;
          depth--;
          db.exec(`RELEASE ${name}`);
        },
        rollback(): void {
          if (settled) return;
          settled = true;
          depth--;
          try {
            db.exec(`ROLLBACK TO ${name}`);
            db.exec(`RELEASE ${name}`);
          } catch {
            // best-effort, mirroring transaction()'s ROLLBACK above: if the connection is already
            // broken, nothing more to do.
          }
        },
      };
    },
  };
}

/** Open an in-memory or file-backed `DatabaseSync` with nooklet's server PRAGMAs (rule 29) applied. */
export function openNodeSqlite(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  return db;
}
