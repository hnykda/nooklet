// @vitest-environment jsdom
/**
 * The top bar's "⋯" menu (B-541 follow-up): every item runs a registered command, and the menu
 * lists only commands that are registered and whose `when` holds — that is how Graph disappears on
 * Capacitor (B-578) and Keyboard shortcuts on a touch device (B-564) without the menu knowing.
 * `detectPlatformFromEnvironment` is mocked the way `HelpMenu.test.tsx` does it.
 */
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakeDetect = vi.hoisted(() => ({ mobile: false }));
vi.mock("../commands/keymap/platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/keymap/platform.js")>();
  return { ...actual, detectPlatformFromEnvironment: () => ({ platform: "mac", ...fakeDetect }) };
});

import { CommandProvider } from "../commands/provider/CommandProvider.js";
import type { Command } from "../commands/types.js";
import { MoreMenu } from "./MoreMenu.js";

afterEach(() => {
  cleanup();
  fakeDetect.mobile = false;
});

const ALL = [
  ["app.openSettings", "true"],
  ["nav.allPages", "true"],
  ["nav.graph", "true"],
  ["nav.trash", "true"],
  ["app.showShortcuts", "!mobile"],
  ["app.openDiagnostics", "true"],
] as const;

function setup(omit: string[] = []): string[] {
  const ran: string[] = [];
  const commands: Command[] = ALL.filter(([id]) => !omit.includes(id)).map(([id, when]) => ({
    id,
    title: id,
    category: "App",
    defaultKeys: id === "app.openSettings" ? { mac: "Cmd+," } : {},
    when,
    run() {
      ran.push(id);
    },
  }));
  render(() => (
    <CommandProvider commands={commands} platform="mac">
      <MoreMenu />
    </CommandProvider>
  ));
  return ran;
}

const labels = (): string[] =>
  screen
    .queryAllByRole("menuitem")
    .map((el) => el.querySelector(".more-menu-label")?.textContent ?? "");

describe("MoreMenu", () => {
  it("lists the six destinations in order, closed until the button is pressed", () => {
    setup();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(labels()).toEqual([
      "Settings",
      "All pages",
      "Graph",
      "Trash",
      "Keyboard shortcuts",
      "Diagnostics",
    ]);
    // The bound key is shown beside its item.
    expect(screen.getByRole("menuitem", { name: /Settings/ }).textContent).toContain("Cmd+,");
  });

  it("each item runs its command and closes the menu", () => {
    const ran = setup();
    for (const [id] of ALL) {
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      const index = ALL.findIndex(([c]) => c === id);
      const item = screen.getAllByRole("menuitem")[index];
      if (!item) throw new Error(`no item for ${id}`);
      fireEvent.click(item);
      expect(screen.queryByRole("menu")).toBeNull();
    }
    // `exec` is async; the runs are recorded synchronously before its first await resolves.
    expect(ran).toEqual(ALL.map(([id]) => id));
  });

  it("hides an item whose command is not registered (Graph on Capacitor, B-578)", () => {
    setup(["nav.graph"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(labels()).not.toContain("Graph");
    expect(labels()).toContain("Trash");
  });

  it("hides Keyboard shortcuts on a touch device, via the command's `when` (B-564)", () => {
    fakeDetect.mobile = true;
    setup();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(labels()).not.toContain("Keyboard shortcuts");
    expect(labels()).toContain("Diagnostics");
  });

  it("closes on Escape and on a press outside it", () => {
    setup();
    const button = screen.getByRole("button", { name: "More" });
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
