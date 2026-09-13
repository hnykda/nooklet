/**
 * Flat `BlockRow[]` (however fetched — order of the input array does not matter) -> nested
 * `BlockTreeNode[]`. Pure and driver-agnostic, so it is unit tested directly (`tree.test.ts`)
 * without touching SQLite at all; `../db/worker-core.ts` is the only caller in this milestone.
 */
import { type BlockRow, compareOrder, type Properties } from "@nooklet/core";
import type { BlockTreeNode } from "./types.js";

const NO_PROPERTIES: Readonly<Properties> = Object.freeze({});

/** `properties` supplies each block's generic `block_prop` bag (B-100/B-101); rows it has nothing
 * for get a shared frozen empty one. */
export function buildBlockTree(
  rows: readonly BlockRow[],
  rootParentId: string | null = null,
  properties?: ReadonlyMap<string, Readonly<Properties>>,
): BlockTreeNode[] {
  const byParent = new Map<string | null, BlockRow[]>();
  for (const row of rows) {
    const bucket = byParent.get(row.parentId);
    if (bucket) bucket.push(row);
    else byParent.set(row.parentId, [row]);
  }

  const build = (parentId: string | null): BlockTreeNode[] => {
    const children = byParent.get(parentId);
    if (!children) return [];
    return [...children]
      .sort((a, b) => compareOrder(a.order, b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => ({
        ...row,
        properties: properties?.get(row.id) ?? NO_PROPERTIES,
        children: build(row.id),
      }));
  };

  return build(rootParentId);
}
