/**
 * DOM wiring for `stepLongPressDrag` (`./longPressDrag.ts`): the real 300ms `setTimeout`,
 * `setPointerCapture`, and the `.vr-bullet-dragging` visual/haptic feedback. NOT unit tested (needs
 * a real timer-driven pointer sequence) — the pure decision logic is fully covered by
 * `longPressDrag.test.ts`; see apps/web/README.md's manual-verification list for what's left to
 * check on a device.
 */
import { platform } from "../../platform/index.js";
import {
  DEFAULT_LONG_PRESS_DRAG_CONFIG,
  IDLE_LONG_PRESS_DRAG_STATE,
  type LongPressDragConfig,
  type LongPressDragPointerEvent,
  type LongPressDragState,
  stepLongPressDrag,
} from "./longPressDrag.js";

export interface LongPressDragHandlers {
  /** Runs the exact same `moveBlock` + `block.moveUp`/`block.moveDown` op `Alt+Up`/`Alt+Down`
   * already runs — one call per row crossed. */
  moveStep(direction: "up" | "down"): void;
}

/**
 * Attach the long-press-to-drag gesture to a bullet/handle element. `handle` must have
 * `touch-action: none` (`editor.css`'s `.vr-bullet-wrap`) so the browser never starts its own
 * scroll/zoom gesture from a touch that started there. `getRowHeightPx` is read once per gesture,
 * at lift time, so callers can pass a live measurement rather than a hard-coded constant. Returns
 * a cleanup function.
 */
export function attachLongPressDrag(
  handle: HTMLElement,
  handlers: LongPressDragHandlers,
  getRowHeightPx: () => number,
  configOverrides: Partial<Omit<LongPressDragConfig, "rowHeightPx">> = {},
): () => void {
  let state: LongPressDragState = IDLE_LONG_PRESS_DRAG_STATE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rowHeightPx = DEFAULT_LONG_PRESS_DRAG_CONFIG.rowHeightPx;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function dispatch(event: LongPressDragPointerEvent): void {
    const config: LongPressDragConfig = {
      ...DEFAULT_LONG_PRESS_DRAG_CONFIG,
      ...configOverrides,
      rowHeightPx,
    };
    const wasPressing = state.phase === "pressing";
    const result = stepLongPressDrag(state, event, config);
    state = result.state;
    if (wasPressing && state.phase !== "pressing") clearTimer();

    for (const action of result.actions) {
      switch (action.type) {
        case "armTimer": {
          const pointerId = event.pointerId;
          timer = setTimeout(() => dispatch({ type: "timerElapsed", pointerId }), action.delayMs);
          break;
        }
        case "lift":
          rowHeightPx = getRowHeightPx() || DEFAULT_LONG_PRESS_DRAG_CONFIG.rowHeightPx;
          // Capture only once a drag genuinely starts, not on every pointerdown: capturing here
          // would retarget the compatibility `click` event to `handle` for an ordinary quick tap
          // too (Pointer Events spec), breaking the bullet/collapse-arrow's own `onClick` — see
          // `onPointerDown` below.
          try {
            handle.setPointerCapture(event.pointerId);
          } catch {
            // Best-effort: capture can fail if the pointer already went away.
          }
          handle.classList.add("vr-bullet-dragging");
          platform.haptics.impact("medium");
          break;
        case "moveStep":
          handlers.moveStep(action.direction);
          platform.haptics.selection();
          break;
        case "drop":
        case "cancel":
          handle.classList.remove("vr-bullet-dragging");
          break;
        default: {
          const exhaustive: never = action;
          throw new Error(`longPressDragAttach: unhandled action ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    // No `setPointerCapture` here (see the "lift" case below): capturing on every pointerdown
    // would retarget an ordinary tap's `click` event away from the bullet/collapse-arrow buttons.
    dispatch({ type: "pointerdown", pointerId: e.pointerId, x: e.clientX, y: e.clientY });
  };
  const onPointerMove = (e: PointerEvent): void =>
    dispatch({ type: "pointermove", pointerId: e.pointerId, x: e.clientX, y: e.clientY });
  const onPointerUp = (e: PointerEvent): void =>
    dispatch({ type: "pointerup", pointerId: e.pointerId });
  const onPointerCancel = (e: PointerEvent): void =>
    dispatch({ type: "pointercancel", pointerId: e.pointerId });

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerCancel);

  return () => {
    clearTimer();
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onPointerMove);
    handle.removeEventListener("pointerup", onPointerUp);
    handle.removeEventListener("pointercancel", onPointerCancel);
  };
}
