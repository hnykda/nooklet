// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeStore } from "../hosts/store.js";
import { CommandProvider } from "../provider/CommandProvider.js";
import { type Command, type CommandContext, DEFAULT_WHEN_CONTEXT } from "../types.js";
import { MobileKeyboardToolbar, TOOLBAR_BUTTONS } from "./MobileToolbar.js";

afterEach(cleanup);

function ctx(overrides: Partial<CommandContext>): Omit<CommandContext, "exec" | "args"> {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    focusedBlockId: "b1",
    selectedBlockIds: [],
    surface: null,
    store: createFakeStore(),
    ...overrides,
  };
}

function commands(run: (id: string) => void): Command[] {
  return TOOLBAR_BUTTONS.map((b) => ({
    id: b.command,
    title: b.command,
    category: "Block",
    defaultKeys: {},
    when: b.command === "task.toggleDone" ? "isTask" : undefined,
    run: () => run(b.command),
  }));
}

describe("<MobileKeyboardToolbar>", () => {
  it("is hidden when not mobile", () => {
    render(() => (
      <CommandProvider commands={commands(() => {})} platform="mac">
        <MobileKeyboardToolbar getContext={() => ctx({ mobile: false, editorFocused: true })} />
      </CommandProvider>
    ));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("is hidden when mobile but not editorFocused", () => {
    render(() => (
      <CommandProvider commands={commands(() => {})} platform="mac">
        <MobileKeyboardToolbar getContext={() => ctx({ mobile: true, editorFocused: false })} />
      </CommandProvider>
    ));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows all 12 buttons in R60's fixed order when mobile && editorFocused", () => {
    render(() => (
      <CommandProvider commands={commands(() => {})} platform="mac">
        <MobileKeyboardToolbar getContext={() => ctx({ mobile: true, editorFocused: true })} />
      </CommandProvider>
    ));
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(12);
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(
      TOOLBAR_BUTTONS.map((b) => b.command),
    );
  });

  it("disables a button whose `when` is false for the current context", () => {
    render(() => (
      <CommandProvider commands={commands(() => {})} platform="mac">
        <MobileKeyboardToolbar
          getContext={() => ctx({ mobile: true, editorFocused: true, isTask: false })}
        />
      </CommandProvider>
    ));
    const toggleDone = screen.getByLabelText("task.toggleDone");
    expect(toggleDone.hasAttribute("disabled")).toBe(true);
  });

  it("enables a button whose `when` is true", () => {
    render(() => (
      <CommandProvider commands={commands(() => {})} platform="mac">
        <MobileKeyboardToolbar
          getContext={() => ctx({ mobile: true, editorFocused: true, isTask: true })}
        />
      </CommandProvider>
    ));
    const toggleDone = screen.getByLabelText("task.toggleDone");
    expect(toggleDone.hasAttribute("disabled")).toBe(false);
  });

  it("tapping a button runs its command", async () => {
    const run = vi.fn();
    render(() => (
      <CommandProvider commands={commands(run)} platform="mac">
        <MobileKeyboardToolbar getContext={() => ctx({ mobile: true, editorFocused: true })} />
      </CommandProvider>
    ));
    fireEvent.click(screen.getByLabelText("block.indent"));
    await waitFor(() => expect(run).toHaveBeenCalledWith("block.indent"));
  });

  it("preventDefault is called on pointerdown so focus never leaves the surface", () => {
    render(() => (
      <CommandProvider commands={commands(() => {})} platform="mac">
        <MobileKeyboardToolbar getContext={() => ctx({ mobile: true, editorFocused: true })} />
      </CommandProvider>
    ));
    const button = screen.getByLabelText("block.indent");
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("every button meets the >=44px touch target minimum (via the shared stylesheet class)", () => {
    render(() => (
      <CommandProvider commands={commands(() => {})} platform="mac">
        <MobileKeyboardToolbar getContext={() => ctx({ mobile: true, editorFocused: true })} />
      </CommandProvider>
    ));
    for (const button of screen.getAllByRole("button")) {
      expect(button.classList.contains("cmd-toolbar-button")).toBe(true);
    }
  });
});
