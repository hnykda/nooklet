/**
 * Keeps a list's highlighted row on screen while the arrow keys move it (B-746).
 *
 * The popups keep focus in the editor (or their input) and move a highlight index, so nothing
 * moves the browser's focus to the row and nothing scrolls the list: past the last visible row
 * the highlight walked off into the scrolled-out part and Enter picked something unseen.
 * `block: "nearest"` scrolls only when the row is outside the list's visible part, so a row the
 * mouse is hovering (which also sets the highlight) never makes the list jump.
 */
import { createEffect, on } from "solid-js";

export function keepActiveInView(
  list: () => HTMLElement | undefined,
  highlight: () => number,
): void {
  createEffect(
    on(highlight, () => {
      const row = list()?.querySelector<HTMLElement>('[aria-selected="true"]');
      // `scrollIntoView` is absent under jsdom.
      row?.scrollIntoView?.({ block: "nearest" });
    }),
  );
}
