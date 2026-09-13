// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPopupOpen } from "../popup-keys.js";
import { describeRepeat, monthCells, openDatePicker } from "./DatePicker.js";
import type { DatePickRequest } from "./host.js";

const TODAY = 20260913; // a Sunday

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

function open(overrides: Partial<DatePickRequest> = {}) {
  const onPick = vi.fn();
  const onCancel = vi.fn();
  close = openDatePicker({
    blockId: "b1",
    field: "scheduled",
    current: undefined,
    repeat: null,
    today: TODAY,
    anchor: { top: 10, left: 10 },
    ...overrides,
    onPick,
    onCancel,
  });
  return { onPick, onCancel };
}

/** A key as the browser delivers it: to whatever has focus, bubbling through the window's capture
 * phase first — which is where the picker listens. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
}

function type(text: string): void {
  for (const ch of text) press(ch);
}

const activeDay = () =>
  Number(document.querySelector(".dp-day--active")?.getAttribute("data-day") ?? 0);

describe("openDatePicker (R38)", () => {
  it("opens on today (or the block's date) and claims the popup keys while open", () => {
    open();
    expect(document.querySelector(".date-picker")).not.toBeNull();
    expect(activeDay()).toBe(TODAY);
    expect(isPopupOpen()).toBe(true);
    close?.();
    expect(document.querySelector(".date-picker")).toBeNull();
    expect(isPopupOpen()).toBe(false);

    open({ current: { day: 20261102, time: null } });
    expect(activeDay()).toBe(20261102);
  });

  it("typing moves the highlight and Enter sets it; the keys never reach the page behind", () => {
    const { onPick } = open();
    const behind = vi.fn();
    document.body.addEventListener("keydown", behind);
    type("fri 14:00");
    expect(activeDay()).toBe(20260918);
    expect(document.querySelector(".dp-text")?.textContent).toBe("fri 14:00");
    const enter = press("Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(behind).not.toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith({ kind: "set", day: 20260918, time: "14:00" });
    expect(document.querySelector(".date-picker")).toBeNull();
    document.body.removeEventListener("keydown", behind);
  });

  it("arrows move by a day and a week, PageDown by a month, starting from what was typed", () => {
    const { onPick } = open();
    type("fri");
    press("ArrowRight"); // Sat 19
    press("ArrowDown"); // Sat 26
    press("PageDown"); // Oct 26
    press("ArrowLeft"); // Oct 25
    expect(activeDay()).toBe(20261025);
    expect(document.querySelector(".dp-text")).toBeNull(); // the query was folded in
    press("Enter");
    expect(onPick).toHaveBeenCalledWith({ kind: "set", day: 20261025, time: null });
  });

  it("Escape cancels without picking", () => {
    const { onPick, onCancel } = open({ current: { day: 20260920, time: null } });
    type("tomorrow");
    press("Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(document.querySelector(".date-picker")).toBeNull();
  });

  it("Enter on text that is not a date does nothing but say so; Backspace edits the text", () => {
    const { onPick } = open();
    type("banana");
    press("Enter");
    expect(onPick).not.toHaveBeenCalled();
    expect(document.querySelector(".dp-preview--error")?.textContent).toContain("not a date");
    for (let i = 0; i < 6; i++) press("Backspace");
    type("+3d");
    press("Enter");
    expect(onPick).toHaveBeenCalledWith({ kind: "set", day: 20260916, time: null });
  });

  it("keeps the block's time unless one is typed, and 'none' clears", () => {
    const first = open({ current: { day: 20260920, time: "08:15" }, repeat: "1w" });
    press("ArrowDown");
    press("Enter");
    expect(first.onPick).toHaveBeenCalledWith({ kind: "set", day: 20260927, time: "08:15" });

    const second = open({ current: { day: 20260920, time: null } });
    type("none");
    press("Enter");
    expect(second.onPick).toHaveBeenCalledWith({ kind: "clear" });
  });

  it("a Cmd/Ctrl shortcut closes the picker and is left for the app", () => {
    const { onCancel } = open();
    const e = press("k", { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(onCancel).toHaveBeenCalled();
    expect(document.querySelector(".date-picker")).toBeNull();
  });

  it("clicking a day sets it", () => {
    const { onPick } = open();
    (document.querySelector('[data-day="20260930"]') as HTMLButtonElement).click();
    expect(onPick).toHaveBeenCalledWith({ kind: "set", day: 20260930, time: null });
  });
});

describe("helpers", () => {
  it("monthCells covers whole Monday-first weeks", () => {
    const cells = monthCells(20260913);
    expect(cells[0]).toBe(20260831); // Monday before Sep 1 (a Tuesday)
    expect(cells.at(-1)).toBe(20261004); // Sunday after Sep 30 (a Wednesday)
    expect(cells.length % 7).toBe(0);
  });

  it("describeRepeat", () => {
    expect(describeRepeat("1w")).toBe("every week");
    expect(describeRepeat("2m from done")).toBe("every 2 months from done");
  });
});
