/**
 * The pure "given tree + cursor + key, produce ops" seam (task brief: "structure the editor so
 * that function is testable WITHOUT a real DOM — this is the highest-value testing decision you
 * will make"). Every structural rule of `docs/spec/commands-and-keymap.md` §E.1 (R16-R32) that
 * mutates the block tree is implemented here as a small pure function: `(EditorTree, ...) ->
 * { ops: Op[]; focus?: FocusChange }`. None of these touch Solid, CodeMirror, or the DOM; they are
 * exercised directly in `commands.test.ts` with hand-built trees and a fake `Clock`.
 *
 * Two categories of key are deliberately NOT here:
 *  - Plain typing, Shift+Enter, and formatting toggles are ordinary CodeMirror text mutations
 *    inside the currently-mounted block; they become `block.text` ops only when the text-edit
 *    coalescer flushes (`history.ts`), not per keystroke and not through this file.
 *  - Pure caret movement that crosses a block boundary without changing the tree
 *    (`block.focusPreviousLine/NextLine/Char`, R23/R24) returns only a `FocusChange`, no ops —
 *    included here anyway because it still needs the same tree/row bookkeeping.
 *
 * Op-building convention: every op is stamped via `Clock` (`types.ts`), which the caller injects
 * (`editor/clock.ts` in production, a deterministic fake counter in tests) — this file never calls
 * `Date.now()`/`crypto` for anything that ends up in an op's hlc, keeping every function a pure
 * mapping from (tree, args, clock-sequence) to ops.
 */
import {
  type BlockPlace,
  formatDoneIso,
  makeOp,
  newId,
  type Op,
  type OpPayload,
  orderBetween,
  ordersBetween,
} from "@nooklet/core";
import {
  applyPlaceInPlace,
  childrenIds,
  cloneTree,
  getBlock,
  lastChildOrder,
  nextSiblingOrder,
} from "./tree.js";
import type { BlockId, CaretSpec, Clock, EditableBlock, EditorTree, FocusChange } from "./types.js";

function op(clock: Clock, entity: BlockId, payload: OpPayload): Op {
  return makeOp(clock.next(), clock.device, entity, payload);
}

function place(pageId: string, parentId: BlockId | null, order: string): BlockPlace {
  return { pageId, parentId, order };
}

export interface OpsResult {
  ops: Op[];
}
export interface OpsFocusResult extends OpsResult {
  focus: FocusChange;
}

// -------------------------------------------------------------------------------------------
// R16 — split
// -------------------------------------------------------------------------------------------

/** `block.split`: split `content` at `head`. Per R16, the new block is the block's first child
 * (before any existing children) when the block is expanded and has children; otherwise it is the
 * block's next sibling. Degenerates correctly to "insert an empty sibling after and focus it"
 * when `head` is 0 and the block was already empty (`before = after = ''`). */
export function splitBlock(
  tree: EditorTree,
  id: BlockId,
  head: number,
  clock: Clock,
  now: number = Date.now(),
): OpsFocusResult {
  const b = getBlock(tree, id);
  const before = b.content.slice(0, head);
  const after = b.content.slice(head);
  const newBlockId = newId(now);
  const kids = childrenIds(tree, id);
  const asFirstChild = kids.length > 0 && !b.collapsed;

  const newPlace = asFirstChild
    ? place(tree.pageId, id, orderBetween(null, getBlock(tree, kids[0] as BlockId).order))
    : place(tree.pageId, b.parentId, orderBetween(b.order, nextSiblingOrder(tree, b.parentId, id)));

  const ops: Op[] = [];
  if (before !== b.content) ops.push(op(clock, id, { kind: "block.text", content: before }));
  ops.push(
    op(clock, newBlockId, {
      kind: "block.create",
      place: newPlace,
      content: after,
      createdAt: now,
    }),
  );
  return { ops, focus: { id: newBlockId, caret: { at: "start" } } };
}

// -------------------------------------------------------------------------------------------
// R18 — indent
// -------------------------------------------------------------------------------------------

/** `block.indent` (Tab): no-op if `id` has no previous sibling (R18). */
export function indentBlock(tree: EditorTree, id: BlockId, clock: Clock): OpsResult | null {
  const b = getBlock(tree, id);
  const siblings = childrenIds(tree, b.parentId);
  const idx = siblings.indexOf(id);
  if (idx <= 0) return null;
  const newParentId = siblings[idx - 1] as BlockId;
  const order = orderBetween(lastChildOrder(tree, newParentId), null);
  return {
    ops: [op(clock, id, { kind: "block.place", place: place(tree.pageId, newParentId, order) })],
  };
}

