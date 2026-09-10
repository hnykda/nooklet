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

/**
 * A nested, independently-decidable unit of work opened by `SqlDriver.savepoint()`.
 *
 * WHY THIS EXISTS, separately from `transaction(fn)`: `transaction()`'s callback must be
 * SYNCHRONOUS — that is what lets it count reentrant nested calls on the same connection and
 * bracket only the outermost one with `BEGIN`/`COMMIT`. Trial execution (a `dry_run`, or `batch`'s
 * atomic apply, both in `packages/server/src/ops/`) needs to run a chain of real op handlers that
 * `await` at least once each — and some handlers call back into the write path (`applyOps`, which
 * itself uses `transaction()`) more than once before the trial's outcome is known — then decide,
 * only once every `await` has settled, whether to keep or discard everything. That "run async
 * work, decide afterwards" shape cannot be expressed as `transaction(fn)`'s synchronous callback,
 * so `savepoint()` hands back the SQL-level primitive directly: open it, run whatever
 * `async`/`await` logic you like against the driver in the meantime (including further nested
 * `transaction()`/`savepoint()` calls — see `./node-sqlite-driver.ts` for how they share one depth
 * counter), then call exactly one of `release()`/`rollback()` once the outcome is known.
 */
export interface Savepoint {
  /** Keep everything done since `savepoint()` was called (commits it, if this was the outermost
   * open transaction). Idempotent: a second call, or a call after `rollback()`, is a no-op. */
  release(): void;
  /** Undo everything done since `savepoint()` was called. Idempotent: a second call, or a call
   * after `release()`, is a no-op. */
  rollback(): void;
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
  /** Open a `Savepoint` for trial execution that spans `await`s — see `Savepoint`'s doc for why
   * this exists alongside `transaction()`. Shares its "is a transaction already open" bookkeeping
   * with `transaction()`, so a `transaction()` call made while a `Savepoint` is open correctly
   * nests instead of issuing a conflicting `BEGIN`. */
  savepoint(): Savepoint;
}
