// @vitest-environment jsdom
/**
 * The consent badge as an icon (B-540): the state sentence moved from the button's text into its
 * accessible name and tooltip, and a click still opens the toggles. ADR 015 §6 makes this a consent
 * signal, so losing the name or the popover would be a regression, not a cosmetic change.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { BADGE_LABEL } from "./badge-state.js";
import { ConsentBadge } from "./ConsentBadge.js";
import { setLiveConnected } from "./connection-state.js";
import { liveConsent } from "./consent.js";

afterEach(() => {
  cleanup();
  setLiveConnected(false);
  liveConsent.setControlEnabled(false);
});

describe("ConsentBadge", () => {
  it("names its state in the accessible name and tooltip, with no visible text", () => {
    render(() => <ConsentBadge />);
    const button = screen.getByRole("button", { name: BADGE_LABEL.off });
    expect(button.getAttribute("title")).toBe(BADGE_LABEL.off);
    expect(button.getAttribute("data-state")).toBe("off");
    expect(button.textContent).toBe("");

    setLiveConnected(true);
    expect(button.getAttribute("aria-label")).toBe("Agents can see this window");
    expect(button.getAttribute("data-state")).toBe("observed");

    liveConsent.setControlEnabled(true);
    expect(button.getAttribute("aria-label")).toBe("Agents can see and control this window");
    expect(button.getAttribute("data-state")).toBe("controlled");
  });

  it("opens the agent-access toggles on click, as the pill did", () => {
    render(() => <ConsentBadge />);
    const button = screen.getByRole("button", { name: BADGE_LABEL.off });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "Agent access to this window" });
    expect(dialog.textContent).toContain("Let agents control this window");
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
