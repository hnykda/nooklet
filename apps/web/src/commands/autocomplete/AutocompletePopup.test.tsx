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

  it("a pick with the caret inside a complete link replaces the whole link (B-294)", async () => {
    // `alpha [[Rec|ipes]] omega`: the caret was walked into an existing link.
    const editor = createFakeEditorHost({ content: "alpha [[Recipes]] omega", start: 11, end: 11 });
    const pages = createFakePageSource([{ id: "p1", title: "Recipes", aliases: [], updatedAt: 1 }]);
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 6, query: "Rec" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    fireEvent.click(await screen.findByText("Recipes"));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(editor.state?.content).toBe("alpha [[Recipes]] omega");
    // After the link's own `]]`, not inside its old tail.
    expect(editor.state?.start).toBe("alpha [[Recipes]]".length);
  });

  it("New page with the caret inside a complete link names the whole link, not the text before the caret (B-382)", async () => {
    // `alpha [[Walkin Unm|ade Page]] omega`, and no such page.
    const editor = createFakeEditorHost({
      content: "alpha [[Walkin Unmade Page]] omega",
      start: 18,
      end: 18,
    });
    const pages = createFakePageSource([]);
    const createPage = vi.fn((_title: string) => new Promise<never>(() => {}));
    pages.createPage = createPage;
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 6, query: "Walkin Unm" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    await screen.findByText('New page "Walkin Unmade Page"');
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(editor.state?.content).toBe("alpha [[Walkin Unmade Page]] omega");
    expect(editor.state?.start).toBe("alpha [[Walkin Unmade Page]]".length);
    expect(createPage).toHaveBeenCalledWith("Walkin Unmade Page");
  });

  it("offers no New page inside a complete link whose whole name is an existing page (B-382)", async () => {
    // Walked into `[[Recipes]]` with the page list loaded: "Rec" is not an exact title, but the
    // link's name is, so creating "Rec" (or a second "Recipes") is not offered.
    const editor = createFakeEditorHost({ content: "[[Recipes]]", start: 5, end: 5 });
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
    await screen.findByText("Recipes");
    expect(screen.queryByText(/New page/)).toBeNull();
  });

  // B-384: on a walk-in the query is only the fragment before the caret, so ranked by it a shorter
  // name (or, with nothing before the caret, today's date) came first and Enter re-pointed the link.
  it("inside a complete link, the link's own page is the active row, ahead of a shorter name (B-384)", async () => {
    // `met [[Jan| Novak]] today`.
    const editor = createFakeEditorHost({ content: "met [[Jan Novak]] today", start: 9, end: 9 });
    const pages = createFakePageSource([
      { id: "p1", title: "Jan", aliases: [], updatedAt: 3 },
      { id: "p2", title: "Janitor", aliases: [], updatedAt: 2 },
      { id: "p3", title: "Jan Novak", aliases: [], updatedAt: 1 },
    ]);
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 4, query: "Jan" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    await screen.findByText("Janitor");
    expect(screen.getAllByRole("option")[0]?.textContent).toBe("Jan Novak");
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(editor.state?.content).toBe("met [[Jan Novak]] today");
  });

  it("inside a complete link with nothing before the caret, the link's page comes before the dates (B-384)", async () => {
    // `met [[|Jan Novak]] today`.
    const editor = createFakeEditorHost({ content: "met [[Jan Novak]] today", start: 6, end: 6 });
    const pages = createFakePageSource([
      { id: "p1", title: "Jan", aliases: [], updatedAt: 2 },
      { id: "p3", title: "Jan Novak", aliases: [], updatedAt: 1 },
    ]);
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 4, query: "" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    await screen.findByText("Jan");
    expect(screen.getAllByRole("option")[0]?.textContent).toBe("Jan Novak");
    expect(screen.getAllByRole("option").filter((o) => o.textContent === "Jan Novak")).toHaveLength(
      1,
    );
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
    expect(editor.state?.content).toBe("met [[Jan Novak]] today");
  });

  it("inside a complete link to no page, with nothing before the caret, New page for the whole link comes first (B-384)", async () => {
    const editor = createFakeEditorHost({ content: "met [[Nobody Yet]] today", start: 6, end: 6 });
    const pages = createFakePageSource([{ id: "p1", title: "Jan", aliases: [], updatedAt: 1 }]);
    const createPage = vi.fn((_title: string) => new Promise<never>(() => {}));
    pages.createPage = createPage;
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 4, query: "" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    await screen.findByText("Jan");
    expect(screen.getAllByRole("option")[0]?.textContent).toBe('New page "Nobody Yet"');
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(editor.state?.content).toBe("met [[Nobody Yet]] today");
    expect(createPage).toHaveBeenCalledWith("Nobody Yet");
  });

  it("with a query typed inside a link to no page, ranking still decides the active row (B-384)", async () => {
    // `[[Walkin Oth|Goal Page]]`: retargeting by typing inside the name must still pick the match.
    const editor = createFakeEditorHost({ content: "[[Walkin OthGoal Page]]", start: 12, end: 12 });
    const pages = createFakePageSource([
      { id: "p1", title: "Walkin Other Page", aliases: [], updatedAt: 1 },
    ]);
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 0, query: "Walkin Oth" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={() => {}}
        />
      </CommandProvider>
    ));
    await screen.findByText("Walkin Other Page");
    expect(screen.getAllByRole("option")[0]?.textContent).toBe("Walkin Other Page");
  });

  it("New page links and dismisses at once, without waiting for the page to be created (B-244)", async () => {
    const editor = createFakeEditorHost({ content: "[[new/page", start: 10, end: 10 });
    const pages = createFakePageSource([]);
    // A replica too busy to answer: the create never resolves during this test.
    const createPage = vi.fn((_title: string) => new Promise<never>(() => {}));
    pages.createPage = createPage;
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="page"
          editor={editor}
          trigger={{ from: 0, query: "new/page" }}
          position={{ top: 0, left: 0 }}
          pages={pages}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    await screen.findByText('New page "new/page"');
    // Enter on the listbox rather than a click on the row: the row re-renders when the page list
    // resolves, and a click on the stale node would reach nothing.
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    // Synchronously, not after `waitFor`: nothing may sit between the key and the link.
    expect(editor.state?.content).toBe("[[new/page]]");
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(createPage).toHaveBeenCalledWith("new/page");
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
  it("inside a complete ((ref)) offers nothing, so Enter leaves the ref alone (B-384)", async () => {
    // `see ((blk|123)) end`: the query is a fragment of an id, which only matches blocks whose text
    // contains that id — the edited block itself first.
    const editor = createFakeEditorHost({ content: "see ((blk123)) end", start: 9, end: 9 });
    const blocks = createFakeBlockSource([
      { id: "self01", snippet: "see ((blk123)) end", pageTitle: "Notes" },
    ]);
    const onDismiss = vi.fn();
    render(() => (
      <CommandProvider commands={[]} platform="mac">
        <AutocompletePopup
          variant="block"
          editor={editor}
          trigger={{ from: 4, query: "blk" }}
          position={{ top: 0, left: 0 }}
          blocks={blocks}
          onDismiss={onDismiss}
        />
      </CommandProvider>
    ));
    // "No results" also shows while the search is still loading: let it settle first.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("see ((blk123)) end")).toBeNull();
    expect(screen.getByText("No results")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(editor.state?.content).toBe("see ((blk123)) end");
    expect(onDismiss).not.toHaveBeenCalled();
  });

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
