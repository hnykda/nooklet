import { describe, expect, it } from "vitest";
import { computeKeyboardInset } from "./keyboard.js";

describe("computeKeyboardInset", () => {
  it("returns 0 when the viewport is unchanged", () => {
    expect(computeKeyboardInset(800, 800, 0)).toBe(0);
  });

  it("reports the keyboard height once it clears the dead band", () => {
    // 800px tall screen, keyboard covers 300px -> visualViewport.height shrinks to 500.
    expect(computeKeyboardInset(800, 500, 0)).toBe(300);
  });

  it("absorbs small deltas under the 80px dead band (URL-bar collapse)", () => {
    expect(computeKeyboardInset(800, 750, 0)).toBe(0); // 50px delta
    expect(computeKeyboardInset(800, 721, 0)).toBe(0); // 79px delta, just under the band
  });

  it("treats exactly 80px as a real keyboard (band is exclusive)", () => {
    expect(computeKeyboardInset(800, 720, 0)).toBe(80);
  });

  it("absorbs the iOS 26 ~24px post-dismiss residue", () => {
    expect(computeKeyboardInset(800, 776, 0)).toBe(0);
  });

  it("subtracts visualViewport.offsetTop (page scrolled to reveal the focused field)", () => {
    // Keyboard covers 300px, but the visual viewport is also offset 40px from the top.
    expect(computeKeyboardInset(800, 500, 40)).toBe(260);
  });

  it("never goes negative when offsetTop alone exceeds the raw delta", () => {
    expect(computeKeyboardInset(800, 800, 40)).toBe(0);
  });

  it("rounds fractional device-pixel-ratio deltas", () => {
    expect(computeKeyboardInset(800, 500.4, 0)).toBe(300); // 299.6 rounds to 300
    expect(computeKeyboardInset(800, 500.6, 0)).toBe(299);
  });
});