// -------------------------------------------------------------------------------------------
// R19 — logical outdent
// -------------------------------------------------------------------------------------------

export interface OutdentOptions {
  /** No-op when `id` is the current zoom root (R19.1's "or the zoom root"); the tree itself has
   * no notion of a zoom root, so the caller supplies it. */
  zoomRootId?: BlockId | null;
  /** R31: when outdenting a *contiguous* multi-selection, a non-selected trailing sibling must
   * attach to the LAST block of the selected run, not the first — e.g. selecting siblings B and
   * C (in that order) and outdenting both must not split D (the sibling right after C) onto B
   * just because D is technically "younger than B" too. So the "younger siblings" taken by this
   * call are only the run of siblings *immediately* following `id` that are NOT in this set;
   * hitting another selected sibling stops the run (it will collect its own younger-siblings on
   * its own turn instead). */
  excludeFromYounger?: ReadonlySet<BlockId>;
  /** Batch-only: shared, mutated across calls that share the same original parent `P`, so a
   * second block outdented from the same `P` in one batch lands right after the first one's NEW
   * position (not wedged back between `P` and it) while still respecting the original upper
   * bound (whatever genuinely followed `P` before the batch started). Keyed by `P`'s id. */
  insertionCursor?: Map<BlockId, { lower: string | null; upper: string | null }>;
}

/** `block.outdent` (Shift+Tab), R19's "logical outdenting": `B`'s later siblings under its old
 * parent `P` are re-parented under `B` (appended after `B`'s own children) so they never end up
 * out of reading order relative to the block that outdented past them. No-op at the page/zoom
 * root (R19.1). */
export function outdentBlock(
  tree: EditorTree,
  id: BlockId,
  clock: Clock,
  opts: OutdentOptions = {},
): OpsResult | null {
  const b = getBlock(tree, id);
  if (b.parentId === null) return null;
  if (opts.zoomRootId !== undefined && opts.zoomRootId === id) return null;

  const parentId = b.parentId;
  const P = getBlock(tree, parentId);
  const G = P.parentId;

  // R19 step 3: snapshot B's later siblings under P *before* anything moves.
  const siblingsUnderP = childrenIds(tree, parentId);
  const idxInP = siblingsUnderP.indexOf(id);
  const youngerAll = siblingsUnderP.slice(idxInP + 1);
  let younger: BlockId[];
  if (opts.excludeFromYounger) {
    // Take the run of immediately-following, non-selected siblings; stop at the next selected
    // one (it will claim the remainder as ITS younger-siblings step, see `OutdentOptions` doc).
    younger = [];
    for (const y of youngerAll) {
      if (opts.excludeFromYounger.has(y)) break;
      younger.push(y);
    }
  } else {
    younger = youngerAll;
  }

  const cursor = opts.insertionCursor;
  const cached = cursor?.get(parentId);
  const lowerBound = cached ? cached.lower : P.order;
  const upperBound = cached ? cached.upper : nextSiblingOrder(tree, G, parentId);
  const newOrderForB = orderBetween(lowerBound, upperBound);
  cursor?.set(parentId, { lower: newOrderForB, upper: upperBound });

  const ops: Op[] = [
    op(clock, id, { kind: "block.place", place: place(tree.pageId, G, newOrderForB) }),
  ];

  let lastOrder = lastChildOrder(tree, id);
  for (const yId of younger) {
    const newOrder = orderBetween(lastOrder, null);
    ops.push(op(clock, yId, { kind: "block.place", place: place(tree.pageId, id, newOrder) }));
    lastOrder = newOrder;
  }
  return { ops };
}

// -------------------------------------------------------------------------------------------
// R20 / R21 — merge with previous / delete-forward merge
// -------------------------------------------------------------------------------------------

function reparentChildrenAsTrailing(
  tree: EditorTree,
  clock: Clock,
  childIds: readonly BlockId[],
  newParentId: BlockId,
  ops: Op[],
): void {
  let lastOrder = lastChildOrder(tree, newParentId);
  for (const cId of childIds) {
    const newOrder = orderBetween(lastOrder, null);
    ops.push(
      op(clock, cId, { kind: "block.place", place: place(tree.pageId, newParentId, newOrder) }),
    );
    lastOrder = newOrder;
  }
}

/** `block.mergeWithPrevious` (Backspace at offset 0, R20). `visibleRows` is the flattened,
 * collapse-and-zoom-aware reading order (`tree.ts#flattenVisible`) — "previous" here is the
 * previous *visible* row, which may be the parent or a deep descendant of the previous sibling,
 * not necessarily a tree-sibling. Returns `null` for every no-op case R20 defines (no previous
 * row; empty block with children). */
