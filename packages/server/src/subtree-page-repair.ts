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
 * The repair is ordinary ops, never a raw UPDATE: every descendant of a block placed in this batch
 * that sits on a different page than its parent gets a server-HLC `block.place` keeping its parent
 * and order and taking the parent's page. Being ops, they are logged (so `verify`'s replay
 * reproduces them), recorded in `changes` with the batch (so `batch.undo` of a move undoes the
 * repair too) and returned as `corrections` (so the pushing device converges at once rather than on
 * its next pull).
 *
 * Why every placed block and not only those whose page differs from the batch's pre-image: a batch
 * can move `x` away and back (`x → Dst`, `c1 → under x on Dst`, `x → Src`). `x` ends where it began,
 * yet `c1` is stranded on `Dst`. The walk is bounded by the placed blocks' subtrees, each block
 * visited once, and an ordinary reorder's subtree is small.
 */

import type { AppliedOpResult, BlockPlace, Op, SqlDriver } from "@nooklet/core";

interface ChildRow {
  id: string;
  page_id: string;
  order_key: string;
}

/**
 * The `block.place` ops that bring every descendant of a block placed in this batch onto its
 * parent's page, minted in the order they must apply: parent before child, because the reducer
 * nulls a `parentId` whose block is not on the same page (rule 24's fallback) — a child repaired
 * before its parent would land at the top level.
 *
 * Placed blocks are walked shallowest first. A placed block inside another placed block's subtree
 * is then reached from the outer walk, with the outer block's page, and not walked again.
 *
 * `mint` stamps a server HLC — passed in rather than imported to keep this module free of
 * `./apply-ops.ts`.
 */
export function planSubtreePageRepair(
  driver: SqlDriver,
  results: readonly AppliedOpResult[],
  mint: (entity: string, place: BlockPlace) => Op,
): Op[] {
  const placed = new Set<string>();
  for (const one of results) {
    if (one.status === "applied" && one.kind === "block.place") placed.add(one.entity);
  }
  if (placed.size === 0) return [];

  const depth = new Map([...placed].map((id) => [id, depthOf(driver, id)]));
  const ordered = [...placed].sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));
  const ops: Op[] = [];
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
      for (const child of childrenOf(driver, parentId)) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        if (child.page_id !== pageId) {
          ops.push(mint(child.id, { pageId, parentId, order: child.order_key }));
        }
        queue.push([child.id, pageId]);
      }
    }
  }
  return ops;
}

function childrenOf(driver: SqlDriver, parentId: string): ChildRow[] {
  return driver.all<ChildRow>(
    "SELECT id, page_id, order_key FROM block WHERE parent_id = ? AND deleted_at IS NULL ORDER BY order_key, id",
    [parentId],
  );
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
