import { describe, expect, it } from "vitest";
import { placeAtCaret } from "./popup-position.js";

// An iPhone 13's 390px width; 500px usable height (the keyboard toolbar's top).
const viewport = { width: 390, height: 500 };
const popup = { width: 240, height: 200 };

describe("placeAtCaret (B-681)", () => {
  it("opens below the caret line when it fits", () => {
    expect(placeAtCaret({ left: 40, top: 100, bottom: 120 }, popup, viewport)).toEqual({
      left: 40,
      top: 120,
      maxHeight: 372,
    });
  });

  it("shifts left so a caret near the right edge keeps the whole popup on screen", () => {
    const at = placeAtCaret({ left: 300, top: 100, bottom: 120 }, popup, viewport);
    expect(at.left).toBe(390 - 240 - 8);
    expect(at.left + popup.width).toBeLessThanOrEqual(390);
  });

  it("flips above the caret line when there is no room below (the keyboard)", () => {
    const at = placeAtCaret({ left: 40, top: 400, bottom: 420 }, popup, viewport);
    expect(at.top).toBe(200);
    expect(at.top + popup.height).toBe(400);
  });

  it("fits on neither side: the roomier one, shortened", () => {
    const tall = { width: 240, height: 280 };
    const at = placeAtCaret({ left: 40, top: 200, bottom: 220 }, tall, { width: 390, height: 400 });
    // 172 below, 192 above → above, 192 high, ending at the caret line's top.
    expect(at).toEqual({ left: 40, top: 8, maxHeight: 192 });
  });
});