export function mergeWithPrevious(
  tree: EditorTree,
  visibleRows: readonly BlockId[],
  id: BlockId,
  clock: Clock,
  now: number = Date.now(),
): OpsFocusResult | null {
  const idx = visibleRows.indexOf(id);
  if (idx <= 0) return null;
  const prevId = visibleRows[idx - 1] as BlockId;
  const b = getBlock(tree, id);
  const prev = getBlock(tree, prevId);
  const kids = childrenIds(tree, id);

  if (b.content === "" && kids.length === 0) {
    return {
      ops: [op(clock, id, { kind: "block.delete", deletedAt: now })],
      focus: { id: prevId, caret: { at: "end" } },
    };
  }
  if (b.content === "" && kids.length > 0) return null;

  const joinOffset = prev.content.length;
  const ops: Op[] = [op(clock, prevId, { kind: "block.text", content: prev.content + b.content })];
  reparentChildrenAsTrailing(tree, clock, kids, prevId, ops);
  ops.push(op(clock, id, { kind: "block.delete", deletedAt: now }));
  return { ops, focus: { id: prevId, caret: { offset: joinOffset } } };
}

/** `block.deleteForwardMerge` (Delete at end, R21): the mirror of `mergeWithPrevious`, folding the
 * *next* visible block into this one. No focus change (the merge happens forward). */
export function deleteForwardMerge(
  tree: EditorTree,
  visibleRows: readonly BlockId[],
  id: BlockId,
  clock: Clock,
  now: number = Date.now(),
): OpsResult | null {
  const idx = visibleRows.indexOf(id);
  if (idx === -1 || idx === visibleRows.length - 1) return null;
  const nextId = visibleRows[idx + 1] as BlockId;
  const b = getBlock(tree, id);
  const next = getBlock(tree, nextId);
  const nextKids = childrenIds(tree, nextId);

  const ops: Op[] = [op(clock, id, { kind: "block.text", content: b.content + next.content })];
  reparentChildrenAsTrailing(tree, clock, nextKids, id, ops);
  ops.push(op(clock, nextId, { kind: "block.delete", deletedAt: now }));
  return { ops };
}

// -------------------------------------------------------------------------------------------
// R22 — move up/down among siblings
// -------------------------------------------------------------------------------------------

/** `block.moveUp`/`block.moveDown`: reorder only, swapping with the previous/next sibling under
 * the same parent. No-op at the first/last sibling position. */
export function moveBlock(
  tree: EditorTree,
  id: BlockId,
  direction: "up" | "down",
  clock: Clock,
): OpsResult | null {
  const b = getBlock(tree, id);
  const siblings = childrenIds(tree, b.parentId);
  const idx = siblings.indexOf(id);

  if (direction === "up") {
    if (idx <= 0) return null;
    const prevId = siblings[idx - 1] as BlockId;
    const prev = getBlock(tree, prevId);
    const before = siblings[idx - 2];
    const newOrder = orderBetween(before ? getBlock(tree, before).order : null, prev.order);
    return {
      ops: [
        op(clock, id, { kind: "block.place", place: place(tree.pageId, b.parentId, newOrder) }),
      ],
    };
  }
  if (idx === -1 || idx >= siblings.length - 1) return null;
  const nextId = siblings[idx + 1] as BlockId;
  const next = getBlock(tree, nextId);
  const after = siblings[idx + 2];
  const newOrder = orderBetween(next.order, after ? getBlock(tree, after).order : null);
  return {
    ops: [op(clock, id, { kind: "block.place", place: place(tree.pageId, b.parentId, newOrder) })],
  };
}

// -------------------------------------------------------------------------------------------
// R25 — collapse / expand
// -------------------------------------------------------------------------------------------

export function setCollapsed(id: BlockId, collapsed: boolean, clock: Clock): Op {
  return op(clock, id, {
    kind: "block.prop",
    key: "collapsed",
    value: collapsed ? "true" : "false",
  });
}

// -------------------------------------------------------------------------------------------
// R32 — duplicate
// -------------------------------------------------------------------------------------------

/** `block.duplicate`: a deep copy of `id`'s subtree as its own next sibling, with fresh ids for
 * every copied block (never reusing an id, R32) and every task/schedule field copied verbatim
 * (duplication does not clear task state). Focus moves to the copy's top block at the original
 * caret offset. */
