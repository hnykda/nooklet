/**
 * Op-log GC (research/03-sync.md §6.5): "delete ops with `server_seq < min(device.acked_seq)`
 * after a snapshot" — the floor is `MIN(device.acked_seq)` over every known device, so by
 * construction *no device's next `pull?since=` will ever be less than it* (a device cannot be
 * behind the minimum of everyone's acked position, itself included). Rows at or before the floor
 * are therefore pure history no *legitimate protocol request* will ever ask for again, and GC only
 * ever deletes rows from the `op` audit table — it must never touch the state tables, which already
 * hold the fully materialized result of every op ever applied, independent of whether the log still
 * contains the ops that produced it.
 *
 * This module is pure bookkeeping over an already-fetched `LoggedOp[]` plus a floor:
 * `packages/server` computes the floor (`MIN(device.acked_seq)` over its `device` table, which
 * this package has no notion of) and performs the actual `DELETE FROM op`; `planOpLogGc` only
 * decides which rows are covered.
 *
 * Safety property (asserted in `sync.property.test.ts`'s "op-log GC" tests, not re-derived here):
 * a replica that has already applied exactly `drop` (i.e. is caught up to the floor — which, again,
 * every real device already is) reaches the true current state by applying `retain` on top, via the
 * ordinary `applyOps` path. Equivalently: `rebuild(driver, drop)` then `applyOps(driver, retain)`
 * reproduces `rebuild(driver, drop.concat(retain))` — splitting a replay at the floor changes
 * nothing, because both halves only ever process ops in the same forward, HLC-ordered sequence
 * `rebuild()` would use for the whole log at once.
 *
 * A MISUSE THIS MODULE DOES *NOT* GUARANTEE SAFE, found while writing that property test: do not
 * take a snapshot of the *current* state and then blindly reapply every op in `retain` on top of
 * it, expecting a no-op. `applyOps`'s `block.place` handling (`resolvePlace` in `apply-ops.ts`)
 * resolves a parent reference against whatever the driver looks like *right now* — "does this
 * parent still exist and is it live" — with no notion of "as of when this op was first processed".
 * Reprocessing an old `block.place` op against a driver that has since moved *past* it (e.g. the
 * referenced parent was deleted by a later op already baked into "current") can silently null out a
 * parent that op never actually detached, changing the outcome. In ordinary push/pull this can never
 * happen because every op is guarded by the `op` table's own "already recorded -> skip" check
 * (`applyOps` in `apply-ops.ts`) — state and op-log dedup always move together. `retain`'s ops are
 * only safe to (re)apply against a driver that reflects *exactly* `drop`'s effect and nothing from
 * `retain` itself yet (a real `/sync/snapshot` bootstrap always satisfies this: its cursor is
 * whatever the snapshot was taken at, and only ops strictly after that cursor are ever pulled on
 * top of it) — never against an already-current snapshot with the whole tail replayed over it.
 */

import type { LoggedOp } from "../ops.js";

export interface GcPlan {
  /**
   * `seq < floorSeq`: every device has already acknowledged these (by definition of the floor),
   * so `DELETE FROM op WHERE id IN (...)` is safe.
   */
  drop: readonly LoggedOp[];
  /**
   * `seq >= floorSeq`: kept so `GET /sync/pull?since=<n>` for any `n >= floorSeq - 1` keeps
   * working for every device — no device is behind the floor.
   */
  retain: readonly LoggedOp[];
}

/**
 * Partition `log` at `floorSeq` (typically `MIN(device.acked_seq)` across all known devices,
 * computed by the server). Pure and total: touches no driver, has no side effects, and is safe to
 * call speculatively (e.g. to report "how much would GC reclaim right now").
 */
export function planOpLogGc(log: readonly LoggedOp[], floorSeq: number): GcPlan {
  const drop: LoggedOp[] = [];
  const retain: LoggedOp[] = [];
  for (const op of log) {
    if (op.seq < floorSeq) drop.push(op);
    else retain.push(op);
  }
  return { drop, retain };
}
