/**
 * Handlers for a button that must not take focus from the block editor when pressed — the task
 * marker, the bullet, the collapse arrow, the phone toolbar (R61). Losing focus for even a moment
 * ends the iOS keyboard session, and on the desktop it would blur the editor mid-edit.
 *
 * Focus moves as the default action of `mousedown`, so that is the event to cancel. These buttons
 * used to cancel `pointerdown` instead, and for a touch that is not the same thing: Chromium
 * (Android, and Playwright's touch emulation) then sends no `click` for the tap at all, so a
 * tap on the task checkbox did nothing (B-661; probe `tools/probes/phone-ui/marker-tap-chromium.spec.ts`).
 * A tap's own `mousedown` comes after `pointerup`, and cancelling it keeps the focus while the
 * `click` still fires — in Chromium and in iOS WebKit alike (Simulator, B-661).
 *
 * A mouse or pen keeps its `pointerdown` cancel as well: that is how these buttons behaved on the
 * desktop before, and a cancelled `pointerdown` also suppresses the compatibility `mousedown`, so
 * nothing about a mouse click changes.
 */
export const keepEditorFocus = {
  onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "touch") e.preventDefault();
  },
  onMouseDown(e: MouseEvent): void {
    e.preventDefault();
  },
} as const;
