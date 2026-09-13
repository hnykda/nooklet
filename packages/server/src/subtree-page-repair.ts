/**
 * Children follow their parent's page (docs/BUGS.md B-120) — the server's second repair pass,
 * next to rule 24's cycle correction in `serverApplyOps` (`./apply-ops.ts`).
 *
 * `@nooklet/core`'s `applyBlockPlace` changes exactly the row an op names. That is right — one op,
 * one row is what keeps replay trivial — but it means a `block.place` that takes a block to another
 * page leaves every descendant on the old page with a parent on the new one, where neither page's
 * tree query finds them. B-85 fixed that for moves the server plans itself: the op layer spells
 * the subtree out (`data-api.ts#subtreePlaceOps`). It cannot fix a move the server did not plan.
 * Device B reorders `x` on `Src` without having pulled the server's "move `x` to `Dst`"; B's op has
 * the later HLC, LWW lets it win, `x` goes back to `Src` — and the children the server moved stay on
 * `Dst`. Only the server ever holds both ops, so the repair has to happen here.
 *
 * The repair is ordinary ops, never a raw UPDATE: every descendant (tombstoned ones too) of a
 * block that changed page in this batch, sitting on a different page than its parent, gets a
 * server-HLC `block.place` keeping its parent and order and taking the parent's page. Being ops,
 * they are logged (so `verify`'s replay reproduces them), recorded in `changes` with the batch (so
 * `batch.undo` of a move undoes the repair too) and returned as `corrections` (so the pushing
 * device converges at once rather than on its next pull).
 *
 * Which blocks are walked: those with an applied `block.place` whose page differs from the block's
 * page before the batch. That is exactly the set of blocks that changed page at SOME point in the
 * batch — resolving a place never changes its `pageId` — so a batch that moves `x` away and back
 * (`x → Dst`, `c1 → under x on Dst`, `x → Src`) still walks `x` and brings `c1` home. A child whose
 * own op moved it is consistent with its parent at that moment (the reducer checks), so only a
 * parent's page change can break an edge; walking page-changed blocks covers every broken edge.
 * An ordinary reorder or indent within a page walks nothing.
 */

import type { AppliedOpResult, BlockPlace, Op, SqlDriver } from "@nooklet/core";
import { childLookup } from "./block-children.js";
import type { BlockChangeSnapshot, PageChangeSnapshot } from "./rows.js";

type Snapshots = ReadonlyMap<string, PageChangeSnapshot | BlockChangeSnapshot | null>;

/**
 * The `block.place` ops that bring every descendant of a page-changing block onto its parent's
 * page, minted in the order they must apply: parent before child, because the reducer nulls a
 * `parentId` whose block is not on the same page (rule 24's fallback) — a child repaired before its
 * parent would land at the top level.
 *
 * Page-changing blocks are walked shallowest first. One inside another's subtree is then reached
 * from the outer walk, with the outer block's page, and not walked again.
 *
 * `ops`/`results` are what the batch applied so far (incoming ops plus any cycle correction);
 * `before` is its pre-image. `mint` stamps a server HLC — passed in rather than imported to keep
 * this module free of `./apply-ops.ts`.
 */
export function planSubtreePageRepair(
  driver: SqlDriver,
  ops: readonly Op[],
  results: readonly AppliedOpResult[],
  before: Snapshots,
  mint: (entity: string, place: BlockPlace) => Op,
): Op[] {
  const applied = new Set(results.filter((r) => r.status === "applied").map((r) => r.id));
  const moved = new Set<string>();
  for (const op of ops) {
    if (op.payload.kind !== "block.place" || !applied.has(op.id)) continue;
    const prior = before.get(op.entity);
    if (prior && "place" in prior && prior.place.pageId !== op.payload.place.pageId) {
      moved.add(op.entity);
    }
  }
  if (moved.size === 0) return [];

  // Tombstoned children included: a deleted child left on the old page kept `parent_id` pointing
  // at a block on the new one, so `trash.list` offered it and `trash.restore` brought it back onto
  // neither page (B-120, F2). Core keeps its possibly-deleted parent because the repair op names
  // the parent it already has.
  const children = childLookup(driver);
  const depth = new Map([...moved].map((id) => [id, depthOf(driver, id)]));
  const ordered = [...moved].sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));
  const repairs: Op[] = [];
  const visited = new Set<string>();
  for (const rootId of ordered) {
    if (visited.has(rootId)) continue;
    visited.add(rootId);
    const root = driver.get<{ page_id: string }>("SELECT page_id FROM block WHERE id = ?", [
      rootId,
    ]);
    if (!root) continue;
    const queue: Array<[string, string]> = [[rootId, root.page_id]];
    while (queue.length > 0) {
      const [parentId, pageId] = queue.shift() as [string, string];
      for (const child of children(parentId)) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        if (child.page_id !== pageId) {
          repairs.push(mint(child.id, { pageId, parentId, order: child.order_key }));
        }
        queue.push([child.id, pageId]);
      }
    }
  }
  return repairs;
}

function depthOf(driver: SqlDriver, id: string): number {
  let depth = 0;
  let cur = driver.get<{ parent_id: string | null }>("SELECT parent_id FROM block WHERE id = ?", [
    id,
  ]);
  while (cur?.parent_id && depth < 1000) {
    depth++;
    cur = driver.get<{ parent_id: string | null }>("SELECT parent_id FROM block WHERE id = ?", [
      cur.parent_id,
    ]);
  }
  return depth;
}
