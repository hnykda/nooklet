// @vitest-environment jsdom
/**
 * B-595: a journal day with no page opens as the journal stream's draft, not as "doesn't exist
 * yet / Create"; an ordinary missing page keeps the missing view. The draft and the tree are
 * stubs — `VirtualJournalDay.test.tsx` covers what the draft writes, `e2e/tests/empty-journal-
 * page.spec.ts` the whole thing against a real server.
 */
import { isoJournalName, type PageRow, parseJournalTitle } from "@nooklet/core";
import { Route, Router } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { type Accessor, createResource, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageView } from "./PageView.js";

/** What the replica has, by route name; a signal so a test can make a page appear. */
const [pages, setPages] = createSignal<Record<string, PageRow>>({});

vi.mock("../data/store.js", () => ({
  applyOp: vi.fn(async () => {}),
  usePageByName: (name: Accessor<string>) => {
    const [r] = createResource(
      () => ({ n: name(), all: pages() }),
      async ({ n, all }) => all[n] ?? null,
    );
    return r;
  },
  usePageProperties: () => Object.assign(() => ({}), { loading: false, error: undefined }),
}));
vi.mock("../data/agenda.js", () => ({
  useAgendaTasks: () => Object.assign(() => [], { loading: false, error: undefined }),
}));
vi.mock("./JournalAgenda.js", () => ({ JournalAgenda: () => null }));
vi.mock("./ReferencesPanel.js", () => ({
  ReferencesPanel: (p: { target: string }) => <div data-testid="refs">refs:{p.target}</div>,
}));
vi.mock("./NamespaceChildren.js", () => ({ NamespaceChildren: () => null }));
vi.mock("./PageActions.js", () => ({ PageActions: () => null }));
vi.mock("./PageIcon.js", () => ({ PageIconEditor: () => null }));
vi.mock("./PageProperties.js", () => ({ PageProperties: () => null }));
vi.mock("./canonicalPageRoute.js", () => ({ useCanonicalPageRoute: () => {} }));
vi.mock("./PageFindBar.js", () => ({
  usePageFind: () => ({ Bar: () => null, filter: () => undefined, onMatches: () => {} }),
}));

let treeMounts = 0;
vi.mock("../editor/BlockTree.js", () => ({
  BlockTree: (p: { pageId: string }) => {
    treeMounts++;
    return <div data-testid="block-tree">tree:{p.pageId}</div>;
  },
}));

let draftMounts = 0;
/** The real draft writes the page and then renders the day's tree itself; the stub just says so. */
vi.mock("./VirtualJournalDay.js", () => ({
  VirtualJournalDay: (p: { day: number; onStarted?: (s: boolean) => void }) => {
    draftMounts++;
    return (
      <button type="button" data-testid="draft" onClick={() => p.onStarted?.(true)}>
        draft:{p.day}
      </button>
    );
  },
}));

afterEach(() => {
  cleanup();
  setPages({});
  treeMounts = 0;
  draftMounts = 0;
});

const DAY = isoJournalName(parseJournalTitle("2026-10-05") as number);

function journalPage(name: string): PageRow {
  return {
    id: `page-${name}`,
    name,
    journalDay: parseJournalTitle(name),
  } as PageRow;
}

function renderAt(name: Accessor<string>) {
  return render(() => (
    <Router>
      <Route path="*" component={() => <PageView name={name} />} />
    </Router>
  ));
}

describe("PageView — a page with no page row (B-595)", () => {
  it("opens a journal day with no page as the journal draft, not 'doesn't exist yet'", async () => {
    renderAt(() => DAY);
    expect((await screen.findByTestId("draft")).textContent).toBe(
      `draft:${parseJournalTitle(DAY)}`,
    );
    expect(document.body.textContent).not.toContain("doesn't exist yet");
    expect(document.querySelector(".page-view-missing")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Oct 5th, 2026");
    expect(screen.getByTestId("refs").textContent).toBe(`refs:${DAY}`);
  });

  it("keeps the 'doesn't exist yet' view for an ordinary page", async () => {
    renderAt(() => "Nowhere Page");
    expect(await screen.findByText("This page doesn't exist yet.")).toBeTruthy();
    expect(screen.queryByTestId("draft")).toBeNull();
  });

  it("keeps the draft (and the tree it renders) once it has written the day", async () => {
    renderAt(() => DAY);
    fireEvent.click(await screen.findByTestId("draft"));
    // Not even MOVED: moving a node blurs the editor inside it. As a bare fragment, the header
    // growing from one node to several reinserted the draft's node, and the caret was gone right
    // after Enter in Chromium (e2e/tests/empty-journal-page.spec.ts).
    const moved: string[] = [];
    new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.removedNodes)
          if (n instanceof Element && n.querySelector('[data-testid="draft"]'))
            moved.push(n.className);
    }).observe(document.body, { childList: true, subtree: true });
    setPages({ [DAY]: journalPage(DAY) });
    // Let the lookup settle on the new page.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    expect(screen.getByTestId("draft")).toBeTruthy();
    expect(draftMounts).toBe(1);
    expect(treeMounts).toBe(0);
    // The page branch did render meanwhile (its references panel replaced the missing one's).
    expect(screen.getByTestId("refs").textContent).toBe(`refs:${DAY}`);
    expect(moved).toEqual([]);
  });

  it("an existing journal day opens its own tree, and a started day does not leak onto it", async () => {
    const [name, setName] = createSignal(DAY);
    renderAt(name);
    fireEvent.click(await screen.findByTestId("draft"));
    setPages({ [DAY]: journalPage(DAY) });
    await new Promise((r) => setTimeout(r, 0));
    // Away and back: the day now has a page, so it is the normal tree — a fresh draft there
    // would create a second page for the day.
    setName("Elsewhere");
    await screen.findByText("This page doesn't exist yet.");
    setName(DAY);
    expect((await screen.findByTestId("block-tree")).textContent).toBe(`tree:page-${DAY}`);
    expect(screen.queryByTestId("draft")).toBeNull();
  });
});
