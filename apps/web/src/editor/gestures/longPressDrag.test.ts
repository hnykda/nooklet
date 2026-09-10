import { describe, expect, it } from "vitest";
import {
  DEFAULT_LONG_PRESS_DRAG_CONFIG,
  IDLE_LONG_PRESS_DRAG_STATE,
  type LongPressDragState,
  stepLongPressDrag,
} from "./longPressDrag.js";

const down = (x: number, y: number, pointerId = 1) =>
  ({ type: "pointerdown", pointerId, x, y }) as const;
const move = (x: number, y: number, pointerId = 1) =>
  ({ type: "pointermove", pointerId, x, y }) as const;
const up = (pointerId = 1) => ({ type: "pointerup", pointerId }) as const;
const cancelEv = (pointerId = 1) => ({ type: "pointercancel", pointerId }) as const;
const elapsed = (pointerId = 1) => ({ type: "timerElapsed", pointerId }) as const;

describe("stepLongPressDrag", () => {
  it("arms the configured timer on pointerdown", () => {
    const { state, actions } = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0));
    expect(state.phase).toBe("pressing");
    expect(actions).toEqual([
      { type: "armTimer", delayMs: DEFAULT_LONG_PRESS_DRAG_CONFIG.delayMs },
    ]);
  });

  it("honors a custom delayMs in the armTimer action", () => {
    const { actions } = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0), {
      ...DEFAULT_LONG_PRESS_DRAG_CONFIG,
      delayMs: 400,
    });
    expect(actions).toEqual([{ type: "armTimer", delayMs: 400 }]);
  });

  it("cancels the press (back to idle, no lift) when movement exceeds tolerance before the timer fires", () => {
    const { state: pressing } = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0));
    const { state, actions } = stepLongPressDrag(pressing, move(0, 9));
    expect(state).toEqual(IDLE_LONG_PRESS_DRAG_STATE);
    expect(actions).toEqual([]);
  });

  it("does not cancel for movement within tolerance", () => {
    const { state: pressing } = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0));
    const { state, actions } = stepLongPressDrag(pressing, move(3, 4)); // hypot = 5, under 8
    expect(state.phase).toBe("pressing");
    expect(actions).toEqual([]);
  });

  it("timerElapsed while pressing starts the drag and fires lift", () => {
    const { state: pressing } = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0));
    const { state, actions } = stepLongPressDrag(pressing, elapsed());
    expect(state.phase).toBe("dragging");
    expect(actions).toEqual([{ type: "lift" }]);
  });

  it("timerElapsed is a no-op once the press was already cancelled (idle)", () => {
    const { state, actions } = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, elapsed());
    expect(state).toEqual(IDLE_LONG_PRESS_DRAG_STATE);
    expect(actions).toEqual([]);
  });

  it("a released short tap (pointerup before the timer) produces no actions", () => {
    const { state: pressing } = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0));
    const { state, actions } = stepLongPressDrag(pressing, up());
    expect(state).toEqual(IDLE_LONG_PRESS_DRAG_STATE);
    expect(actions).toEqual([]);
  });

  function dragging(): LongPressDragState {
    const { state: pressing } = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 100));
    return stepLongPressDrag(pressing, elapsed()).state;
  }

  it("emits one moveStep down after crossing exactly one row height downward", () => {
    const { state, actions } = stepLongPressDrag(dragging(), move(0, 100 + 32));
    expect(actions).toEqual([{ type: "moveStep", direction: "down" }]);
    expect(state.crossed).toBe(1);
  });

  it("emits one moveStep up after crossing exactly one row height upward", () => {
    const { state, actions } = stepLongPressDrag(dragging(), move(0, 100 - 32));
    expect(actions).toEqual([{ type: "moveStep", direction: "up" }]);
    expect(state.crossed).toBe(-1);
  });

  it("emits multiple moveStep actions in order when several rows are crossed in one move", () => {
    const { state, actions } = stepLongPressDrag(dragging(), move(0, 100 + 32 * 3));
    expect(actions).toEqual([
      { type: "moveStep", direction: "down" },
      { type: "moveStep", direction: "down" },
      { type: "moveStep", direction: "down" },
    ]);
    expect(state.crossed).toBe(3);
  });

  it("moving back toward the start emits the opposite direction and can net to zero crossings", () => {
    const first = stepLongPressDrag(dragging(), move(0, 100 + 64)); // cross 2 down
    expect(first.actions).toHaveLength(2);
    const second = stepLongPressDrag(first.state, move(0, 100)); // back to start
    expect(second.actions).toEqual([
      { type: "moveStep", direction: "up" },
      { type: "moveStep", direction: "up" },
    ]);
    expect(second.state.crossed).toBe(0);
  });

  it("sub-half-row movement while dragging does not emit a moveStep (rounds to the same crossing)", () => {
    const { state, actions } = stepLongPressDrag(dragging(), move(0, 100 + 10));
    expect(actions).toEqual([]);
    expect(state.crossed).toBe(0);
  });

  it("pointerup while dragging drops and returns to idle", () => {
    const { state, actions } = stepLongPressDrag(dragging(), up());
    expect(actions).toEqual([{ type: "drop" }]);
    expect(state).toEqual(IDLE_LONG_PRESS_DRAG_STATE);
  });

  it("pointercancel while dragging cancels and returns to idle", () => {
    const { state, actions } = stepLongPressDrag(dragging(), cancelEv());
    expect(actions).toEqual([{ type: "cancel" }]);
    expect(state).toEqual(IDLE_LONG_PRESS_DRAG_STATE);
  });

  it("ignores events for an untracked pointer", () => {
    const pressing = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0, 1)).state;
    const { state, actions } = stepLongPressDrag(pressing, elapsed(2));
    expect(state).toEqual(pressing);
    expect(actions).toEqual([]);
  });

  it("a second pointerdown while one press/drag is already active is ignored", () => {
    const pressing = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0, 1)).state;
    const { state, actions } = stepLongPressDrag(pressing, down(0, 0, 2));
    expect(state).toEqual(pressing);
    expect(actions).toEqual([]);
  });

  it("uses a custom rowHeightPx from config", () => {
    const pressing = stepLongPressDrag(IDLE_LONG_PRESS_DRAG_STATE, down(0, 0)).state;
    const draggingState = stepLongPressDrag(pressing, elapsed()).state;
    const { actions } = stepLongPressDrag(draggingState, move(0, 50), {
      ...DEFAULT_LONG_PRESS_DRAG_CONFIG,
      rowHeightPx: 50,
    });
    expect(actions).toEqual([{ type: "moveStep", direction: "down" }]);
  });
});
