// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeStore } from "../hosts/store.js";
import { CommandProvider } from "../provider/CommandProvider.js";
import { type Command, type CommandContext, DEFAULT_WHEN_CONTEXT } from "../types.js";
import { SlashMenu } from "./SlashMenu.js";

afterEach(cleanup);

function baseContext(): Omit<CommandContext, "exec" | "args"> {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    editorFocused: true,
    focusedBlockId: "b1",
    selectedBlockIds: [],
    surface: null,
    store: createFakeStore(),
  };
}

describe("<SlashMenu>", () => {
  it("renders nothing when trigger is null", () => {
    const editor = createFakeEditorHost({ content: "/", start: 1, end: 1 });
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <SlashMenu
          editor={editor}
          trigger={null}
          position={{ top: 0, left: 0 }}
          getContext={baseContext}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the default item order for an empty query", () => {
    const editor = createFakeEditorHost({ content: "/", start: 1, end: 1 });
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <SlashMenu
          editor={editor}
          trigger={{ from: 0, query: "" }}
          position={{ top: 0, left: 0 }}
          getContext={baseContext}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    const options = screen.getAllByRole("option");
    expect(options[0]?.textContent).toBe("TODO / task");
    expect(options).toHaveLength(15);
  });

  it("filters items by query", () => {
    const editor = createFakeEditorHost({ content: "/tab", start: 4, end: 4 });
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <SlashMenu
          editor={editor}
          trigger={{ from: 0, query: "tab" }}
          position={{ top: 0, left: 0 }}
          getContext={baseContext}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    expect(screen.getByText("Table")).toBeTruthy();
    expect(screen.queryByText("TODO / task")).toBeNull();
  });

  it("selecting an item removes the trigger text and execs the command", async () => {
    const editor = createFakeEditorHost({ content: "/tab", start: 4, end: 4 });
    const run = vi.fn();
    const commands: Command[] = [
      { id: "block.insertTable", title: "Table", category: "Insert", defaultKeys: {}, run },
    ];
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={commands} platform="mac">
        <SlashMenu
          editor={editor}
          trigger={{ from: 0, query: "tab" }}
          position={{ top: 0, left: 0 }}
          getContext={baseContext}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    fireEvent.click(screen.getByText("Table"));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(editor.state?.content).toBe(""); // "/tab" removed before the command ran
    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
  });

  it("Escape calls onDismiss without running anything", () => {
    const editor = createFakeEditorHost({ content: "/", start: 1, end: 1 });
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <SlashMenu
          editor={editor}
          trigger={{ from: 0, query: "" }}
          position={{ top: 0, left: 0 }}
          getContext={baseContext}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("Arrow keys clamp without wraparound", () => {
    const editor = createFakeEditorHost({ content: "/", start: 1, end: 1 });
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <SlashMenu
          editor={editor}
          trigger={{ from: 0, query: "" }}
          position={{ top: 0, left: 0 }}
          getContext={baseContext}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    const listbox = screen.getByRole("listbox");
    fireEvent.keyDown(listbox, { key: "ArrowUp" }); // already at 0, should stay
    const options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
  });
});
