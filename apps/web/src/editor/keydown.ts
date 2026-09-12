/**
 * The key -> command-id resolver: `docs/spec/commands-and-keymap.md` §C (R12/R13)'s dispatch
 * order and §E.1/E.2's `when` clauses, narrowed to the commands this package (the block tree and
 * its editing surface) owns — task/nav/palette/format/insert commands belong to other agents'
 * areas and are not resolved here (BUILD scope: "You do NOT build ... command palette, or slash
 * menu"). Pure and DOM-free by construction: it takes a normalized `KeyDescriptor` (already
 * platform-resolved: `mod` is Cmd on mac, Ctrl elsewhere) and a `DispatchCtx` snapshot, and
 * returns a command id or `null` — no `Surface`, no CodeMirror, no `EditorTree`. `surface.ts`/
 * `BlockTree.tsx` build the real `KeyDescriptor`/`DispatchCtx` from a live `KeyboardEvent` and
 * `Surface.geometry()`; `keydown.test.ts` exercises this file directly.
 */

export type CommandId =
  | "block.split"
  | "block.newline"
  | "block.indent"
  | "block.outdent"
  | "block.mergeWithPrevious"
  | "block.deleteForwardMerge"
  | "block.moveUp"
  | "block.moveDown"
  | "block.focusPreviousLine"
  | "block.focusNextLine"
  | "block.focusPreviousChar"
  | "block.focusNextChar"
  | "block.collapse"
  | "block.expand"
  | "block.zoomIn"
  | "block.zoomOut"
  | "block.selectBlock"
  | "block.copySelection"
  | "block.editSelected"
  | "block.clearSelection"
  | "block.extendSelectionUp"
  | "block.extendSelectionDown"
  | "block.selectAll"
  | "block.deleteSelected"
  | "block.indentSelected"
  | "block.outdentSelected"
  | "block.duplicate"
  | "block.copyRef"
  | "task.cycle"
  | "edit.undo"
  | "edit.redo";

