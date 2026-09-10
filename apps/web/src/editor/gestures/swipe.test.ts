import { describe, expect, it } from "vitest";
import { DEFAULT_SWIPE_CONFIG, IDLE_SWIPE_STATE, type SwipeState, stepSwipe } from "./swipe.js";

const down = (x: number, y: number, pointerId = 1, pointerType = "touch") =>
  ({ type: "pointerdown", pointerId, pointerType, x, y }) as const;
const move = (x: number, y: number, pointerId = 1) =>
  ({ type: "pointermove", pointerId, x, y }) as const;
const up = (pointerId = 1) => ({ type: "pointerup", pointerId }) as const;
const cancel = (pointerId = 1) => ({ type: "pointercancel", pointerId }) as const;

describe("stepSwipe", () => {
  it("starts undecided on a touch pointerdown, without requesting pointer capture yet", () => {
    // Capture is deliberately deferred until a move actually commits to swiping (see swipe.ts's
    // doc comment): capturing on every pointerdown would retarget the row's own tap-to-edit click.
    const { state, actions } = stepSwipe(IDLE_SWIPE_STATE, down(0, 0));
    expect(state.phase).toBe("undecided");
    expect(actions).toEqual([]);
  });

  it("ignores non-touch pointerdown (mouse/pen keep click-to-edit and text selection)", () => {
    const { state, actions } = stepSwipe(IDLE_SWIPE_STATE, down(0, 0, 1, "mouse"));
    expect(state).toEqual(IDLE_SWIPE_STATE);
    expect(actions).toEqual([]);
  });

  it("ignores events for a pointer that never started the gesture", () => {
    const { state: s1 } = stepSwipe(IDLE_SWIPE_STATE, down(0, 0, 1));
    const { state, actions } = stepSwipe(s1, move(30, 0, 2));
    expect(state).toEqual(s1);
    expect(actions).toEqual([]);
  });

  it("stays undecided under both direction-lock thresholds", () => {
    const { state: s1 } = stepSwipe(IDLE_SWIPE_STATE, down(0, 0));
    const { state, actions } = stepSwipe(s1, move(5, 3));
    expect(state.phase).toBe("undecided");
    expect(actions).toEqual([]);
  });

  it("locks to swiping once the horizontal move exceeds the lock threshold, capturing only now", () => {
    const { state: s1 } = stepSwipe(IDLE_SWIPE_STATE, down(0, 0));
    const { state, actions } = stepSwipe(s1, move(13, 0));
    expect(state.phase).toBe("swiping");
    expect(state.dx).toBe(13);
    expect(actions).toEqual([{ type: "capture" }, { type: "setTransform", dx: 13 }]);
  });

  it("locks to scrolling once a vertical move dominates and exceeds its threshold", () => {
    const { state: s1 } = stepSwipe(IDLE_SWIPE_STATE, down(0, 0));
    const { state, actions } = stepSwipe(s1, move(2, 20));
    expect(state.phase).toBe("scrolling");
    expect(actions).toEqual([]);
  });

  it("a diagonal move that is more horizontal than vertical still swipes", () => {
    const { state: s1 } = stepSwipe(IDLE_SWIPE_STATE, down(0, 0));
    const { state } = stepSwipe(s1, move(20, 10));
    expect(state.phase).toBe("swiping");
  });

  it("once scrolling, later horizontal moves never re-enter swiping (cancellation is sticky)", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    state = stepSwipe(state, move(2, 20)).state; // -> scrolling
    expect(state.phase).toBe("scrolling");
    const { state: s2, actions } = stepSwipe(state, move(80, 20));
    expect(s2.phase).toBe("scrolling");
    expect(actions).toEqual([]);
  });

  it("commits indent when released past +threshold", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    state = stepSwipe(state, move(50, 0)).state;
    const { state: s2, actions } = stepSwipe(state, up());
    expect(actions).toEqual([{ type: "indent" }, { type: "resetTransform" }]);
    expect(s2).toEqual(IDLE_SWIPE_STATE);
  });

  it("commits outdent when released past -threshold", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    state = stepSwipe(state, move(-50, 0)).state;
    const { actions } = stepSwipe(state, up());
    expect(actions).toEqual([{ type: "outdent" }, { type: "resetTransform" }]);
  });

  it("exactly at the threshold does not commit (threshold is exclusive)", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    state = stepSwipe(state, move(48, 0)).state;
    const { actions } = stepSwipe(state, up());
    expect(actions).toEqual([{ type: "resetTransform" }]);
  });

  it("released below threshold still resets the transform but does not indent/outdent", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    state = stepSwipe(state, move(20, 0)).state;
    const { actions } = stepSwipe(state, up());
    expect(actions).toEqual([{ type: "resetTransform" }]);
  });

  it("released while still undecided (a plain tap) does nothing", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    const { state: s2, actions } = stepSwipe(state, up());
    expect(actions).toEqual([]);
    expect(s2).toEqual(IDLE_SWIPE_STATE);
  });

  it("pointercancel below threshold resets the transform without committing", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    state = stepSwipe(state, move(20, 0)).state; // under the 48px threshold
    const { state: s2, actions } = stepSwipe(state, cancel());
    expect(actions).toEqual([{ type: "resetTransform" }]);
    expect(s2).toEqual(IDLE_SWIPE_STATE);
  });

  it("pointercancel past threshold still commits, exactly like pointerup (research/08 §3.5's own end() handles both identically)", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    state = stepSwipe(state, move(60, 0)).state;
    const { state: s2, actions } = stepSwipe(state, cancel());
    expect(actions).toEqual([{ type: "indent" }, { type: "resetTransform" }]);
    expect(s2).toEqual(IDLE_SWIPE_STATE);
  });

  it("clamps the live transform to maxTranslatePx", () => {
    let state: SwipeState = IDLE_SWIPE_STATE;
    state = stepSwipe(state, down(0, 0)).state;
    const { state: s2, actions } = stepSwipe(state, move(500, 0));
    expect(s2.dx).toBe(DEFAULT_SWIPE_CONFIG.maxTranslatePx);
    // This move both commits to swiping AND immediately clamps, in one step.
    expect(actions).toEqual([
      { type: "capture" },
      { type: "setTransform", dx: DEFAULT_SWIPE_CONFIG.maxTranslatePx },
    ]);
  });

  it("a second pointerdown while one gesture is already active is ignored", () => {
    const { state: s1 } = stepSwipe(IDLE_SWIPE_STATE, down(0, 0, 1));
    const { state, actions } = stepSwipe(s1, down(0, 0, 2));
    expect(state).toEqual(s1);
    expect(actions).toEqual([]);
  });
});
