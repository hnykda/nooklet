import { describe, expect, it } from "vitest";
import { deriveBadgeState } from "./badge-state.js";

describe("deriveBadgeState (ADR 015 §2.6's three badge states)", () => {
  it("off: not connected, regardless of the control toggle", () => {
    expect(deriveBadgeState({ connected: false, controlEnabled: false })).toBe("off");
    expect(deriveBadgeState({ connected: false, controlEnabled: true })).toBe("off");
  });

  it("observed: connected, control disabled", () => {
    expect(deriveBadgeState({ connected: true, controlEnabled: false })).toBe("observed");
  });

  it("controlled: connected, control enabled", () => {
    expect(deriveBadgeState({ connected: true, controlEnabled: true })).toBe("controlled");
  });
});
