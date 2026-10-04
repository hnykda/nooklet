/**
 * Children of a block, tombstoned ones included, without a full-table scan per parent.
 *
 * The only index on `block.parent_id` is `block_children (parent_id, order_key) WHERE deleted_at IS
 * NULL` — partial, so a plain `WHERE parent_id = ?` cannot use it and scans the whole table. Walks
 * that must see tombstoned blocks too (a deleted subtree keeps its shape, and its `path_ref` rows)
 * did exactly that once per visited block, which made them quadratic in the graph: reindexing a
 * 16,000-op batch spent seconds in scans, and the owner's 961-block subtree took 23 s to move
 * (docs/review/2026-09-13-m7-rv-server-sync.md, F8 and the note under B-85).
 *
 * So: live children through the index, per parent; tombstoned children from ONE scan per lookup,
 * taken on first use. Tombstones are few next to live blocks, and a lookup lives for one pass over
 * a state that pass does not change — build a fresh one for each pass.
 */

import type { SqlDriver } from "./driver.js";

export interface ChildRow {
  id: string;
  parent_id: string;
  page_id: string;
  order_key: string;
}

/** Served by `block_children` (asserted in `block-children.test.ts`). */
export const LIVE_CHILDREN_SQL =
  "SELECT id, parent_id, page_id, order_key FROM block WHERE parent_id = ? AND deleted_at IS NULL ORDER BY order_key";

export const TOMBSTONED_CHILDREN_SQL =
  "SELECT id, parent_id, page_id, order_key FROM block WHERE deleted_at IS NOT NULL AND parent_id IS NOT NULL";

/** `parentId -> children`, live and tombstoned, in `order_key` order (ties by id). */
export function childLookup(driver: SqlDriver): (parentId: string) => ChildRow[] {
  let tombstoned: Map<string, ChildRow[]> | undefined;
  return (parentId) => {
    if (!tombstoned) {
      tombstoned = new Map();
      for (const row of driver.all<ChildRow>(TOMBSTONED_CHILDREN_SQL)) {
        const list = tombstoned.get(row.parent_id);
        if (list) list.push(row);
        else tombstoned.set(row.parent_id, [row]);
      }
    }
    const live = driver.all<ChildRow>(LIVE_CHILDREN_SQL, [parentId]);
    const dead = tombstoned.get(parentId);
    if (!dead) return live;
    return [...live, ...dead].sort((a, b) =>
      a.order_key === b.order_key ? (a.id < b.id ? -1 : 1) : a.order_key < b.order_key ? -1 : 1,
    );
  };
}
