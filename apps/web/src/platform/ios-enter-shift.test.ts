import { describe, expect, it } from "vitest";
import { type EnterShiftFacts, isAutoCapsShift } from "./ios-enter-shift.js";

const soft: EnterShiftFacts = {
  key: "Enter",
  shiftKey: true,
  ios: true,
  softKeyboardOpen: true,
  autocapitalize: "sentences",
};

describe("isAutoCapsShift (B-662)", () => {
  it("drops the shift iOS lights for auto-capitalisation on the soft keyboard's Return", () => {
    expect(isAutoCapsShift(soft)).toBe(true);
    expect(isAutoCapsShift({ ...soft, autocapitalize: "" })).toBe(true); // unset = sentences
  });

  it("keeps a real Shift+Enter: hardware keyboard, no auto-capitalisation, not iOS, not Enter", () => {
    expect(isAutoCapsShift({ ...soft, softKeyboardOpen: false })).toBe(false);
    expect(isAutoCapsShift({ ...soft, autocapitalize: "off" })).toBe(false);
    expect(isAutoCapsShift({ ...soft, autocapitalize: "none" })).toBe(false);
    expect(isAutoCapsShift({ ...soft, ios: false })).toBe(false);
    expect(isAutoCapsShift({ ...soft, key: "Tab" })).toBe(false);
    expect(isAutoCapsShift({ ...soft, shiftKey: false })).toBe(false);
  });
});
