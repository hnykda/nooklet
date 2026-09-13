/**
 * The keys a focused text field keeps for itself, out of the global command dispatch (B-347).
 *
 * `CommandLayer`'s dispatcher listens on `document` in the capture phase, so it sees every keydown
 * before the element that has focus. For the block editor that is the design (the editor's keys
 * are commands). For any OTHER text field — the command palette's input, a page title, search, a
 * property value — it meant that a key the field needed ran a block command instead, whenever the
 * context allowed it: with blocks selected, Backspace or Delete typed into the palette deleted the
 * selected blocks (on the server too) and never reached the input; Cmd/Ctrl+A selected every block
 * instead of the query's text. The context cannot simply say "no selection" while such a field has
 * focus, because the palette evaluates its rows' `when` clauses against that very selection.
 *
 * So the dispatcher is skipped for a text-editing key whose target is a text field other than the
 * block editor. Every other key still dispatches from a text field — Escape, Enter, Tab and the
 * global Cmd/Ctrl shortcuts (palette, journal, search, settings).
 */
import type { KeyboardEventLike } from "../commands/keymap/notation.js";

/** Keys that edit or move inside a text field, with any modifier: Shift extends the text
 * selection, Alt and Cmd/Ctrl move or delete by word or line. */
const EDITING_KEYS: ReadonlySet<string> = new Set([
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Cmd/Ctrl + these: select all, the clipboard, and the field's own undo/redo. */
const MOD_LETTERS: ReadonlySet<string> = new Set(["a", "c", "x", "v", "z"]);

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "search",
  "url",
  "email",
  "tel",
  "password",
  "number",
]);

/** Whether a text field has a use for this key. Pure, for tests. */
export function isTextEditingKey(e: KeyboardEventLike, mac: boolean): boolean {
  if (EDITING_KEYS.has(e.key)) {
    // Alt+Left/Right is Back/Forward outside macOS (`nav.back`/`nav.forward`), not a text motion.
    return mac || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight");
  }
  const mod = mac ? e.metaKey : e.ctrlKey;
  return mod && !e.altKey && MOD_LETTERS.has(e.key.toLowerCase());
}

/** A focused text-entry element that is not the block editor's CodeMirror surface. */
export function isOtherTextField(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  // The block editor's keys ARE commands (`../editor/keydown.ts`, R12-R13).
  if (target.closest(".cm-editor")) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  return target.isContentEditable === true;
}

/** `true`: leave this keydown to the focused field; the command dispatcher must not see it. */
export function textFieldOwnsKey(
  e: KeyboardEventLike & { target: EventTarget | null },
  mac: boolean,
): boolean {
  return isTextEditingKey(e, mac) && isOtherTextField(e.target);
}
