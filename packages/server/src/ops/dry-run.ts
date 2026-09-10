/**
 * Generic `dry_run` support (every write op besides `batch`, which implements its own two-phase
 * trial+replay directly — see `./batch.ts`). Runs `fn` against `ctx.forkForTrial()`'s throwaway
 * clone instead of `ctx` itself when `dryRun` is true, so the handler's normal async logic (real
 * `ctx.applyOps` calls, real validation) executes for real against the clone and the actual
 * database is never touched. See `./clone-db.ts`'s header comment for why this — rather than a
 * nested SQL transaction/SAVEPOINT — is the mechanism.
 */

import type { OpContext } from "./registry.js";

export async function runWithDryRun<T>(ctx: OpContext, dryRun: boolean, fn: (ctx: OpContext) => Promise<T> | T): Promise<T> {
  return fn(dryRun ? ctx.forkForTrial() : ctx);
}
