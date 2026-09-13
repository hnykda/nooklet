/**
 * Where the editor goes after an undo or redo step has been applied to the tree. Pure, so
 * `BlockTree` only acts on the answer.
 *
 * A step records the caret from before and after it (`history.ts`'s `Tx.before`/`after`), or
 * `null` when it had none to record: a collapse, a marker cycled from the keyboard, Collapse all, a
 * batch a command committed with nothing edited. Two rules used to be one, "null means detach":
 *
 * - A recorded caret is followed only into a block that has a row. The block may have left the
 *   page, or sit under a collapsed parent or outside the zoom root; attaching to it put the editor
 *   into a row nothing renders, so the keyboard went nowhere (B-194).
 * - No caret to follow (or none that can be followed) leaves the editor where it is, as long as its
 *   own row is still on screen. Detaching instead ended editing on every undo of a collapse, so the
 *   redo that followed had no keyboard target (B-162). Only when the undo took the edited row
 *   away — the block it created is gone, or it is folded under a parent again — does editing end.
 */
import type { BlockId, FocusChange } from "./types.js";

export type AfterStep =
  /** Put the caret here (attach, or move the caret within the block already being edited). */
  | { kind: "caret"; focus: FocusChange }
  /** Leave the editor, or the absence of one, as it is. */
  | { kind: "keep" }
  /** The edited row is gone: end editing. */
  | { kind: "detach" };

export function focusAfterStep(
  recorded: FocusChange | null,
  editingId: BlockId | null,
  hasRow: (id: BlockId) => boolean,
): AfterStep {
  if (recorded && hasRow(recorded.id)) return { kind: "caret", focus: recorded };
  if (editingId === null || hasRow(editingId)) return { kind: "keep" };
  return { kind: "detach" };
}
