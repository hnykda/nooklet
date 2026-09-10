/**
 * DOM wiring for `stepSwipe` (`./swipe.ts`): real `PointerEvent`s, `setPointerCapture`, and the
 * live `translateX` feedback. NOT unit tested (needs a real pointer-capable element) — the pure
 * decision logic is fully covered by `swipe.test.ts`; see apps/web/README.md's manual-verification
 * list for what's left to check on a device.
 */
import { platform } from "../../platform/index.js";
import {
  DEFAULT_SWIPE_CONFIG,
  IDLE_SWIPE_STATE,
  type SwipeConfig,
  type SwipePointerEvent,
  type SwipeState,
  stepSwipe,
} from "./swipe.js";

export interface SwipeHandlers {
  /** Runs the exact same `block.indent`/`block.outdent` op the Tab/Shift-Tab keys run. */
  indent(): void;
  outdent(): void;
}

/** Attach the swipe-to-indent/outdent gesture to one block row. `row` must have
 * `touch-action: pan-y` (`editor.css`'s `.vr-row`) so vertical scrolling stays native. Returns a
 * cleanup function. */
export function attachSwipeRow(
  row: HTMLElement,
  handlers: SwipeHandlers,
  config: SwipeConfig = DEFAULT_SWIPE_CONFIG,
): () => void {
  let state: SwipeState = IDLE_SWIPE_STATE;

  function dispatch(event: SwipePointerEvent): void {
    const result = stepSwipe(state, event, config);
    state = result.state;
    for (const action of result.actions) {
      switch (action.type) {
        case "capture":
          // Emitted from the `pointermove` that confirms a real swipe (`swipe.ts`'s doc comment
          // explains why this is not requested on `pointerdown`); every `SwipePointerEvent`
          // variant carries `pointerId`, so this doesn't need to branch on `event.type`.
          try {
            row.setPointerCapture(event.pointerId);
          } catch {
            // Best-effort: capture can fail if the pointer already went away.
          }
          break;
        case "setTransform":
          row.classList.add("vr-row-swiping");
          row.style.transform = `translateX(${action.dx}px)`;
          break;
        case "resetTransform":
          row.classList.remove("vr-row-swiping");
          row.style.transform = "";
          break;
        case "indent":
          handlers.indent();
          platform.haptics.selection();
          break;
        case "outdent":
          handlers.outdent();
          platform.haptics.selection();
          break;
        default: {
          const exhaustive: never = action;
          throw new Error(`swipeAttach: unhandled action ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  }

  const onPointerDown = (e: PointerEvent): void => {
    dispatch({
      type: "pointerdown",
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x: e.clientX,
      y: e.clientY,
    });
  };
  const onPointerMove = (e: PointerEvent): void => {
    const wasSwiping = state.phase === "swiping";
    dispatch({ type: "pointermove", pointerId: e.pointerId, x: e.clientX, y: e.clientY });
    // Only suppress default handling once we're actually driving a horizontal drag — a vertical
    // pan (phase "scrolling") must keep native scrolling untouched.
    if (wasSwiping || state.phase === "swiping") e.preventDefault();
  };
  const onPointerUp = (e: PointerEvent): void =>
    dispatch({ type: "pointerup", pointerId: e.pointerId });
  const onPointerCancel = (e: PointerEvent): void =>
    dispatch({ type: "pointercancel", pointerId: e.pointerId });

  row.addEventListener("pointerdown", onPointerDown);
  row.addEventListener("pointermove", onPointerMove);
  row.addEventListener("pointerup", onPointerUp);
  row.addEventListener("pointercancel", onPointerCancel);

  return () => {
    row.removeEventListener("pointerdown", onPointerDown);
    row.removeEventListener("pointermove", onPointerMove);
    row.removeEventListener("pointerup", onPointerUp);
    row.removeEventListener("pointercancel", onPointerCancel);
  };
}
