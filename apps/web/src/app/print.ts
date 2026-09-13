/**
 * Print / Save as PDF (B-221): the print stylesheet, the "is a print in progress" signal the
 * outliner reads to expand collapsed blocks, and the `window.print()` the "Print page" command and
 * the page's "…" menu call.
 *
 * The signal follows `beforeprint`/`afterprint` rather than being set by our own command, so
 * Cmd/Ctrl+P and the browser's File > Print get the same page as the command does. Both events
 * are dispatched synchronously around print layout, and a Solid signal write re-renders
 * synchronously, so the collapsed children are in the DOM by the time the page is laid out for
 * paper (verified in `e2e/tests/page-print.spec.ts`, which reads the DOM from a later
 * `beforeprint` listener and counts the pages of a real `page.pdf()`).
 *
 * Listeners are installed when this module is first imported — `editor/BlockTree.tsx` and, through
 * `./page-actions.ts`, `./CommandLayer.tsx` both import it, so they exist from the first render —
 * and never removed: there is one window and one app.
 */

import { createSignal } from "solid-js";
import "../styles/print.css";

const [printing, setPrinting] = createSignal(false);

/** True between `beforeprint` and `afterprint`. Reactive. */
export const isPrinting = printing;

if (typeof window !== "undefined") {
  window.addEventListener("beforeprint", () => setPrinting(true));
  window.addEventListener("afterprint", () => setPrinting(false));
}

/** Open the browser's print dialog for whatever view is showing ("Save as PDF" lives there). */
export function printPage(): void {
  window.print();
}
