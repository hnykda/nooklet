/**
 * Generic `dry_run` support (every write op besides `batch`, which implements its own two-phase
 * apply-once-for-real logic directly — see `./batch.ts`). Runs `fn` against the REAL `ctx` inside
 * a `Savepoint` (`@nooklet/core`'s `SqlDriver.savepoint()`, see `driver.ts`'s doc for why this
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

/**
 * The text an MCP client reads for a tool result: the op's own `render`, prefixed when the call was
 * a dry run.
 *
 * `render` functions describe what an op did, in the past tense ("merged Alex into @Alex: 19
 * reference(s) rewritten"), and a dry run runs the very same handler — so a preview read exactly
 * like the real thing, and only `structuredContent.dry_run` said otherwise (B-267). An agent acts on
 * the text. Doing this once here, keyed on the `dry_run` field every dry-runnable op returns,
 * covers all of them (page_merge, page_delete, block_update, batch, …) and any op added later,
 * instead of fifteen `render`s each remembering.
 */
export function renderToolText<T>(render: ((out: T) => string) | undefined, out: T): string {
  const text = render ? render(out) : JSON.stringify(out);
  const dryRun =
    typeof out === "object" && out !== null && (out as { dry_run?: unknown }).dry_run === true;
  return dryRun ? `dry run, nothing written: ${text}` : text;
}
