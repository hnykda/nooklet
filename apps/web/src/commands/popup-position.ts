/**
 * Where a caret-anchored popup (the slash menu, the `[[`/`#`/`((` autocomplete) goes so all of it
 * is on screen (B-681).
 *
 * Both popups used to be placed at the caret's bottom-left and nothing else: at 390px a caret past
 * the middle of the line put a 220-360px menu off the right edge, and a caret low on the screen
 * put it under the keyboard. Now: below the caret line when it fits above the keyboard, else
 * above the caret line (its bottom at the line's top), else whichever side has more room with the
 * menu shortened to fit and scrolling. Horizontally from the caret, shifted left as far as needed.
 */

import { createSignal, onCleanup } from "solid-js";

export interface CaretRect {
  left: number;
  top: number;
  bottom: number;
}

export interface PopupPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

export function placeAtCaret(
  caret: CaretRect,
  popup: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): PopupPlacement {
  const left = Math.max(margin, Math.min(caret.left, viewport.width - popup.width - margin));
  const below = viewport.height - margin - caret.bottom;
  const above = caret.top - margin;
  if (popup.height <= below) return { left, top: caret.bottom, maxHeight: below };
  if (popup.height <= above) return { left, top: caret.top - popup.height, maxHeight: above };
  // Fits on neither side: the roomier one, shortened (the popup scrolls past `max-height`).
  if (below >= above) return { left, top: caret.bottom, maxHeight: Math.max(0, below) };
  const h = Math.max(0, above);
  return { left, top: caret.top - h, maxHeight: h };
}

/**
 * The part of the window a popup can use: the visual viewport (a browser's keyboard shrinks it),
 * less the mobile keyboard toolbar fixed over the bottom (`.cmd-toolbar`, `bottom: var(--kb)`) —
 * in the iOS app the keyboard does NOT shrink any viewport (`KeyboardResize.None`), and the
 * toolbar's top is the only on-screen measure of where the keyboard starts.
 */
export function usablePopupViewport(): { width: number; height: number } {
  const vv = window.visualViewport;
  const width = Math.min(window.innerWidth, vv ? vv.width : window.innerWidth);
  let height = Math.min(window.innerHeight, vv ? vv.height + vv.offsetTop : window.innerHeight);
  const toolbarTop = document.querySelector(".cmd-toolbar")?.getBoundingClientRect().top;
  if (toolbarTop !== undefined && toolbarTop > 0) height = Math.min(height, toolbarTop);
  return { width, height };
}

/** The CSS cap on a popup's height (`.cmd-popup` `max-height` in `./styles.css`). */
const POPUP_MAX_HEIGHT = 280;

/**
 * Solid glue for `placeAtCaret`: give the popup element to `ref`, spread `style()` onto it. The
 * size is measured (as `BlockContextMenu` does for B-351), not guessed — the number of rows
 * changes with every character of the query. The NATURAL height (`scrollHeight`, capped as the CSS
 * caps it) is what is placed, so a popup shortened to fit one side does not then read as "fits"
 * and flip back.
 */
export function createCaretPopupStyle(caret: () => CaretRect): {
  ref: (el: HTMLElement) => void;
  style: () => Record<string, string>;
} {
  const [size, setSize] = createSignal<{ width: number; height: number } | null>(null);
  const measure = (el: HTMLElement): void => {
    const border = el.offsetHeight - el.clientHeight;
    setSize({
      width: el.offsetWidth,
      height: Math.min(POPUP_MAX_HEIGHT, el.scrollHeight + border),
    });
  };
  return {
    ref(el) {
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(() => measure(el));
      ro.observe(el);
      // Rows added while the box is at its cap do not resize it; their number still matters.
      const mo = new MutationObserver(() => measure(el));
      mo.observe(el, { childList: true, subtree: true });
      onCleanup(() => {
        ro.disconnect();
        mo.disconnect();
      });
    },
    style(): Record<string, string> {
      const c = caret();
      const s = size();
      // Before the first measurement: the caret's bottom-left, as it always was.
      if (!s) return { top: `${c.bottom}px`, left: `${c.left}px` };
      const at = placeAtCaret(c, s, usablePopupViewport());
      return {
        top: `${at.top}px`,
        left: `${at.left}px`,
        "max-height": `${Math.min(POPUP_MAX_HEIGHT, at.maxHeight)}px`,
      };
    },
  };
}
