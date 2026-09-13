import { describe, expect, it } from "vitest";
import { placeMenu } from "./menu-placement.js";

// The sizes QA measured on the real graph (B-351): a ~511px menu in a 1400x900 window and on a
// 390x844 phone.
const MENU = { width: 208, height: 511 };
const DESK = { width: 1400, height: 900 };
const PHONE = { width: 390, height: 844 };

describe("placeMenu", () => {
  it("opens downward from the pointer when the menu fits below it", () => {
    expect(placeMenu({ x: 300, y: 270 }, MENU, DESK)).toMatchObject({ left: 300, top: 270 });
  });

  it("flips upward when it does not fit below but does above", () => {
    // The QA case: a right-click at y=740 put the bottom at 1091.
    expect(placeMenu({ x: 300, y: 740 }, MENU, DESK)).toMatchObject({ left: 300, top: 229 });
  });

  it("pins to the bottom margin when it fits neither below nor above the pointer", () => {
    // The phone case: a long-press at y=490 — 511px fits neither under nor over it.
    const { top } = placeMenu({ x: 100, y: 490 }, MENU, PHONE);
    expect(top).toBe(844 - 511 - 8);
    expect(top + MENU.height).toBeLessThanOrEqual(PHONE.height);
  });

  it("pins to the top margin when the menu is taller than the viewport, capped so it scrolls", () => {
    expect(placeMenu({ x: 10, y: 200 }, MENU, { width: 800, height: 400 })).toMatchObject({
      top: 8,
      maxHeight: 384,
    });
  });

  it("treats a shorter usable height (the phone's keyboard toolbar) as the bottom edge", () => {
    // The real-graph phone case after the first fix: a 542px menu pinned to the window's bottom
    // still had "Move to page…" and the footer under the 44px toolbar starting at y=799.
    const { top } = placeMenu(
      { x: 100, y: 486 },
      { width: 208, height: 542 },
      { width: 390, height: 799 },
    );
    expect(top + 542).toBeLessThanOrEqual(799 - 8);
  });

  it("shifts left so the right edge stays on screen", () => {
    expect(placeMenu({ x: 350, y: 100 }, MENU, PHONE).left).toBe(390 - 208 - 8);
  });

  it("never places the menu left of the margin, even on a screen narrower than the menu", () => {
    expect(placeMenu({ x: 50, y: 100 }, MENU, { width: 200, height: 844 }).left).toBe(8);
  });

  it("keeps the whole menu inside the viewport for every pointer position", () => {
    for (let y = 0; y <= PHONE.height; y += 17) {
      for (let x = 0; x <= PHONE.width; x += 13) {
        const p = placeMenu({ x, y }, MENU, PHONE);
        expect(p.top).toBeGreaterThanOrEqual(8);
        expect(p.top + MENU.height).toBeLessThanOrEqual(PHONE.height - 8);
        expect(p.left + MENU.width).toBeLessThanOrEqual(PHONE.width - 8);
      }
    }
  });
});
