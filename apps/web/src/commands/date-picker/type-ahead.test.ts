// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatePicker } from "./DatePicker.js";
import { holdPickerInput, type PickerInputHold, pickerKeyAction } from "./type-ahead.js";

const TODAY = 20260913; // a Sunday

let hold: PickerInputHold | undefined;
let closePicker: (() => void) | undefined;
afterEach(() => {
  hold?.release();
  hold = undefined;
  closePicker?.();
  closePicker = undefined;
});

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
}

function insertText(data: string): InputEvent {
  const e = new InputEvent("beforeinput", {
    inputType: "insertText",
    data,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(e);
  return e;
}

describe("pickerKeyAction", () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
    pickerKeyAction({
      key: k,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      isComposing: false,
      ...extra,
    });

  it("reads keys the way the picker always has", () => {
    expect(key("t")).toEqual({ kind: "key", key: { key: "t", shiftKey: false, altKey: false } });
    expect(key("Enter").kind).toBe("key");
    expect(key("Shift").kind).toBe("ignore");
    expect(key("x", { isComposing: true }).kind).toBe("ignore");
    expect(key("v", { metaKey: true }).kind).toBe("paste");
    expect(key("Backspace", { ctrlKey: true }).kind).toBe("clear");
    expect(key("k", { metaKey: true }).kind).toBe("shortcut");
  });
});

describe("holdPickerInput (B-147)", () => {
  it("takes keys and keydown-less text before they reach the page, in order", () => {
    hold = holdPickerInput(window);
    const behind = vi.fn();
    document.body.addEventListener("keydown", behind);
    document.body.addEventListener("beforeinput", behind);
    const t = press("t");
    const text = insertText("om");
    press("Shift");
    press("Enter");
    expect(t.defaultPrevented).toBe(true);
    expect(text.defaultPrevented).toBe(true);
    // Shift alone is let through (it types nothing); t, the text and Enter were not.
    expect(behind).toHaveBeenCalledTimes(1);
    expect(hold.take()).toEqual([
      { kind: "key", key: { key: "t", shiftKey: false, altKey: false } },
      { kind: "text", text: "om" },
      { kind: "key", key: { key: "Enter", shiftKey: false, altKey: false } },
    ]);
    expect(hold.cancelled()).toBe(false);
    document.body.removeEventListener("keydown", behind);
    document.body.removeEventListener("beforeinput", behind);
  });

  it("Escape cancels and stops holding, so the next key is the page's again", () => {
    hold = holdPickerInput(window);
    const esc = press("Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(hold.cancelled()).toBe(true);
    expect(press("x").defaultPrevented).toBe(false);
    expect(hold.take()).toEqual([]);
  });

  it("a Cmd/Ctrl shortcut cancels and is left alone to do its job", () => {
    hold = holdPickerInput(window);
    const shortcut = press("k", { metaKey: true });
    expect(shortcut.defaultPrevented).toBe(false);
    expect(hold.cancelled()).toBe(true);
  });

  it("a press anywhere cancels", () => {
    hold = holdPickerInput(window);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(hold.cancelled()).toBe(true);
  });

  it("release stops holding", () => {
    hold = holdPickerInput(window);
    hold.release();
    expect(press("t").defaultPrevented).toBe(false);
  });
});

describe("openDatePicker with type-ahead (B-147)", () => {
  function openWith(h: PickerInputHold) {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    closePicker = openDatePicker({
      blockId: "b1",
      field: "scheduled",
      current: undefined,
      repeat: null,
      today: TODAY,
      anchor: { top: 10, left: 10 },
      typeAhead: h,
      onPick,
      onCancel,
    });
    return { onPick, onCancel };
  }

  it("replays what was typed before it opened, then listens itself", () => {
    hold = holdPickerInput(window);
    for (const ch of "fri") press(ch);
    openWith(hold);
    expect(document.querySelector(".dp-text")?.textContent).toBe("fri");
    // The hold is gone; the picker's own listener takes the next key.
    press(" ");
    insertText("14:00");
    expect(document.querySelector(".dp-text")?.textContent).toBe("fri 14:00");
  });

  it("a held Enter sets the date as soon as the picker exists", () => {
    hold = holdPickerInput(window);
    for (const ch of "fri") press(ch);
    press("Enter");
    const { onPick } = openWith(hold);
    expect(onPick).toHaveBeenCalledWith({ kind: "set", day: 20260918, time: null });
    expect(document.querySelector(".date-picker")).toBeNull();
  });

  it("never opens after a held Escape", () => {
    hold = holdPickerInput(window);
    press("Escape");
    const { onPick, onCancel } = openWith(hold);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
    expect(document.querySelector(".date-picker")).toBeNull();
  });

  it("takes keydown-less text while open", () => {
    hold = holdPickerInput(window);
    openWith(hold);
    const e = insertText("zítra");
    expect(e.defaultPrevented).toBe(true);
    expect(document.querySelector(".dp-text")?.textContent).toBe("zítra");
  });
});
