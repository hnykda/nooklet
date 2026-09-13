/**
 * Computes the inverse of one or more ops, given the `EditorTree` snapshot from *before* the
 * transaction they belong to was applied. This is the building block `history.ts`'s undo/redo
 * stack is made of (ADR 006: "a document-level history of inverse ops").
 *
 * Returns `OpRecipe`s (`{entity, payload}`, no `id`/`hlc`) rather than full `Op`s: every op in
 * this system is uniquely keyed by its `hlc` and `applyOps` treats a repeat of the same id as a
 * no-op (`sync/apply-ops.ts`'s idempotence rule) — so a *second* undo, or any redo, must mint a
 * **fresh** hlc carrying the same payload, never replay the original `Op` object. `history.ts`
 * wraps a recipe with a live `Clock` at the moment it is actually applied (undo, or redo, however
 * many times), which is also why this file takes no `Clock` itself.
 *
 * Every op kind this editor ever emits (`commands.ts`, `task.ts`, `paste.ts`) inverts cleanly:
 *  - `block.create` <-> `block.delete` (a create's inverse tombstones it; a delete's inverse
 *    revives it by writing `deletedAt: null` with a fresh, later HLC — `block.delete`'s `deletedAt`
 *    field is nullable specifically so "undelete" is representable as an ordinary op, ADR 004).
 *  - `block.text`/`block.place`/`block.prop` invert to the same op kind with the old value read
 *    back out of `treeBefore` (each is a last-writer-wins field, so "set it back to what it was"
 *    is always a valid, order-independent op).
 */
import { formatDoneIso, type OpPayload } from "@nooklet/core";
import type { EditableBlock, EditorTree } from "./types.js";

export interface OpRecipe {
  entity: string;
  payload: OpPayload;
}

/** The `block.prop` value `key` held on `block` (used as the inverse's `value`). Every reserved
 * key this editor writes (`collapsed`/`marker`/`priority`/`scheduled`/`deadline`/`repeat`/`done`)
 * has a dedicated `EditableBlock` field; every other key is a generic property, read from
 * `block.properties` (B-101: property lines typed into the buffer are `block.prop` ops, and
 * inverting them to `null` made undo delete a property it should have restored). */
function propValueBefore(block: EditableBlock | undefined, key: string): string | null {
  if (!block) return null;
  switch (key) {
    case "collapsed":
      return block.collapsed ? "true" : "false";
    case "marker":
      return block.marker;
    case "priority":
      return block.priority;
    case "scheduled":
      return block.scheduled;
    case "deadline":
      return block.deadline;
    case "repeat":
      return block.repeat;
    case "done":
      return block.doneAt !== null ? formatDoneIso(block.doneAt) : null;
    default:
      return block.properties[key] ?? null;
  }
}

/** Inverse recipe for one op. `treeBefore` must be the snapshot from before the *whole*
 * transaction this op is part of, not just before this one op — see `history.ts`. */
export function invertOp(
  entity: string,
  payload: OpPayload,
  treeBefore: EditorTree,
  deletedAt: number,
): OpRecipe {
  switch (payload.kind) {
    case "block.create":
      return { entity, payload: { kind: "block.delete", deletedAt } };
    case "block.delete":
      return { entity, payload: { kind: "block.delete", deletedAt: null } };
    case "block.text":
      return {
        entity,
        payload: { kind: "block.text", content: treeBefore.byId.get(entity)?.content ?? "" },
      };
    case "block.place": {
      const before = treeBefore.byId.get(entity);
      return {
        entity,
        payload: {
          kind: "block.place",
          place: {
            pageId: treeBefore.pageId,
            parentId: before?.parentId ?? null,
            order: before?.order ?? payload.place.order,
          },
        },
      };
    }
    case "block.prop":
      return {
        entity,
        payload: {
          kind: "block.prop",
          key: payload.key,
          value: propValueBefore(treeBefore.byId.get(entity), payload.key),
        },
      };
    default:
      // page.* ops never originate from this editor's own commands.
      throw new Error(`invertOp: unsupported op kind for editor undo: ${payload.kind}`);
  }
}

/**
 * The form a transaction's forward op takes when it is applied AGAIN, by redo.
 *
 * Redo only ever runs on a transaction whose inverse has just been applied, so a `block.create` in
 * it names a block that already exists: the tombstone its undo left. Re-sending the create is
 * wrong. `applyOps` inserts with `INSERT OR IGNORE`, so on the server (and in the local replica)
 * it is a no-op and the block stays deleted, while `optimistic.ts` re-adds it on screen. The
 * block reappeared, the server kept it deleted, and a reload lost it (B-240). Reviving the
 * tombstone is the op that actually undoes the undo, the same undelete `invertOp` emits for a
 * deleted block. Its fields need no rewriting: every later transaction that changed them has been
 * undone first, so the tombstone already holds what the create wrote.
 */
export function redoRecipe(recipe: OpRecipe): OpRecipe {
  if (recipe.payload.kind === "block.create") {
    return { entity: recipe.entity, payload: { kind: "block.delete", deletedAt: null } };
  }
  return recipe;
}

/** Inverse of a whole transaction: each op inverted, in reverse order (so undoing a batch — e.g.
 * outdent's "move B, then reparent its younger siblings" — unwinds last-effect-first). */
export function invertOps(
  ops: ReadonlyArray<{ entity: string; payload: OpPayload }>,
  treeBefore: EditorTree,
  deletedAt: number,
): OpRecipe[] {
  return [...ops].reverse().map((o) => invertOp(o.entity, o.payload, treeBefore, deletedAt));
}
