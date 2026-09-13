/**
 * Apply a handler's batch so that a rejected op leaves nothing behind (docs/BUGS.md B-122).
 *
 * `ctx.applyOps` is `serverApplyOps`, which commits its own transaction. Core rejects ops one at a
 * time and applies the rest, which is right for a sync push (every device must converge on the
 * same per-op decisions) and wrong for a refactor the caller asked for as one unit: `block.to_page`
 * used to replace the block's text with the link, have the page create and the moves rejected, and
 * answer 400 — with the text already gone and no `batch_id` to undo it by. A handler that means
 * "all of this or none of it" runs its batch here instead: inside a savepoint, rolled back before
 * the error is thrown.
 *
 * Same mechanism, and the same `writeLock` invariant, as `./dry-run.ts`: the savepoint spans only
 * microtask `await`s. As with a dry run, `serverApplyOps` pokes live clients before the rollback;
 * that costs them one empty pull.
 */

import type { Op } from "@nooklet/core";
import { type OpContext, OpError } from "./registry.js";

export async function applyAllOrNothing(
  ctx: OpContext,
  ops: Op[],
  what: string,
): Promise<Awaited<ReturnType<OpContext["applyOps"]>>> {
  const sp = ctx.db.savepoint();
  try {
    const result = await ctx.applyOps(ops);
    const rejected = result.results.find((r) => r.status === "rejected");
    if (rejected) {
      sp.rollback();
      throw new OpError(
        "invalid",
        `${what} rejected: ${rejected.reason} (${rejected.kind} on ${rejected.entity}); nothing was written`,
      );
    }
    sp.release();
    return result;
  } catch (e) {
    sp.rollback(); // idempotent after the rollback above
    throw e;
  }
}
