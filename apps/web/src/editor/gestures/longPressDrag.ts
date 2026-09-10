/**
 * Long-press-the-bullet-to-drag-reorder state machine (research/08-mobile.md §3.6): a pure
 * reducer over Pointer Events plus one synthetic `timerElapsed` event. The DOM glue
 * (`longPressDragAttach.ts`) owns the real `setTimeout` for the 300ms delay and dispatches
 * `timerElapsed` into this reducer — exactly how `../../platform/keyboard.ts` keeps
 * `computeKeyboardInset` pure and pushes `requestAnimationFrame`/`setTimeout` into its DOM-wiring
 * half, and how `swipe.ts`/`swipeAttach.ts` split the swipe gesture.
 *
 * A drag never invents a new "move to index" op: crossing one row's worth of vertical movement
 * emits one `moveStep` action, and the caller (`BlockTree.tsx`) runs it through the exact same
 * `moveBlock` + `block.moveUp`/`block.moveDown` path `Alt+Up`/`Alt+Down` already uses.
 */

export type LongPressDragPhase = "idle" | "pressing" | "dragging";

export interface LongPressDragState {
  phase: LongPressDragPhase;
  pointerId: number | null;
  startX: number;
  startY: number;
  /** How many row-heights' worth of vertical movement have already been converted into
   * `moveStep` actions. Only meaningful once `phase === "dragging"`. */
  crossed: number;
}

export const IDLE_LONG_PRESS_DRAG_STATE: LongPressDragState = {
  phase: "idle",
  pointerId: null,
  startX: 0,
  startY: 0,
  crossed: 0,
};

export type LongPressDragPointerEvent =
  | { type: "pointerdown"; pointerId: number; x: number; y: number }
  | { type: "pointermove"; pointerId: number; x: number; y: number }
  | { type: "pointerup"; pointerId: number }
  | { type: "pointercancel"; pointerId: number }
  | { type: "timerElapsed"; pointerId: number };

export type LongPressDragAction =
  | { type: "armTimer"; delayMs: number }
  | { type: "lift" }
  | { type: "moveStep"; direction: "up" | "down" }
  | { type: "drop" }
  | { type: "cancel" };

export interface LongPressDragConfig {
  /** Time the pointer must stay down (within `moveTolerancePx`) before a press becomes a drag. */
  delayMs: number;
  /** Movement before the timer fires that cancels the press — research §3.6: "< 8px movement". */
  moveTolerancePx: number;
  /** Height (px) of one sibling row — how far the pointer must travel to cross one. */
  rowHeightPx: number;
}

export const DEFAULT_LONG_PRESS_DRAG_CONFIG: LongPressDragConfig = {
  delayMs: 300,
  moveTolerancePx: 8,
  rowHeightPx: 32,
};

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

export interface LongPressDragStepResult {
  state: LongPressDragState;
  actions: LongPressDragAction[];
}

const NO_ACTIONS: LongPressDragAction[] = [];

export function stepLongPressDrag(
  state: LongPressDragState,
  event: LongPressDragPointerEvent,
  config: LongPressDragConfig = DEFAULT_LONG_PRESS_DRAG_CONFIG,
): LongPressDragStepResult {
  if (event.type === "pointerdown") {
    if (state.phase !== "idle") return { state, actions: NO_ACTIONS };
    return {
      state: {
        phase: "pressing",
        pointerId: event.pointerId,
        startX: event.x,
        startY: event.y,
        crossed: 0,
      },
      actions: [{ type: "armTimer", delayMs: config.delayMs }],
    };
  }

  if (state.pointerId === null || event.pointerId !== state.pointerId) {
    return { state, actions: NO_ACTIONS };
  }

  if (event.type === "pointermove") {
    if (state.phase === "pressing") {
      if (distance(state.startX, state.startY, event.x, event.y) > config.moveTolerancePx) {
        // Moved too much before the delay elapsed: not a long press. The DOM glue must clear its
        // pending setTimeout when it sees the state leave "pressing" like this.
        return { state: IDLE_LONG_PRESS_DRAG_STATE, actions: NO_ACTIONS };
      }
      return { state, actions: NO_ACTIONS };
    }
    if (state.phase === "dragging") {
      const dy = event.y - state.startY;
      const targetCrossed = Math.round(dy / config.rowHeightPx);
      if (targetCrossed === state.crossed) return { state, actions: NO_ACTIONS };
      const actions: LongPressDragAction[] = [];
      let step = state.crossed;
      while (step < targetCrossed) {
        actions.push({ type: "moveStep", direction: "down" });
        step++;
      }
      while (step > targetCrossed) {
        actions.push({ type: "moveStep", direction: "up" });
        step--;
      }
      return { state: { ...state, crossed: targetCrossed }, actions };
    }
    return { state, actions: NO_ACTIONS };
  }

  if (event.type === "timerElapsed") {
    if (state.phase !== "pressing") return { state, actions: NO_ACTIONS };
    return {
      state: { ...state, phase: "dragging", crossed: 0 },
      actions: [{ type: "lift" }],
    };
  }

  // pointerup / pointercancel
  if (state.phase === "dragging") {
    return {
      state: IDLE_LONG_PRESS_DRAG_STATE,
      actions: [{ type: event.type === "pointerup" ? "drop" : "cancel" }],
    };
  }
  // A short tap (released before the timer ever fired): not a drag, nothing to undo.
  return { state: IDLE_LONG_PRESS_DRAG_STATE, actions: NO_ACTIONS };
}
