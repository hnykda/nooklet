/**
 * Helpers converting between the outline tree and flat Block rows.
 */

import { newId } from "./ids.js";
import type { Block, OutlineNode, PageId } from "./model.js";
import { compareOrder, ordersBetween } from "./order.js";

export interface OutlineToBlocksOptions {
  now?: number;
  /** Keep ids from `id::` properties (default true). */
  keepIds?: boolean;
}

/** Flatten a tree into Block rows with fresh order keys. Ids are kept when present. */
export function outlineToBlocks(
  nodes: OutlineNode[],
  pageId: PageId,
  opts: OutlineToBlocksOptions = {},
): Block[] {
  const now = opts.now ?? Date.now();
  const keepIds = opts.keepIds ?? true;
  const out: Block[] = [];
  const visit = (siblings: OutlineNode[], parentId: string | null): void => {
    const orders = ordersBetween(null, null, siblings.length);
    siblings.forEach((node, idx) => {
      const id = keepIds && node.id ? node.id : newId();
      out.push({
        id,
        pageId,
        parentId,
        order: orders[idx] as string,
        content: node.content,
        marker: node.marker,
        priority: node.priority,
        properties: { ...node.properties },
        collapsed: node.collapsed,
        createdAt: now,
        updatedAt: now,
      });
      visit(node.children, id);
    });
  };
  visit(nodes, null);
  return out;
}

/** Rebuild the tree from flat rows (any order). Unknown parents are treated as top-level. */
export function blocksToOutline(
  blocks: Block[],
  opts: { includeIds?: boolean } = {},
): OutlineNode[] {
  const includeIds = opts.includeIds ?? true;
  const byId = new Map<string, Block>(blocks.map((b) => [b.id, b]));
  const children = new Map<string | null, Block[]>();
  for (const b of blocks) {
    const parent = b.parentId !== null && byId.has(b.parentId) ? b.parentId : null;
    const list = children.get(parent);
    if (list) list.push(b);
    else children.set(parent, [b]);
  }
  for (const list of children.values()) list.sort((a, b) => compareOrder(a.order, b.order));

  const build = (parentId: string | null): OutlineNode[] =>
    (children.get(parentId) ?? []).map((b) => {
      const node: OutlineNode = {
        content: b.content,
        marker: b.marker,
        priority: b.priority,
        properties: { ...b.properties },
        collapsed: b.collapsed,
        children: build(b.id),
      };
      if (includeIds) node.id = b.id;
      return node;
    });
  return build(null);
}
