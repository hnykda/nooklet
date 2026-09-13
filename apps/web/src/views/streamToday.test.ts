// @vitest-environment jsdom
/**
 * B-170: the journal stream's "Today" follows the local day under a fake clock — at midnight, and
 * after sleeping through it — but not while someone is mid-sentence in the stream, where swapping
 * the day's `BlockTree` out would drop an edit still inside the editor's debounce.
 */

import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSharedDayClock } from "../data/day-clock.js";
import { createStreamToday, EDIT_IDLE_MS } from "./streamToday.js";

function mount(root: HTMLElement): { today: () => number; dispose: () => void } {
  return createRoot((dispose) => ({ today: createStreamToday(() => root), dispose }));
}

describe("createStreamToday (B-170)", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement("div");
    root.appendChild(document.createElement("textarea"));
    document.body.appendChild(root);
  });
  afterEach(() => {
    resetSharedDayClock();
    root.remove();
    vi.useRealTimers();
  });

  it("moves to the new day at local midnight", () => {
    vi.setSystemTime(new Date(2026, 8, 12, 23, 59, 58));
    resetSharedDayClock();
    const s = mount(root);
    expect(s.today()).toBe(20260912);

    vi.advanceTimersByTime(3_000);
    expect(s.today()).toBe(20260913);
    s.dispose();
  });

  it("moves when the tab is shown again after sleeping through midnight", () => {
    vi.setSystemTime(new Date(2026, 8, 12, 22, 0, 0));
    resetSharedDayClock();
    const s = mount(root);

    vi.setSystemTime(new Date(2026, 8, 13, 8, 0, 0));
    expect(s.today()).toBe(20260912);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(s.today()).toBe(20260913);
    s.dispose();
  });

  it("waits for typing in the stream to pause before moving, then moves", () => {
    vi.setSystemTime(new Date(2026, 8, 12, 23, 59, 59));
    resetSharedDayClock();
    const s = mount(root);
    const textarea = root.querySelector("textarea") as HTMLTextAreaElement;

    // Typing straight through midnight, a key every 300 ms.
    const type = (): void => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
    for (let i = 0; i < 10; i++) {
      type();
      vi.advanceTimersByTime(300);
    }
    // Midnight has passed (00:00:02) but the last key was 300 ms ago.
    expect(s.today()).toBe(20260912);

    // The typist stops; once input has been quiet for EDIT_IDLE_MS the day moves.
    vi.advanceTimersByTime(EDIT_IDLE_MS);
    expect(s.today()).toBe(20260913);
    s.dispose();
  });

  it("does not wait on an idle caret: no input, no delay", () => {
    vi.setSystemTime(new Date(2026, 8, 12, 23, 59, 59));
    resetSharedDayClock();
    const s = mount(root);
    (root.querySelector("textarea") as HTMLTextAreaElement).focus();

    vi.advanceTimersByTime(1_500);
    expect(s.today()).toBe(20260913);
    s.dispose();
  });
});
