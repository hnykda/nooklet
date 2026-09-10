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
 * A browser bundler that only ever imports `@vrite/core`'s main entry point never reaches this
 * file, so it never sees a `node:sqlite` import.
 */

import type { SQLInputValue, StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { RunResult, SqlDriver } from "./driver.js";

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

  let depth = 0;

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
  };
}

/** Open an in-memory or file-backed `DatabaseSync` with vrite's server PRAGMAs (rule 29) applied. */
export function openNodeSqlite(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  return db;
}
