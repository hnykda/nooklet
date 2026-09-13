/**
 * Pure helpers over `EditorTree`: build one from a flat block list, read parent/child/order
 * relationships, flatten to visible rows (respecting `collapsed` and an optional zoom root), and
 * clone-and-mutate a working copy (used by the multi-block batch commands in `commands.ts` to
 * chain several structural moves against a consistent snapshot without touching the real store
 * between each one — see `commands.ts`'s `indentSelectedBlocks`/`outdentSelectedBlocks`).
 *
 * No DOM, no Solid, no `@nooklet/core` sync/driver code: this is the same "testable without a
 * real DOM" seam as `commands.ts` (see that file's header and `commands.test.ts`).
 */
import { compareOrder } from "@nooklet/core";
import type { BlockId, EditableBlock, EditorTree, Row } from "./types.js";

function idTieBreak(a: BlockId, b: BlockId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortSiblings(byId: Map<BlockId, EditableBlock>, ids: BlockId[]): BlockId[] {
  return [...ids].sort((a, b) => {
    const oa = byId.get(a)?.order ?? "";
    const ob = byId.get(b)?.order ?? "";
    return compareOrder(oa, ob) || idTieBreak(a, b);
  });
}

/** Build an `EditorTree` from a flat (any-order) list of blocks. */
export function buildEditorTree(pageId: string, blocks: readonly EditableBlock[]): EditorTree {
  const byId = new Map<BlockId, EditableBlock>();
  const grouped = new Map<BlockId | null, BlockId[]>();
  for (const b of blocks) {
    byId.set(b.id, b);
    const bucket = grouped.get(b.parentId);
    if (bucket) bucket.push(b.id);
    else grouped.set(b.parentId, [b.id]);
  }
  const childrenOf = new Map<BlockId | null, BlockId[]>();
  for (const [parentId, ids] of grouped) childrenOf.set(parentId, sortSiblings(byId, ids));
  return { pageId, byId, childrenOf };
}

export function getBlock(tree: EditorTree, id: BlockId): EditableBlock {
  const b = tree.byId.get(id);
  if (!b) throw new Error(`editor tree: unknown block id ${id}`);
  return b;
}

export function childrenIds(tree: EditorTree, parentId: BlockId | null): BlockId[] {
  return tree.childrenOf.get(parentId) ?? [];
}

/** `id` and every descendant, pre-order (root first). Used to fully tombstone a subtree, since
 * `block.delete` (ADR 004/sql-schema.md) does not cascade — a deleted block's children would
 * otherwise become permanently unreachable orphans. */
export function subtreeIds(tree: EditorTree, id: BlockId): BlockId[] {
  const out: BlockId[] = [id];
  for (const c of childrenIds(tree, id)) out.push(...subtreeIds(tree, c));
  return out;
}

export interface FlattenOptions {
  /** Render only this block's subtree, root row included (zoom-into-block, research 04 §3.9). */
  rootBlockId?: BlockId;
  /** Walk into collapsed blocks too (their rows still say `collapsed`). Print only (B-221): a
   * collapsed block's children are not in the DOM, so a printed page silently lost them. Never
   * written back — collapse is synced state, and printing must not change it. */
  expandAll?: boolean;
}

/** The page's (or zoom root's) blocks in visible reading order: depth-first, skipping the
 * children of any collapsed block (the collapsed block itself still appears as a row). This is
 * what keyboard navigation (`block.focusPreviousLine`/`NextLine`, `mergeWithPrevious`,
 * `deleteForwardMerge`) and block-selection mode index into. */
export function flattenVisible(tree: EditorTree, opts: FlattenOptions = {}): Row[] {
  const rows: Row[] = [];
  const visit = (id: BlockId, depth: number): void => {
    const b = getBlock(tree, id);
    const kids = childrenIds(tree, id);
    rows.push({ id, depth, hasChildren: kids.length > 0, collapsed: b.collapsed });
    if (!b.collapsed || opts.expandAll) for (const c of kids) visit(c, depth + 1);
  };
  if (opts.rootBlockId !== undefined) {
    // Tolerate a zoom root that is not in the tree instead of throwing through `getBlock`. It is
    // absent on the very first render — the page resource has not resolved yet, so the tree is
    // empty — and throwing there took down the whole subtree, leaving a zoomed block permanently
    // blank behind a "Loading…" that never cleared. It is also absent, legitimately, when the
    // block has since been deleted.
    if (!tree.byId.has(opts.rootBlockId)) return rows;
    visit(opts.rootBlockId, 0);
  } else {
    for (const id of childrenIds(tree, null)) visit(id, 0);
  }
  return rows;
}

/** Order key of the sibling immediately after `id` under `parentId`, or `null` if `id` is last
 * (or not found). Shared by `commands.ts` (split/outdent/duplicate) and `paste.ts`. */
export function nextSiblingOrder(
  tree: EditorTree,
  parentId: BlockId | null,
  id: BlockId,
): string | null {
  const siblings = childrenIds(tree, parentId);
  const idx = siblings.indexOf(id);
  const next = siblings[idx + 1];
  return next ? getBlock(tree, next).order : null;
}

/** Order key of `parentId`'s last child, or `null` if it has none. */
export function lastChildOrder(tree: EditorTree, parentId: BlockId | null): string | null {
  const kids = childrenIds(tree, parentId);
  const last = kids[kids.length - 1];
  return last ? getBlock(tree, last).order : null;
}

/** Deep-clone an `EditorTree` so a batch command can chain several structural moves (each
 * computed the same way a single-block command would) without mutating the caller's snapshot or
 * touching the real store between steps. Only `parentId`/`order` ever change via
 * `applyPlaceInPlace`, so a shallow-per-block clone is enough. */
export function cloneTree(tree: EditorTree): EditorTree {
  return {
    pageId: tree.pageId,
    byId: new Map(tree.byId),
    childrenOf: new Map([...tree.childrenOf].map(([k, v]) => [k, [...v]])),
  };
}

/** Mutate a cloned working tree in place to reflect one `block.place`-shaped move: remove `id`
 * from its old parent's child list, update its `parentId`/`order`, and re-insert it into the new
 * parent's child list at the right sorted position. Used only by batch commands to keep their
 * working copy consistent between steps (`indentSelectedBlocks`/`outdentSelectedBlocks`) — never
 * called on a tree a caller still holds a reference to. */
export function applyPlaceInPlace(
  tree: EditorTree,
  id: BlockId,
  parentId: BlockId | null,
  order: string,
): void {
  const b = getBlock(tree, id);
  const oldSiblings = tree.childrenOf.get(b.parentId) ?? [];
  tree.childrenOf.set(
    b.parentId,
    oldSiblings.filter((x) => x !== id),
  );
  tree.byId.set(id, { ...b, parentId, order });
  const newSiblings = [...(tree.childrenOf.get(parentId) ?? []), id];
  tree.childrenOf.set(parentId, sortSiblings(tree.byId, newSiblings));
}
