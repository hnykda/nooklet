/**
 * The local-day signal (B-94, B-170) under a fake clock: nobody waits for a real midnight. Vitest's
 * fake timers move `Date.now()` and fire `setTimeout` together; `vi.setSystemTime` alone moves the
 * wall clock WITHOUT firing timers, which is exactly what a sleeping laptop or a suspended phone
 * tab looks like to a page.
 */

import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDayClock,
  type ListenTarget,
  MAX_TIMER_MS,
  msUntilNextLocalMidnight,
} from "./day-clock.js";

class FakeTarget implements ListenTarget {
  visibilityState = "visible";
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const l of this.listeners.get(type) ?? []) l();
  }
  count(): number {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

/** Local wall-clock time — the day boundary is the device's, not UTC's. */
function local(y: number, m: number, d: number, h = 0, min = 0, s = 0): Date {
  return new Date(y, m - 1, d, h, min, s);
}

describe("msUntilNextLocalMidnight", () => {
  it("lands exactly on the next local midnight, including across daylight-saving changes", () => {
    // Whatever zone the suite runs in, these dates include both 2026 EU and US transitions.
    const starts = [
      local(2026, 9, 12, 23, 59, 30),
      local(2026, 3, 28, 12),
      local(2026, 3, 29, 1, 30),
      local(2026, 3, 7, 22),
      local(2026, 10, 24, 18),
      local(2026, 10, 31, 23),
      local(2026, 12, 31, 23, 59, 59),
    ];
    for (const start of starts) {
      const at = new Date(start.getTime() + msUntilNextLocalMidnight(start.getTime()));
      expect([at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([0, 0, 0]);
      const dayAfter = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
      expect(at.getTime()).toBe(dayAfter.getTime());
    }
  });
});

describe("createDayClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rolls over at local midnight, not before", () => {
    vi.setSystemTime(local(2026, 9, 12, 23, 59, 30));
    const doc = new FakeTarget();
    const clock = createDayClock({ document: doc, window: new FakeTarget() });
    expect(clock.day()).toBe(20260912);

    vi.advanceTimersByTime(29_000);
    expect(clock.day()).toBe(20260912);

    vi.advanceTimersByTime(2_000);
    expect(clock.day()).toBe(20260913);
    clock.dispose();
  });

  it("notifies readers once per rollover, not on every capped re-check", () => {
    vi.setSystemTime(local(2026, 9, 12, 8));
    const seen: number[] = [];
    const clock = createDayClock({ document: new FakeTarget(), window: new FakeTarget() });
    const dispose = createRoot((d) => {
      createEffect(() => seen.push(clock.day()));
      return d;
    });
    // 40 hours of re-checks every five minutes: two rollovers, so exactly two notifications.
    vi.advanceTimersByTime(40 * 3_600_000);
    expect(seen).toEqual([20260912, 20260913, 20260914]);
    dispose();
    clock.dispose();
  });

  it("catches up when the page becomes visible after sleeping through midnight", () => {
    vi.setSystemTime(local(2026, 9, 12, 21));
    const doc = new FakeTarget();
    const clock = createDayClock({ document: doc, window: new FakeTarget() });

    // Suspended tab: the wall clock moves, no timer fires.
    vi.setSystemTime(local(2026, 9, 13, 7, 30));
    expect(clock.day()).toBe(20260912);

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    // Going hidden is not a reason to re-render anything.
    expect(clock.day()).toBe(20260912);

    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(clock.day()).toBe(20260913);
    clock.dispose();
  });

  it("catches up on window focus (a visible desktop window that slept)", () => {
    vi.setSystemTime(local(2026, 9, 12, 21));
    const win = new FakeTarget();
    const clock = createDayClock({ document: new FakeTarget(), window: win });
    vi.setSystemTime(local(2026, 9, 13, 9));
    win.fire("focus");
    expect(clock.day()).toBe(20260913);
    clock.dispose();
  });

  it("catches up within MAX_TIMER_MS when a timer armed hours ahead was paused by sleep", () => {
    // 20:00: midnight is four hours away, but no single timer waits that long.
    vi.setSystemTime(local(2026, 9, 12, 20));
    const clock = createDayClock({ document: new FakeTarget(), window: new FakeTarget() });

    // Lid closed until 06:00 — timers are on a monotonic clock that did not run meanwhile.
    vi.setSystemTime(local(2026, 9, 13, 6));
    expect(clock.day()).toBe(20260912);

    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(clock.day()).toBe(20260913);
    clock.dispose();
  });

  it("dispose stops the timer and removes every listener", () => {
    vi.setSystemTime(local(2026, 9, 12, 23, 59));
    const doc = new FakeTarget();
    const win = new FakeTarget();
    const clock = createDayClock({ document: doc, window: win });
    expect(vi.getTimerCount()).toBe(1);
    expect(doc.count() + win.count()).toBe(2);

    clock.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.count() + win.count()).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    expect(clock.day()).toBe(20260912);
  });
});