export interface KeyDescriptor {
  /** `event.key` for a plain character/named key: `"Enter"`, `"Tab"`, `"ArrowUp"`, `"z"`, `"."`, … */
  key: string;
  /** Platform `Mod`: `metaKey` on mac, `ctrlKey` elsewhere — resolve this before calling in. */
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export interface DispatchCtx {
  editorFocused: boolean;
  blockSelected: boolean;
  hasSelection: boolean;
  selectionCount: number;
  atLineStart: boolean;
  atLineEnd: boolean;
  onFirstVisualLine: boolean;
  onLastVisualLine: boolean;
  hasChildren: boolean;
  isCollapsed: boolean;
  zoomed: boolean;
  /** R12 step 1/2: composing or an autocomplete/slash popup is open. This resolver still accepts
   * them (rather than assuming the caller filtered) so its "always returns false" behavior is
   * itself covered by a test, matching R12's literal order. */
  composing: boolean;
  popupOpen: boolean;
}

const POPUP_KEYS = new Set(["Escape", "Enter", "ArrowUp", "ArrowDown", "Tab"]);

/** R12/R13: resolve one keydown to a command id, or `null` to fall through to CM6/native default
 * behavior. Mirrors the spec's table row order exactly (first match wins); rows whose command
 * belongs to another agent's area (task/nav/format/insert/palette) are omitted — a key with no
 * row here simply falls through, same observable effect as `when` evaluating false. */
export function resolveCommand(kd: KeyDescriptor, ctx: DispatchCtx): CommandId | null {
  // R12 step 1: never touch the document mid-composition.
  if (ctx.composing) return null;
  // R12 step 2: let the autocomplete/slash popup's own keymap handle these.
  if (ctx.popupOpen && POPUP_KEYS.has(kd.key)) return null;

  const plain = !kd.mod && !kd.shift && !kd.alt;
  const shiftOnly = !kd.mod && kd.shift && !kd.alt;
  const modOnly = kd.mod && !kd.shift && !kd.alt;
  const modShift = kd.mod && kd.shift && !kd.alt;
  const altOnly = !kd.mod && !kd.shift && kd.alt;

  // edit.undo / edit.redo: `when: true` (always enabled, R51) — checked before the
  // editorFocused/blockSelected split since they apply in both modes (and neither).
  if (modOnly && kd.key.toLowerCase() === "z") return "edit.undo";
  if (modShift && kd.key.toLowerCase() === "z") return "edit.redo";

  if (ctx.editorFocused) {
    if (plain && kd.key === "Enter") return "block.split";
    if (shiftOnly && kd.key === "Enter") return "block.newline";
    if (modOnly && kd.key === "Enter") return "task.cycle";
    if (plain && kd.key === "Tab") return "block.indent";
    if (shiftOnly && kd.key === "Tab") return "block.outdent";
    if (plain && kd.key === "Backspace" && ctx.atLineStart && !ctx.hasSelection)
      return "block.mergeWithPrevious";
    if (plain && kd.key === "Delete" && ctx.atLineEnd && !ctx.hasSelection)
      return "block.deleteForwardMerge";
    if (altOnly && kd.key === "ArrowUp") return "block.moveUp";
    if (altOnly && kd.key === "ArrowDown") return "block.moveDown";
    if (plain && kd.key === "ArrowUp" && ctx.onFirstVisualLine) return "block.focusPreviousLine";
    if (plain && kd.key === "ArrowDown" && ctx.onLastVisualLine) return "block.focusNextLine";
    if (plain && kd.key === "ArrowLeft" && ctx.atLineStart) return "block.focusPreviousChar";
    if (plain && kd.key === "ArrowRight" && ctx.atLineEnd) return "block.focusNextChar";
    if (modOnly && kd.key === "ArrowUp" && ctx.hasChildren && !ctx.isCollapsed)
      return "block.collapse";
    if (modOnly && kd.key === "ArrowDown" && ctx.hasChildren && ctx.isCollapsed)
      return "block.expand";
    if (modOnly && kd.key === ".") return "block.zoomIn";
    if (modShift && kd.key === "." && ctx.zoomed) return "block.zoomOut";
    if (plain && kd.key === "Escape") return "block.selectBlock";
    if (shiftOnly && kd.key === "ArrowUp") return "block.extendSelectionUp";
    if (shiftOnly && kd.key === "ArrowDown") return "block.extendSelectionDown";
    if (modShift && kd.key.toLowerCase() === "d") return "block.duplicate";
    if (modShift && kd.key.toLowerCase() === "c") return "block.copyRef";
    return null;
  }

  if (ctx.blockSelected) {
    if (plain && kd.key === "Enter") return "block.editSelected";
    if (plain && kd.key === "Escape") return "block.clearSelection";
    if (modOnly && kd.key.toLowerCase() === "a") return "block.selectAll";
    if (plain && (kd.key === "Backspace" || kd.key === "Delete")) return "block.deleteSelected";
    if (plain && kd.key === "Tab") return "block.indentSelected";
    if (shiftOnly && kd.key === "Tab") return "block.outdentSelected";
    if (altOnly && kd.key === "ArrowUp") return "block.moveUp";
    if (altOnly && kd.key === "ArrowDown") return "block.moveDown";
    if (modOnly && kd.key === "ArrowUp" && ctx.hasChildren && !ctx.isCollapsed)
      return "block.collapse";
    if (modOnly && kd.key === "ArrowDown" && ctx.hasChildren && ctx.isCollapsed)
      return "block.expand";
    if (shiftOnly && kd.key === "ArrowUp") return "block.extendSelectionUp";
    if (shiftOnly && kd.key === "ArrowDown") return "block.extendSelectionDown";
    if (modOnly && kd.key === ".") return "block.zoomIn";
    if (modShift && kd.key === "." && ctx.zoomed) return "block.zoomOut";
    if (modShift && kd.key.toLowerCase() === "d") return "block.duplicate";
    if (modShift && kd.key.toLowerCase() === "c") return "block.copyRef";
    if (modOnly && kd.key === "Enter" && ctx.selectionCount === 1) return "task.cycle";
    return null;
  }

  return null;
}
