/**
 * R45-R47: pure text-transformation logic for the `Formatting` category, independent of
 * `EditorHost` so it's exhaustively unit-testable. `registrations/format.ts` wires these to the
 * actual read (`getSelection`) / write (`replaceRange`) seam.
 */
import type { ReplaceRangeSpec } from "../hosts/editor-host.js";

/**
 * R45: toggle a marker pair around the selection, or around an empty spot at a collapsed caret.
 * "Toggle" means: if the selection (or the text immediately surrounding a collapsed caret) is
 * already wrapped in this exact marker pair, the markers are removed instead of doubled.
 */
export function toggleWrap(
  content: string,
  start: number,
  end: number,
  open: string,
  close: string = open,
): ReplaceRangeSpec {
  const beforeIsOpen = content.slice(Math.max(0, start - open.length), start) === open;
  const afterIsClose = content.slice(end, end + close.length) === close;

  if (start !== end) {
    const inner = content.slice(start, end);
    if (beforeIsOpen && afterIsClose) {
      // Unwrap: remove the markers, keep the inner text selected.
      return {
        from: start - open.length,
        to: end + close.length,
        text: inner,
        caretOffset: { anchor: 0, head: inner.length },
      };
    }
    // Wrap: keep the (now-shifted) inner text selected.
    return {
      from: start,
      to: end,
      text: open + inner + close,
      caretOffset: { anchor: open.length, head: open.length + inner.length },
    };
  }

  // Collapsed caret: check for an already-empty pair straddling it (e.g. caret inside `**|**`).
  if (beforeIsOpen && afterIsClose) {
    return { from: start - open.length, to: start + close.length, text: "", caretOffset: 0 };
  }
  return { from: start, to: start, text: open + close, caretOffset: open.length };
}

/** R46: `format.insertLink` — `[selected text]()` with the caret inside the empty `()`, or `[]()`
 * with the caret inside `[]` when there is no selection. */
export function buildLinkInsertion(content: string, start: number, end: number): ReplaceRangeSpec {
  if (start !== end) {
    const inner = content.slice(start, end);
    const text = `[${inner}]()`;
    return { from: start, to: end, text, caretOffset: text.length - 1 }; // inside the ()
  }
  return { from: start, to: start, text: "[]()", caretOffset: 1 }; // inside the []
}
