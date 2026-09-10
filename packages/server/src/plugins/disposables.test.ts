import { describe, expect, it } from "vitest";
import { DisposableTracker } from "./disposables.js";

describe("DisposableTracker", () => {
  it("disposes tracked items in reverse registration order", () => {
    const order: number[] = [];
    const tracker = new DisposableTracker();
    tracker.track({ dispose: () => order.push(1) });
    tracker.track({ dispose: () => order.push(2) });
    tracker.track({ dispose: () => order.push(3) });
    tracker.disposeAll();
    expect(order).toEqual([3, 2, 1]);
  });

  it("clears its list after disposing (a second disposeAll is a no-op)", () => {
    let calls = 0;
    const tracker = new DisposableTracker();
    tracker.track({ dispose: () => calls++ });
    tracker.disposeAll();
    tracker.disposeAll();
    expect(calls).toBe(1);
    expect(tracker.size).toBe(0);
  });

  it("one disposable throwing does not stop the rest from being disposed", () => {
    const order: string[] = [];
    const tracker = new DisposableTracker();
    tracker.track({ dispose: () => order.push("first") });
    tracker.track({
      dispose: () => {
        throw new Error("boom");
      },
    });
    tracker.track({ dispose: () => order.push("third") });
    expect(() => tracker.disposeAll()).not.toThrow();
    expect(order).toEqual(["third", "first"]);
  });

  it("subscriptions reflects tracked items and shrinks to empty after disposeAll", () => {
    const tracker = new DisposableTracker();
    tracker.track({ dispose: () => {} });
    tracker.track({ dispose: () => {} });
    expect(tracker.subscriptions).toHaveLength(2);
    tracker.disposeAll();
    expect(tracker.subscriptions).toHaveLength(0);
  });

  it("track() returns the same disposable it was given", () => {
    const tracker = new DisposableTracker();
    const d = { dispose: () => {} };
    expect(tracker.track(d)).toBe(d);
  });
});
