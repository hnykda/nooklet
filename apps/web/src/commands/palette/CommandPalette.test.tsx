// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePageSource } from "../hosts/page-source.js";
import { createFakeStore } from "../hosts/store.js";
import { CommandProvider, useCommands } from "../provider/CommandProvider.js";
import { type Command, type CommandContext, DEFAULT_WHEN_CONTEXT } from "../types.js";
import { CommandPalette } from "./CommandPalette.js";

afterEach(cleanup);

function baseContext(): Omit<CommandContext, "exec" | "args"> {
  return {
    ...DEFAULT_WHEN_CONTEXT,
    focusedBlockId: null,
    selectedBlockIds: [],
    surface: null,
    store: createFakeStore(),
  };
}

function commands(): Command[] {
  return [
    {
      id: "app.toggleSidebar",
      title: "Toggle sidebar",
      category: "App",
      defaultKeys: {},
      run: vi.fn(),
    },
    {
      id: "app.openSettings",
      title: "Open settings",
      category: "App",
      defaultKeys: {},
      run: vi.fn(),
    },
  ];
}

function Harness(props: { onSelectPage?: (id: string) => void }) {
  const pages = createFakePageSource([{ id: "p1", title: "Recipes", aliases: [], updatedAt: 1 }]);
  return (
    <CommandProvider commands={commands()} platform="mac">
      <Opener />
      <CommandPalette
        pages={pages}
        getContext={baseContext}
        onSelectPage={(p) => props.onSelectPage?.(p.id)}
      />
    </CommandProvider>
  );
}

function Opener() {
  const { palette } = useCommands();
  return (
    <button type="button" data-testid="opener" onClick={() => palette.open("mixed")}>
      open
    </button>
  );
}

describe("<CommandPalette>", () => {
  it("renders nothing while closed", () => {
    render(() => <Harness />);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens and lists commands", async () => {
    render(() => <Harness />);
    fireEvent.click(screen.getByTestId("opener"));
    expect(await screen.findByRole("listbox")).toBeTruthy();
    expect(screen.getByText("Toggle sidebar")).toBeTruthy();
    expect(screen.getByText("Open settings")).toBeTruthy();
  });

  it("filters by typed query", async () => {
    render(() => <Harness />);
    fireEvent.click(screen.getByTestId("opener"));
    const input = await screen.findByRole("combobox");
    fireEvent.input(input, { target: { value: "sidebar" } });
    expect(await screen.findByText("Toggle sidebar")).toBeTruthy();
    expect(screen.queryByText("Open settings")).toBeNull();
  });

  it("Escape closes the palette", async () => {
    render(() => <Harness />);
    fireEvent.click(screen.getByTestId("opener"));
    const input = await screen.findByRole("combobox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Enter runs the highlighted command and closes", async () => {
    const run = vi.fn();
    function HarnessWithSpy() {
      const pages = createFakePageSource([]);
      const cmds: Command[] = [
        { id: "app.toggleSidebar", title: "Toggle sidebar", category: "App", defaultKeys: {}, run },
      ];
      return (
        <CommandProvider commands={cmds} platform="mac">
          <Opener />
          <CommandPalette pages={pages} getContext={baseContext} />
        </CommandProvider>
      );
    }
    render(() => <HarnessWithSpy />);
    fireEvent.click(screen.getByTestId("opener"));
    const input = await screen.findByRole("combobox");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("typing > switches to commands-only mode", async () => {
    render(() => <Harness />);
    fireEvent.click(screen.getByTestId("opener"));
    const input = (await screen.findByRole("combobox")) as HTMLInputElement;
    fireEvent.input(input, { target: { value: ">" } });
    // Mode switch clears the query back to empty.
    expect(input.value).toBe("");
    expect(screen.getByText("Toggle sidebar")).toBeTruthy();
    expect(screen.queryByText("Recipes")).toBeNull();
  });

  // B-105: `nav.openPage`/`nav.revealBlock` need a page/block argument only an agent or a
  // keybinding row supplies; listed, they were rows that did nothing when chosen.
  it("never lists a command that requires arguments, even when the query matches it", async () => {
    const run = vi.fn();
    function HarnessWithArgsOnly() {
      const cmds: Command[] = [
        ...commands(),
        {
          id: "nav.openPage",
          title: "Open page",
          category: "Navigation",
          defaultKeys: {},
          requiresArgs: true,
          run,
        },
      ];
      return (
        <CommandProvider commands={cmds} platform="mac">
          <Opener />
          <CommandPalette pages={createFakePageSource([])} getContext={baseContext} />
        </CommandProvider>
      );
    }
    render(() => <HarnessWithArgsOnly />);
    fireEvent.click(screen.getByTestId("opener"));
    const input = await screen.findByRole("combobox");
    expect(screen.getByText("Toggle sidebar")).toBeTruthy();
    expect(screen.queryByText("Open page")).toBeNull();
    fireEvent.input(input, { target: { value: ">" } });
    fireEvent.input(input, { target: { value: "open page" } });
    expect(screen.queryByText("Open page")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).not.toHaveBeenCalled();
  });

  // B-160: the shelf's keyboard way in from the page switcher, same modifier as Shift+click.
  it("Shift+Enter on a page row shelves it instead of opening it, and says so", async () => {
    const onSelectPage = vi.fn();
    const onShelfPage = vi.fn();
    function HarnessWithShelf() {
      const pages = createFakePageSource([
        { id: "p1", title: "Recipes", aliases: [], updatedAt: 1 },
      ]);
      return (
        <CommandProvider commands={[]} platform="mac">
          <Opener />
          <CommandPalette
            pages={pages}
            getContext={baseContext}
            onSelectPage={(p) => onSelectPage(p.id)}
            onShelfPage={(p) => onShelfPage(p.id)}
          />
        </CommandProvider>
      );
    }
    render(() => <HarnessWithShelf />);
    fireEvent.click(screen.getByTestId("opener"));
    const input = await screen.findByRole("combobox");
    fireEvent.input(input, { target: { value: "Recipes" } });
    await screen.findByText("Recipes");
    expect(screen.getByText(/Shift\+Enter to open on the shelf/)).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(onShelfPage).toHaveBeenCalledWith("p1"));
    expect(onSelectPage).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("selecting a page calls onSelectPage and closes", async () => {
    const onSelectPage = vi.fn();
    render(() => <Harness onSelectPage={onSelectPage} />);
    fireEvent.click(screen.getByTestId("opener"));
    const item = await screen.findByText("Recipes");
    fireEvent.click(item);
    await waitFor(() => expect(onSelectPage).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });
});