export function duplicateBlock(
  tree: EditorTree,
  id: BlockId,
  clock: Clock,
  now: number = Date.now(),
): OpsFocusResult {
  const root = getBlock(tree, id);
  const rootOrder = orderBetween(root.order, nextSiblingOrder(tree, root.parentId, id));
  const ops: Op[] = [];
  let newRootId = "";

  const walk = (srcId: BlockId, newParentId: BlockId | null, order: string): void => {
    const src = getBlock(tree, srcId);
    const nid = newId(now);
    if (srcId === id) newRootId = nid;
    ops.push(
      op(clock, nid, {
        kind: "block.create",
        place: place(tree.pageId, newParentId, order),
        content: src.content,
        marker: src.marker,
        priority: src.priority,
        collapsed: src.collapsed,
        createdAt: now,
      }),
    );
    if (src.scheduled)
      ops.push(op(clock, nid, { kind: "block.prop", key: "scheduled", value: src.scheduled }));
    if (src.deadline)
      ops.push(op(clock, nid, { kind: "block.prop", key: "deadline", value: src.deadline }));
    if (src.repeat)
      ops.push(op(clock, nid, { kind: "block.prop", key: "repeat", value: src.repeat }));
    if (src.doneAt !== null) {
      ops.push(
        op(clock, nid, { kind: "block.prop", key: "done", value: formatDoneIso(src.doneAt) }),
      );
    }
    const kids = childrenIds(tree, srcId);
    const orders = ordersBetween(null, null, kids.length);
    kids.forEach((k, i) => {
      walk(k, nid, orders[i] as string);
    });
  };
  walk(id, root.parentId, rootOrder);

  return { ops, focus: { id: newRootId, caret: { offset: root.content.length } } };
}

/** `block.copyRef`: the literal `((<id>))` text (R32). Not an op — a clipboard string. */
export function blockRefText(id: BlockId): string {
  return `((${id}))`;
}

// -------------------------------------------------------------------------------------------
// R31 — multi-block selection commands
// -------------------------------------------------------------------------------------------

/** `block.deleteSelected`: every selected block and its whole subtree, tombstoned. Deletion does
 * not cascade at the storage layer (`sql-schema.md`), so every descendant needs its own
 * `block.delete` — the union avoids double-deleting a block whose ancestor is also selected. */
export function deleteSelectedBlocks(
  tree: EditorTree,
  ids: readonly BlockId[],
  clock: Clock,
  now: number = Date.now(),
): OpsResult {
  const seen = new Set<BlockId>();
  const ops: Op[] = [];
  const visit = (id: BlockId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ops.push(op(clock, id, { kind: "block.delete", deletedAt: now }));
    for (const c of childrenIds(tree, id)) visit(c);
  };
  for (const id of ids) visit(id);
  return { ops };
}

/** `block.indentSelected`: R18 applied to each selected block, top-to-bottom, against a working
 * tree that reflects every earlier step in the same batch — so a contiguous multi-selection
 * indents flat under the original previous sibling (each already-moved block becomes the next
 * one's new previous-sibling target), matching ordinary outliner multi-indent behavior. */
export function indentSelectedBlocks(
  tree: EditorTree,
  ids: readonly BlockId[],
  clock: Clock,
): OpsResult {
  const work = cloneTree(tree);
  const ops: Op[] = [];
  for (const id of ids) {
    const r = indentBlock(work, id, clock);
    if (!r) continue;
    ops.push(...r.ops);
    for (const o of r.ops)
      if (o.payload.kind === "block.place") {
        applyPlaceInPlace(work, o.entity, o.payload.place.parentId, o.payload.place.order);
      }
  }
  return { ops };
}

/** `block.outdentSelected`: R19 applied to each selected block, top-to-bottom, with R31's explicit
 * refinement — a selected block is never re-parented as another selected block's "younger
 * sibling" (it is moved by its own row of the batch instead), and each step's own younger-sibling
 * snapshot is taken from the tree as it stands *before that block's own move* (not the pristine
 * pre-batch tree), so several outdents from the same parent chain correctly instead of colliding. */
export function outdentSelectedBlocks(
  tree: EditorTree,
  ids: readonly BlockId[],
  clock: Clock,
): OpsResult {
  const selected = new Set(ids);
  const work = cloneTree(tree);
  const insertionCursor = new Map<BlockId, { lower: string | null; upper: string | null }>();
  const ops: Op[] = [];
  for (const id of ids) {
    const r = outdentBlock(work, id, clock, { excludeFromYounger: selected, insertionCursor });
    if (!r) continue;
    ops.push(...r.ops);
    for (const o of r.ops)
      if (o.payload.kind === "block.place") {
        applyPlaceInPlace(work, o.entity, o.payload.place.parentId, o.payload.place.order);
      }
  }
  return { ops };
}

export type { CaretSpec, EditableBlock, EditorTree, FocusChange };
