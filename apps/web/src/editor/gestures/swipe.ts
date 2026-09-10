/**
 * Swipe-right/left-to-indent/outdent state machine (research/08-mobile.md §3.5): a pure reducer
 * over Pointer Events, structured the same way `../keydown.ts` turns keys into commands, so it is
 * unit-testable with zero DOM (`swipe.test.ts`). `swipeAttach.ts` is the thin, untested DOM wiring
 * around it (real `PointerEvent`s, `setPointerCapture`, the live CSS transform) — the same
 * pure-function/DOM-glue split `../../platform/keyboard.ts` uses for the keyboard inset.
 *
 * The reducer never builds an op itself: its `indent`/`outdent` actions are just intent — the
 * caller (`BlockTree.tsx`) runs them through the exact same `indentBlock`/`outdentBlock` +
 * `runStructural` path the Tab/Shift-Tab keys use, so a swipe is never a parallel implementation.
 *
 * `capture` fires only once a move actually commits to `"swiping"`, NOT on every `pointerdown`
 * (research §3.5's own reference snippet captures immediately on pointerdown — deliberately not
 * copied here): `.vr-row`'s content area has its own tap-to-edit click handler
 * (`BlockRowView.tsx`), and per the Pointer Events spec a captured element also becomes the
 * target of the touch-driven compatibility `click` event, which would silently break tap-to-edit
 * on every plain tap if capture were requested before a real swipe was confirmed. A tap that never
 * exceeds `horizontalLockPx` never reaches `"swiping"`, so it never triggers `capture` at all.
 */

export type SwipePhase = "idle" | "undecided" | "scrolling" | "swiping";

export interface SwipeState {
  phase: SwipePhase;
  pointerId: number | null;
  startX: number;
  startY: number;
  /** Current horizontal offset, clamped to `[-maxTranslatePx, maxTranslatePx]`. Only meaningful
   * once `phase === "swiping"`. */
  dx: number;
}

export const IDLE_SWIPE_STATE: SwipeState = {
  phase: "idle",
  pointerId: null,
  startX: 0,
  startY: 0,
  dx: 0,
};

export type SwipePointerEvent =
  | { type: "pointerdown"; pointerId: number; pointerType: string; x: number; y: number }
  | { type: "pointermove"; pointerId: number; x: number; y: number }
  | { type: "pointerup"; pointerId: number }
  | { type: "pointercancel"; pointerId: number };

export type SwipeAction =
  | { type: "capture" }
  | { type: "setTransform"; dx: number }
  | { type: "resetTransform" }
  | { type: "indent" }
  | { type: "outdent" };

export interface SwipeConfig {
  /** Net horizontal distance (px) that commits an indent/outdent on release. */
  thresholdPx: number;
  /** Vertical distance beyond which an undecided move locks to native scrolling, not a swipe. */
  verticalLockPx: number;
  /** Horizontal distance beyond which an undecided move commits to swipe mode. */
  horizontalLockPx: number;
  /** Visual clamp on the live drag transform. */
  maxTranslatePx: number;
}

/** research/08-mobile.md §3.5's numbers verbatim: 48px commit threshold, 8px/12px direction lock,
 * 72px visual clamp. */
export const DEFAULT_SWIPE_CONFIG: SwipeConfig = {
  thresholdPx: 48,
  verticalLockPx: 8,
  horizontalLockPx: 12,
  maxTranslatePx: 72,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface SwipeStepResult {
  state: SwipeState;
  actions: SwipeAction[];
}

const NO_ACTIONS: SwipeAction[] = [];

export function stepSwipe(
  state: SwipeState,
  event: SwipePointerEvent,
  config: SwipeConfig = DEFAULT_SWIPE_CONFIG,
): SwipeStepResult {
  if (event.type === "pointerdown") {
    // Only one gesture at a time, and mouse/pen pointers must keep working for click-to-edit and
    // text selection instead of triggering a swipe (research §3.5 checks `pointerType === 'touch'`
    // at the DOM layer; doing it here keeps the rule itself testable).
    if (state.phase !== "idle" || event.pointerType !== "touch") {
      return { state, actions: NO_ACTIONS };
    }
    return {
      state: {
        phase: "undecided",
        pointerId: event.pointerId,
        startX: event.x,
        startY: event.y,
        dx: 0,
      },
      actions: NO_ACTIONS,
    };
  }

  // Every other event only matters for the pointer already being tracked.
  if (state.pointerId === null || event.pointerId !== state.pointerId) {
    return { state, actions: NO_ACTIONS };
  }

  if (event.type === "pointermove") {
    const dx = event.x - state.startX;
    const dy = event.y - state.startY;

    if (state.phase === "undecided") {
      if (Math.abs(dy) > config.verticalLockPx && Math.abs(dy) > Math.abs(dx)) {
        // A vertical pan wins: hand the gesture back to native scrolling and never revisit it for
        // the rest of this pointer's lifetime, even if it later moves back horizontally.
        return { state: { ...state, phase: "scrolling" }, actions: NO_ACTIONS };
      }
      if (Math.abs(dx) > config.horizontalLockPx) {
        const clamped = clamp(dx, -config.maxTranslatePx, config.maxTranslatePx);
        return {
          state: { ...state, phase: "swiping", dx: clamped },
          // Capture only now that this is a real swipe, not a tap (see the file-level doc comment).
          actions: [{ type: "capture" }, { type: "setTransform", dx: clamped }],
        };
      }
      return { state, actions: NO_ACTIONS };
    }

    if (state.phase === "swiping") {
      const clamped = clamp(dx, -config.maxTranslatePx, config.maxTranslatePx);
      return {
        state: { ...state, dx: clamped },
        actions: [{ type: "setTransform", dx: clamped }],
      };
    }

    // phase === "scrolling": the browser owns this gesture now, ignore further moves.
    return { state, actions: NO_ACTIONS };
  }

  // pointerup / pointercancel: decide (if we ever entered "swiping"), then always return to idle.
  const actions: SwipeAction[] = [];
  if (state.phase === "swiping") {
    if (state.dx > config.thresholdPx) actions.push({ type: "indent" });
    else if (state.dx < -config.thresholdPx) actions.push({ type: "outdent" });
    actions.push({ type: "resetTransform" });
  }
  return { state: IDLE_SWIPE_STATE, actions };
}
