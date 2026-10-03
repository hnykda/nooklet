// @vitest-environment jsdom
/**
 * B-564: the keyboard-shortcuts item/dialog should not appear on a touch-primary device with no
 * keyboard to press anything on. `detectPlatformFromEnvironment` is mocked directly (not via
 * `<CommandProvider platform="...">`, which only controls keymap building, not this component's
 * own `mobile` check) — mirrors `ConnectView.test.tsx`'s `fakePlatform` pattern.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakeDetect = vi.hoisted(() => ({ mobile: false }));
vi.mock("../commands/keymap/platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/keymap/platform.js")>();
  return { ...actual, detectPlatformFromEnvironment: () => ({ platform: "mac", ...fakeDetect }) };
});

import { CommandProvider } from "../commands/provider/CommandProvider.js";
import { HelpMenu } from "./HelpMenu.js";

afterEach(() => {
  cleanup();
  fakeDetect.mobile = false;
});

function renderMenu(): void {
  render(() => (
    <CommandProvider commands={[]} platform="mac">
      <HelpMenu />
    </CommandProvider>
  ));
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
}

describe("HelpMenu: B-564 keyboard shortcuts hidden on mobile", () => {
  it("desktop: lists 'Keyboard shortcuts'", () => {
    fakeDetect.mobile = false;
    renderMenu();
    expect(screen.getByRole("button", { name: /Keyboard shortcuts/ })).toBeTruthy();
  });

  it("mobile: no 'Keyboard shortcuts' item", () => {
    fakeDetect.mobile = true;
    renderMenu();
    expect(screen.queryByRole("button", { name: /Keyboard shortcuts/ })).toBeNull();
  });
});
