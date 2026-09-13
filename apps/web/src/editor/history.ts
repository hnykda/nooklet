/**
 * Document-level undo/redo (ADR 006 / research/04-editor.md §7's "plain command pattern" branch —
 * this codebase's sync layer is per-field LWW ops, not a CRDT, so there is no `Y.UndoManager`/Loro
 * `UndoManager` to bind to; this is the from-scratch equivalent, sized for that). One stack for
 * the whole page, not per-block and not CodeMirror's own `history()` extension (never installed,
 * per ADR 006), so undo/redo cross block boundaries: `edit.undo` after an indent-then-type
 * sequence undoes the typing, then the indent, in that order, restoring the caret each time.
 *
 * Every transaction is stored as `OpRecipe`s (`{entity, payload}`), not full `Op`s: `applyOps`
 * treats a repeated `id`/`hlc` as a no-op (idempotence, `sync/apply-ops.ts`), so replaying the
 * exact same `Op` object a second time — which undo/redo/undo/redo... would do if this stored
 * finished `Op`s — would silently do nothing the second time onward. `undo()`/`redo()` therefore
 * take a `Clock` and mint a **fresh** `Op` per recipe every time they are called.
 *
 * Coalescing: consecutive **text** transactions on the **same block** within `coalesceMs` (500,
 * ADR 006) of each other merge into a single undo step — keeping the *first* one's `inverse`
 * (so undo restores the text to how it was before the whole burst of typing) but the *latest*
 * one's forward recipe/`after` caret (so redo reproduces the burst's final state, not an
 * intermediate one). Structural transactions (`kind: "structure"`) never coalesce with anything,
 * matching "500 ms coalescing of **text edits**" — not moves/splits/etc.
 *
 * This file only manages the stack; it never calls `applyOps` itself — `BlockTree.tsx` applies
 * `undo()`/`redo()`'s returned ops through the real data seam, exactly like any other edit, so
 * undo/redo round-trip through the op log like everything else (ADR 006).
 */
import { makeOp, type Op } from "@nooklet/core";
import { invertOps, type OpRecipe, redoRecipe } from "./invert.js";
import type { BlockId, Clock, EditorTree, FocusChange } from "./types.js";

export interface Tx {
  forward: OpRecipe[];
  inverse: OpRecipe[];
  before: FocusChange | null;
  after: FocusChange | null;
  kind: "text" | "structure";
  /** Coalescing key for `kind: "text"` transactions; ignored for `"structure"`. */
  blockId: BlockId | null;
  /** `Date.now()` at push time — compared against the coalescing window. */
  at: number;
}

export interface UndoRedoResult {
  ops: Op[];
  focus: FocusChange | null;
}

function mint(recipes: OpRecipe[], clock: Clock): Op[] {
  return recipes.map((r) => makeOp(clock.next(), clock.device, r.entity, r.payload));
}

export class EditHistory {
  private undoStack: Tx[] = [];
  private redoStack: Tx[] = [];
  private captureUntil = 0;

  constructor(private readonly coalesceMs = 500) {}

  /** Build and push a transaction for `ops` (already applied by the caller), computing its
   * inverse from `treeBefore` — the snapshot from immediately before `ops` was applied. */
  record(
    ops: readonly Op[],
    treeBefore: EditorTree,
    kind: Tx["kind"],
    before: FocusChange | null,
    after: FocusChange | null,
    blockId: BlockId | null = null,
    now: number = Date.now(),
  ): void {
    const forward = ops.map((o) => ({ entity: o.entity, payload: o.payload }));
    const inverse = invertOps(forward, treeBefore, now);
    this.push({ forward, inverse, before, after, kind, blockId, at: now });
  }

  push(tx: Tx): void {
    const last = this.undoStack[this.undoStack.length - 1];
    const canMerge =
      last !== undefined &&
      last.kind === "text" &&
      tx.kind === "text" &&
      last.blockId === tx.blockId &&
      tx.at < this.captureUntil;
    if (canMerge && last) {
      last.forward = tx.forward;
      last.after = tx.after;
    } else {
      this.undoStack.push(tx);
    }
    this.captureUntil = tx.at + this.coalesceMs;
    this.redoStack = [];
  }

  /** Call before any structural command runs and whenever the editing focus leaves a block, so an
   * unrelated later edit never coalesces into an older, different one just by landing inside the
   * debounce window (ADR 006 / research 04 §7's `stopCapturing`). */
  stopCapturing(): void {
    this.captureUntil = 0;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(clock: Clock): UndoRedoResult | null {
    const tx = this.undoStack.pop();
    if (!tx) return null;
    this.redoStack.push(tx);
    this.captureUntil = 0;
    return { ops: mint(tx.inverse, clock), focus: tx.before };
  }

  redo(clock: Clock): UndoRedoResult | null {
    const tx = this.redoStack.pop();
    if (!tx) return null;
    this.undoStack.push(tx);
    this.captureUntil = 0;
    // Not `tx.forward` verbatim: a create in it would be a no-op against its own tombstone.
    return { ops: mint(tx.forward.map(redoRecipe), clock), focus: tx.after };
  }

  /** Test/debug helper: current stack depths. */
  depths(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}
