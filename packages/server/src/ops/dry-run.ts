/**
 * Generic `dry_run` support (mcp-tools.md §3.5.3 for `batch`; every other write op declares the
 * same `dry_run` field on its own input). Handlers are `async` (they `await ctx.applyOps`/
 * `ctx.data.*`), so a rollback wrapper built on `SqlDriver.transaction(fn)` (whose `fn` must be
 * synchronous — SQLite's writer connection has no async story) cannot host them directly. A SQL
 * `SAVEPOINT` sidesteps that: it is just another statement run through `db.exec`, independent of
 * `transaction()`'s own BEGIN/COMMIT bookkeeping, so `fn` can freely be async — real writes
 * happen (real id/order-key allocation, real validation, real conflict checks), then get rolled
 * back to the savepoint before the handler returns, so the caller sees no committed state.
 *
 * Known limitation: this assumes single-request-at-a-time use of the writer connection (matching
 * 00-conventions.md's "one writer connection" — a future write-serialization queue is out of
 * scope here); a concurrent write interleaved between the SAVEPOINT and its rollback is not
 * isolated from it. Fine for v1's single-process server under test-scale concurrency.
 */

import type { OpContext } from "./registry.js";

let counter = 0;

export async function runWithDryRun<T>(ctx: OpContext, dryRun: boolean, fn: () => Promise<T> | T): Promise<T> {
  if (!dryRun) return fn();
  const name = `vrite_dry_run_${counter++}`;
  ctx.db.exec(`SAVEPOINT ${name}`);
  try {
    return await fn();
  } finally {
    ctx.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    ctx.db.exec(`RELEASE SAVEPOINT ${name}`);
  }
}
