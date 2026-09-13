/**
 * `EditorHost.commitOps` on the tree's side: a batch of ops a COMMAND built — from data the editor
 * does not hold, like `/template`'s copy of a subtree on another page — turned into exactly what
 * `BlockTree`'s `runStructural` commits for a split or a paste. Committing through the tree is what
 * puts the batch in the undo history; before this `/template` wrote through `applyOps` directly and
 * Cmd/Ctrl+Z could not take a template back (B-108).
 *
 * Pure, so the refusals below are unit-tested without a DOM.
 */
import { makeOp, type Op } from "@nooklet/core";
import type { OpBatch } from "../commands/hosts/editor-host.js";
import type { Clock, EditorTree, FocusChange } from "./types.js";

/** The op kinds `invert.ts` can undo. Anything else would throw inside `history.record`, AFTER the
 * optimistic tree already showed the batch and BEFORE `applyOps` wrote it — a screen that
 * disagrees with the database. Such a batch is refused instead, and the caller applies it. */
const UNDOABLE = new Set([
  "block.create",
  "block.delete",
  "block.text",
  "block.place",
  "block.prop",
]);

/**
 * The ops to commit and where the caret goes, or `null` when this tree must not take the batch:
 * the anchor is not one of its blocks (the person moved to another page while the command was
 * reading the database), a create or move targets another page (the optimistic tree would show a
 * block that is not on this page), or an op is not undoable.
 *
 * The ops are RE-MINTED with the tree's clock. `runStructural` flushes the pending keystrokes
 * first, and a flushed `block.text` is stamped at flush time — after the command minted its ops.
 * Kept as minted, the batch's own `block.text` for the same block (the template's first line
 * written into the bullet) would lose last-writer-wins to the older buffer. Ids, contents and
 * places are unchanged; only `id`/`hlc` are fresh — the same thing `history.ts` does on every undo.
 */
export function prepareExternalBatch(
  batch: OpBatch,
  tree: EditorTree,
  clock: Clock,
): { ops: Op[]; focus?: FocusChange } | null {
  if (batch.ops.length === 0 || !tree.byId.has(batch.anchorId)) return null;
  for (const op of batch.ops) {
    const p = op.payload;
    if (!UNDOABLE.has(p.kind)) return null;
    if ((p.kind === "block.create" || p.kind === "block.place") && p.place.pageId !== tree.pageId)
      return null;
  }
  const ops = batch.ops.map((o) => makeOp(clock.next(), clock.device, o.entity, o.payload));
  if (!batch.focus) return { ops };
  const { blockId, caret } = batch.focus;
  return {
    ops,
    focus: { id: blockId, caret: caret === "end" ? { at: "end" } : { offset: caret } },
  };
}
