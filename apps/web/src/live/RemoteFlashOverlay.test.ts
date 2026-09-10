/** Tests `flashBlockWhenReady`'s poll-and-flash logic against fakes — no real DOM/browser needed,
 * matching this codebase's own convention for client-logic tests. */
import { describe, expect, it, vi } from "vitest";
import { flashBlockWhenReady } from "./RemoteFlashOverlay.js";

describe("flashBlockWhenReady", () => {
  it("flashes immediately when the element already exists", () => {
    const el = {} as HTMLElement;
    const flashed: HTMLElement[] = [];
    flashBlockWhenReady("b1", { find: () => el, onFlash: (e) => flashed.push(e) });
    expect(flashed).toEqual([el]);
  });

  it("polls until the element appears (e.g. after a cross-page navigation), then flashes", () => {
    vi.useFakeTimers();
    try {
      const el = {} as HTMLElement;
      let calls = 0;
      const flashed: HTMLElement[] = [];
      flashBlockWhenReady("b1", {
        find: () => {
          calls++;
          return calls >= 3 ? el : null;
        },
        onFlash: (e) => flashed.push(e),
      });
      expect(flashed).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(flashed).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(flashed).toEqual([el]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up quietly after the poll budget, never throwing", () => {
    vi.useFakeTimers();
    try {
      const flashed: unknown[] = [];
      expect(() =>
        flashBlockWhenReady("ghost", { find: () => null, onFlash: (e) => flashed.push(e) }),
      ).not.toThrow();
      vi.advanceTimersByTime(5000);
      expect(flashed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
