/**
 * Storage-agnostic SQL driver interface `applyOps`/`rebuild` write through.
 *
 * `packages/core` MUST run in both Node and the browser (ADR 001), so it never imports a
 * concrete SQL client. This interface is deliberately the smallest surface that both
 * `node:sqlite`'s `DatabaseSync` (see `./node-sqlite-driver.ts`, Node-only) and a future
 * `sqlite-wasm` binding can implement without adapter gymnastics: it mirrors
 * `DatabaseSync.prepare(sql).run(...)/.all(...)/.get(...)` directly rather than inventing a
 * different shape (query builder, ORM, etc).
 */

export interface RunResult {
  /** Rows inserted/updated/deleted by the statement. */
  changes: number;
  /** `rowid` of the last inserted row, when applicable. */
  lastInsertRowid: number | bigint;
}

export interface SqlDriver {
  /** Run DDL or any statement whose result rows are not needed. May contain multiple statements. */
  exec(sql: string): void;
  /** Run one parameterized statement (INSERT/UPDATE/DELETE), positional `?` params. */
  run(sql: string, params?: readonly unknown[]): RunResult;
  /** Run one parameterized query, return every matching row. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[];
  /** Run one parameterized query, return the first matching row or `undefined`. */
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined;
  /** Run `fn` atomically; rolls back and rethrows if `fn` throws. Reentrant. */
  transaction<T>(fn: () => T): T;
}
