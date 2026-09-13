/**
 * Give the keyboard back to whoever had it before an overlay took it.
 *
 * The palette and the page picker put focus in their own `<input>` when they open. When they close
 * that input is removed, and a removed focused element leaves focus on `<body>` — where it stayed:
 * Escape out of Cmd+K while editing, and the next keystroke went nowhere (B-161, B-195). The e2e
 * test for it passed only when a frame-later refocus armed by an earlier click happened to land
 * after the Escape, i.e. on a machine slow enough for frames to lag the keyboard.
 *
 * So this is synchronous and owns no timers: `rememberFocus()` is called as the overlay opens (before
 * its input's focus microtask runs), and the function it returns is called as it closes — in the
 * same task as the key or click that closed it, so the next input event already finds focus back.
 *
 * It only gives focus back when the overlay is what lost it — focus is on `<body>` or still inside
 * the overlay. A command chosen from the palette that put focus somewhere on purpose (a picker's
 * input, the outliner for block selection, another block's editor) keeps it. And only to an element
 * still in the document: a command that ended editing detached the editor, and a navigation
 * unmounted the page — focusing a detached element does nothing useful.
 *
 * Host-agnostic like the rest of `commands/`: plain DOM, no editor import. The single CM6 surface's
 * `.cm-content` is one element re-parented between rows, so "still connected" is exactly "still
 * editing"; its own focus handler keeps the caret where it was.
 */

/** Record what has focus now; the returned function hands focus back to it (see above). `overlay`
 * is read when giving back, so it may be a ref that is assigned after this is called. */
export function rememberFocus(overlay?: () => Element | null | undefined): () => void {
  if (typeof document === "undefined") return () => {};
  const previous = document.activeElement;
  return () => {
    if (!(previous instanceof HTMLElement) || previous === document.body) return;
    if (!previous.isConnected) return;
    const active = document.activeElement;
    const root = overlay?.();
    const lostToOverlay =
      active === null || active === document.body || (root?.contains(active) ?? false);
    if (!lostToOverlay || active === previous) return;
    previous.focus({ preventScroll: true });
  };
}
