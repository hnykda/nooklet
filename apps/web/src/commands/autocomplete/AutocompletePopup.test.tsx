// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeEditorHost } from "../hosts/editor-host.js";
import { createFakeBlockSource, createFakePageSource } from "../hosts/page-source.js";
import { CommandProvider } from "../provider/CommandProvider.js";
import { AutocompletePopup } from "./AutocompletePopup.js";

afterEach(cleanup);

describe("<AutocompletePopup> — page variant (R56)", () => {
  it("renders nothing when trigger is null", () => {
    const editor = createFakeEditorHost();
    const pages = createFakePageSource([]);
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={null}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("lists matching pages and appends a Create item when nothing matches exactly", async () => {
    const editor = createFakeEditorHost({ content: "[[Rec", start: 5, end: 5 });
    const pages = createFakePageSource([{ id: "p1", title: "Recipes", aliases: [], updatedAt: 1 }]);
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 0, query: "Rec" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    expect(await screen.findByText("Recipes")).toBeTruthy();
    expect(screen.getByText('New page "Rec"')).toBeTruthy();
  });

  it("does not show Create when a page matches exactly (case-insensitive)", async () => {
    const editor = createFakeEditorHost({ content: "[[Recipes", start: 9, end: 9 });
    const pages = createFakePageSource([{ id: "p1", title: "Recipes", aliases: [], updatedAt: 1 }]);
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 0, query: "recipes" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    await screen.findByText("Recipes");
    expect(screen.queryByText(/Create/)).toBeNull();
  });

  it("selecting a page replaces the query span with <title>]] and dismisses", async () => {
    const editor = createFakeEditorHost({ content: "[[Rec", start: 5, end: 5 });
    const pages = createFakePageSource([{ id: "p1", title: "Recipes", aliases: [], updatedAt: 1 }]);
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 0, query: "Rec" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    fireEvent.click(await screen.findByText("Recipes"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(editor.state?.content).toBe("[[Recipes]]");
  });

  it("Escape dismisses without inserting", async () => {
    const editor = createFakeEditorHost({ content: "[[Rec", start: 5, end: 5 });
    const pages = createFakePageSource([{ id: "p1", title: "Recipes", aliases: [], updatedAt: 1 }]);
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 0, query: "Rec" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    await screen.findByRole("listbox");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(editor.state?.content).toBe("[[Rec");
  });
});

describe("<AutocompletePopup> — tag variant (R57)", () => {
  it("lists every page matching the query — a tag is a page (ADR 017, B-69)", async () => {
    const editor = createFakeEditorHost({ content: "#pro", start: 4, end: 4 });
    const pages = createFakePageSource([
      { id: "t1", title: "project", aliases: [], updatedAt: 1 },
      { id: "p1", title: "projector-notes", aliases: [], updatedAt: 1 },
    ]);
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="tag"
          editor={editor}
          trigger={{ from: 0, query: "pro" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    expect(await screen.findByText("project")).toBeTruthy();
    // The old contract filtered on an `isTag` flag that nothing ever set, so `#` offered only
    // "New page" for pages already in use as tags. Every page is a candidate now.
    expect(await screen.findByText("projector-notes")).toBeTruthy();
  });
});

describe("<AutocompletePopup> — block variant (R58)", () => {
  it("has no Create affordance and inserts ((id))", async () => {
    const editor = createFakeEditorHost({ content: "((snip", start: 6, end: 6 });
    const blocks = createFakeBlockSource([
      { id: "blk123", snippet: "a snippet of text", pageTitle: "Notes" },
    ]);
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="block"
          editor={editor}
          trigger={{ from: 0, query: "snip" }}
          position={{ top: 0, left: 0 }}
          blocks={blocks}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    expect(await screen.findByText("a snippet of text")).toBeTruthy();
    expect(screen.queryByText(/Create/)).toBeNull();
    fireEvent.click(screen.getByText("a snippet of text"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(editor.state?.content).toBe("((blk123))");
  });
});
