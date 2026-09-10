/**
 * Generic `dry_run` support (every write op besides `batch`, which implements its own two-phase
 * apply-once-for-real logic directly — see `./batch.ts`). Runs `fn` against the REAL `ctx` inside
 * a `Savepoint` (`@vrite/core`'s `SqlDriver.savepoint()`, see `driver.ts`'s doc for why this
 * exists instead of a nested SQL transaction the driver's own `transaction()` could issue) that is
 * unconditionally rolled back afterward — so the handler's normal async logic (real `ctx.applyOps`
 * calls, real id/order-key allocation, real conflict checks) executes for real, and the actual
 * database still ends up completely untouched.
 *
 * The caller (`registry.ts`'s `runOpHandler`) already holds `writeLock` for this op's entire
 * handler execution, so no concurrent write can land inside this savepoint's scope — see
 * `./trial-lock.ts` for why that matters here specifically.
 */

import type { OpContext } from "./registry.js";

export async function runWithDryRun<T>(
  ctx: OpContext,
  dryRun: boolean,
  fn: (ctx: OpContext) => Promise<T> | T,
): Promise<T> {
  if (!dryRun) return fn(ctx);
  const sp = ctx.db.savepoint();
  try {
    return await fn(ctx);
  } finally {
    // ALWAYS rolled back, success or failure: a dry run must never leave a trace.
    sp.rollback();
  }
}
