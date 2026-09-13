/**
 * `block.collapseAll` / `block.expandAll` (docs/spec/commands-and-keymap.md R26) as pure
 * "tree in, ops out" functions, like `./commands.ts`. `BlockTree` commits the ops through the same
 * path every other structural command uses, so the result is one undoable batch of ordinary
 * `collapsed` property writes — synced, mirrored to markdown as `collapsed:: true`, nothing
 * device-local (B-97: both commands were registered and did nothing at all).
 *
 * Two choices that are not obvious:
 *
 * - Only blocks WITH children get an op, and only when their flag actually changes. The spec says
 *   "every block"; a `collapsed` flag on a leaf means nothing on screen, and writing one anyway
 *   would put a `collapsed:: true` line into the mirror of every leaf on the page and an op per
 *   block into the log (on the owner's graph a long page has hundreds of leaves) for no visible
 *   effect.
 *
 * - Zoomed, "Collapse all" leaves the zoom ROOT open. The root is the first row of the zoomed view
 *   the way a page's top-level blocks are its first rows; collapsing it too would fold the whole
 *   view into one line, which is "collapse this block", not "collapse all". "Expand all" does open
 *   the root, since a collapsed root would otherwise hide everything the command just expanded.
 */

import type { Op } from "@nooklet/core";
import { setCollapsed } from "./commands.js";
import { childrenIds, subtreeIds } from "./tree.js";
import type { BlockId, Clock, EditorTree } from "./types.js";

/** Every block in scope, pre-order: the zoom root's subtree (root included) or the whole page. A
 * zoom root that is not in the tree (still loading, or deleted) scopes to nothing rather than
 * silently widening to the whole page. */
function scopeIds(tree: EditorTree, rootBlockId: BlockId | undefined): BlockId[] {
  if (rootBlockId !== undefined) {
    return tree.byId.has(rootBlockId) ? subtreeIds(tree, rootBlockId) : [];
  }
  return childrenIds(tree, null).flatMap((id) => subtreeIds(tree, id));
}

export function setAllCollapsedOps(
  tree: EditorTree,
  rootBlockId: BlockId | undefined,
  collapsed: boolean,
  clock: Clock,
): Op[] {
  const ops: Op[] = [];
  for (const id of scopeIds(tree, rootBlockId)) {
    if (collapsed && id === rootBlockId) continue;
    const block = tree.byId.get(id);
    if (!block || childrenIds(tree, id).length === 0) continue;
    if (block.collapsed === collapsed) continue;
    ops.push(setCollapsed(id, collapsed, clock));
  }
  return ops;
}

/**
 * Whether block `id` still has a row once "Collapse all" has run over `tree` (the tree as it was
 * BEFORE, which is enough: after the command every block with children in scope is collapsed, so
 * the visible rows are exactly the first level). `BlockTree` uses it to end editing or drop a
 * selection whose row just folded away — an editor left attached to an unmounted row swallows
 * every keystroke that follows.
 */
export function rowSurvivesCollapseAll(
  tree: EditorTree,
  rootBlockId: BlockId | undefined,
  id: BlockId,
): boolean {
  if (id === rootBlockId) return true;
  const parentId = tree.byId.get(id)?.parentId ?? null;
  return parentId === (rootBlockId ?? null);
}
