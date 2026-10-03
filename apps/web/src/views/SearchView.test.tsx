// @vitest-environment jsdom
import { Route, Router } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CallOpOptions,
  SearchFallback,
  SearchHit,
  SearchInput,
  SearchResult,
} from "../data/api-client.js";

const AURORA: SearchHit = {
  kind: "block",
  id: "b1",
  page: "Projects/Aurora",
  snippet: "Vendor **pricing** not confirmed",
  breadcrumb: ["Launch checklist", "Open risks"],
  score: 0.9,
  updatedAt: "2026-09-09T00:00:00.000Z",
};
const IDEAS: SearchHit = {
  kind: "block",
  id: "b2",
  page: "Ideas",
  snippet: "what things cost",
  breadcrumb: [],
  score: 0.5,
  updatedAt: "2026-09-09T00:00:00.000Z",
};

// The edges of local-first search (server-search): the device's FTS (`local-search.ts`), the
// server's `search` (`apiClient`), whether there is a server at all (`bootstrap.ts`) and the sync
// state (`store.ts`). `search-session.ts` and `search-enrich.ts` run for real.
const edge = vi.hoisted(() => ({
  hasServer: true,
  syncState: "idle" as string,
  /** Hits the replica does not hold (`presenceOnDevice` leaves them out). */
  absent: new Set<string>(),
  deleted: new Set<string>(),
}));
let lastInput: SearchInput | undefined;
/** When set, the fake server answers every search with a keyword fallback and this. */
let serverFallback: SearchFallback | undefined;
/** What the fake server's semantic search finds; the device always finds `AURORA`. */
let serverHits: SearchHit[] = [AURORA];

const localFn = vi.fn(async (input: SearchInput): Promise<SearchResult> => {
  lastInput = input;
  return { hits: [AURORA], modeUsed: "keyword" };
});
const searchFn = vi.fn(
  async (input: SearchInput, _opts?: CallOpOptions): Promise<SearchResult> =>
    serverFallback
      ? { hits: [], modeUsed: "keyword", fallback: serverFallback }
      : { hits: serverHits, modeUsed: input.mode ?? "hybrid" },
);

vi.mock("../data/local-search.js", () => ({
  searchLocal: (i: SearchInput) => localFn(i),
  presenceOnDevice: async (hits: SearchHit[]) =>
    new Map(
      hits
        .filter((h) => !edge.absent.has(h.id))
        .map((h) => [`${h.kind}:${h.id}`, edge.deleted.has(h.id) ? "deleted" : "live"]),
    ),
}));
vi.mock("../data/api-client.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiClient: { search: (i: SearchInput, o?: CallOpOptions) => searchFn(i, o) },
}));
vi.mock("../data/bootstrap.js", () => ({
  hasSyncTarget: () => edge.hasServer,
  apiBaseUrl: () => "http://server.test",
  authToken: () => "t",
}));
vi.mock("../data/store.js", () => ({
  stampedFor: (value: unknown) => ({ value, version: 0 }),
  useSyncStatus: () => () => ({ state: edge.syncState, pendingCount: 0, serverCursor: 0 }),
  useAllPages: () => Object.assign(() => [], { loading: false, error: undefined }),
}));

const openEmbeddingsSettings = vi.fn();
// The real panel module pulls in theme, appearance and template storage; the view only needs the
// function that opens it and the signal that says whether it is open.
const settingsState = vi.hoisted(() => ({ setOpen: (_open: boolean): void => {} }));
vi.mock("./SettingsPanel.js", async () => {
  const { createSignal } = await import("solid-js");
  const [settingsOpen, setOpen] = createSignal(false);
  settingsState.setOpen = setOpen;
  return { openEmbeddingsSettings: () => openEmbeddingsSettings(), settingsOpen };
});

afterEach(() => {
  cleanup();
  searchFn.mockClear();
  localFn.mockClear();
  openEmbeddingsSettings.mockClear();
  lastInput = undefined;
  serverFallback = undefined;
  serverHits = [AURORA];
  edge.hasServer = true;
  edge.syncState = "idle";
  edge.absent.clear();
  edge.deleted.clear();
});

// Imported here, while the file is collected (no timeout runs), not inside the first test: that
// cold import took 2.2 s of its 5 s alone at load average 46, and two tests failed in a full run at
// load average 70 (B-334, the B-144 pattern). `vi.mock` above is hoisted, so the view still sees
// the fakes.
import { SearchView } from "./SearchView.js";

async function renderSearch() {
  return render(() => (
    <Router>
      <Route path="*" component={SearchView} />
    </Router>
  ));
}

function type(query: string): void {
  fireEvent.input(screen.getByPlaceholderText("Search…"), { target: { value: query } });
}

const sourceLine = () => document.querySelector(".search-source")?.textContent;

describe("SearchView filters (audit §2 #11)", () => {
  it("a task marker searches blocks with that marker; journals only and pages only pass through", async () => {
    await renderSearch();
    type("pricing");
    await screen.findByText("Projects/Aurora");
    expect(lastInput?.scope).toBe("all");
    expect(lastInput?.properties).toBeUndefined();

    const marker = document.querySelector(".search-filter-marker") as HTMLSelectElement;
    fireEvent.change(marker, { target: { value: "LATER" } });
    await vi.waitFor(() => expect(lastInput?.properties).toEqual({ marker: "LATER" }));
    expect(lastInput?.scope).toBe("blocks");
    // A task is a block, so "Pages only" is not offered alongside a marker.
    const pagesOnly = document.querySelector(
      '.search-filter-kind option[value="pages"]',
    ) as HTMLOptionElement;
    expect(pagesOnly.disabled).toBe(true);

    fireEvent.change(marker, { target: { value: "" } });
    const kind = document.querySelector(".search-filter-kind") as HTMLSelectElement;
    fireEvent.change(kind, { target: { value: "pages" } });
    await vi.waitFor(() => expect(lastInput?.scope).toBe("pages"));
    expect(lastInput?.properties).toBeUndefined();

    const journals = document.querySelector(".search-filter-journals") as HTMLInputElement;
    fireEvent.click(journals);
    await vi.waitFor(() => expect(lastInput?.journalsOnly).toBe(true));
  });
});

describe("SearchView", () => {
  it("shows a hint and does not search before anything is typed", async () => {
    await renderSearch();
    expect(screen.getByText("Type to search.")).toBeTruthy();
    expect(localFn).not.toHaveBeenCalled();
    expect(searchFn).not.toHaveBeenCalled();
  });

  it("searches on input and renders a result with page, breadcrumb, and a highlighted snippet", async () => {
    await renderSearch();
    type("pricing");

    const page = await screen.findByText("Projects/Aurora");
    expect(page).toBeTruthy();
    expect(screen.getByText(/Launch checklist › Open risks/)).toBeTruthy();
    // "**pricing**" is rendered by InlineContent as a <mark>.
    const mark = document.querySelector(".search-result-snippet mark");
    expect(mark?.textContent).toBe("pricing");
    expect(lastInput?.query).toBe("pricing");
    expect(lastInput?.mode).toBe("hybrid");
  });

  it("defaults to hybrid mode and switches mode on toggle, re-running the search", async () => {
    await renderSearch();
    type("pricing");
    await screen.findByText("Projects/Aurora");
    expect(lastInput?.mode).toBe("hybrid");

    fireEvent.click(screen.getByRole("button", { name: "keyword" }));
    await vi.waitFor(() => expect(lastInput?.mode).toBe("keyword"));
    expect(screen.getByRole("button", { name: "keyword" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "hybrid" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("includes tag/namespace/date filters typed into the filters panel in the search input", async () => {
    await renderSearch();
    type("pricing");
    fireEvent.input(screen.getByPlaceholderText("e.g. launch"), { target: { value: "aurora" } });
    fireEvent.input(screen.getByPlaceholderText("e.g. Projects"), {
      target: { value: "Projects" },
    });

    await screen.findByText("Projects/Aurora");
    await vi.waitFor(() => expect(lastInput?.namespace).toBe("Projects"));
    expect(lastInput?.tags).toEqual(["aurora"]);
  });
});

describe("SearchView: local first, then the server's semantic matches (server-search)", () => {
  it("local-only (B-577's case): the device answers, the server is never asked, and the line says so", async () => {
    edge.hasServer = false;
    await renderSearch();
    type("pricing");
    await screen.findByText("Projects/Aurora");
    expect(sourceLine()).toBe("Keyword search on this device (local-only).");
    expect(screen.queryByRole("alert")).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(searchFn).not.toHaveBeenCalled();
  });

  it("offline: the device answers and the server is not asked", async () => {
    edge.syncState = "offline";
    await renderSearch();
    type("pricing");
    await screen.findByText("Projects/Aurora");
    expect(sourceLine()).toBe("Keyword search on this device (offline).");
    await new Promise((r) => setTimeout(r, 400));
    expect(searchFn).not.toHaveBeenCalled();
  });

  it("keyword mode is the device alone", async () => {
    await renderSearch();
    fireEvent.click(screen.getByRole("button", { name: "keyword" }));
    type("pricing");
    await screen.findByText("Projects/Aurora");
    expect(sourceLine()).toBe("Keyword search on this device.");
    await new Promise((r) => setTimeout(r, 400));
    expect(searchFn).not.toHaveBeenCalled();
  });

  it("shows the device's hits before the server answers, then adds the semantic ones, marked", async () => {
    serverHits = [IDEAS, AURORA];
    await renderSearch();
    type("pricing");
    await screen.findByText("Projects/Aurora");
    // On screen before the server was even asked (debounced).
    expect(searchFn).not.toHaveBeenCalled();
    expect(screen.queryByText("Ideas")).toBeNull();

    await screen.findByText("Ideas");
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(sourceLine()).toBe("Keyword (this device) and semantic (server) · 1 found by meaning.");
    const rows = [...document.querySelectorAll(".search-result")];
    // Nobody had touched the list, so the server's ranking is taken.
    expect(
      rows.map((r) => r.querySelector(".search-result-page")?.firstChild?.textContent),
    ).toEqual(["Ideas", "Projects/Aurora"]);
    expect(rows[0]?.hasAttribute("data-semantic")).toBe(true);
    expect(rows[0]?.querySelector(".search-result-tag")?.textContent).toBe("semantic");
    expect(rows[1]?.hasAttribute("data-semantic")).toBe(false);
    expect(document.querySelector(".search-summary")?.textContent).toBe("2 results");
  });

  it("does not move the device's rows once the pointer has moved over the list", async () => {
    serverHits = [IDEAS, AURORA];
    await renderSearch();
    type("pricing");
    await screen.findByText("Projects/Aurora");
    fireEvent.pointerMove(document.querySelector(".search-results") as Element);

    await screen.findByText("Ideas");
    const rows = [...document.querySelectorAll(".search-result-page")].map(
      (r) => r.firstChild?.textContent,
    );
    expect(rows).toEqual(["Projects/Aurora", "Ideas"]);
  });

  it("a server hit this device has not synced yet is shown, but does not open", async () => {
    serverHits = [IDEAS];
    edge.absent.add("b2");
    await renderSearch();
    type("pricing");
    await screen.findByText("Ideas");
    const row = document.querySelector(".search-result[data-semantic]") as Element;
    expect(row.querySelector("button")).toBeNull();
    expect(row.textContent).toContain("Not on this device yet");
  });

  it("a server hit this device has deleted is not shown", async () => {
    serverHits = [IDEAS];
    edge.deleted.add("b2");
    await renderSearch();
    type("pricing");
    await vi.waitFor(() => expect(sourceLine()).toContain("semantic (server)"));
    expect(screen.queryByText("Ideas")).toBeNull();
  });

  it("a server that does not answer in time leaves the device's hits and says so", async () => {
    searchFn.mockImplementationOnce(async () => {
      const { ApiError } = await import("../data/api-client.js");
      throw new ApiError("timeout", "no answer");
    });
    await renderSearch();
    type("pricing");
    await vi.waitFor(() =>
      expect(sourceLine()).toBe(
        "Keyword search on this device · the server did not answer in time.",
      ),
    );
    expect(screen.getByText("Projects/Aurora")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks the server once per pause in typing, not per keystroke", async () => {
    await renderSearch();
    type("p");
    type("pr");
    type("pri");
    await vi.waitFor(() => expect(sourceLine()).toContain("semantic (server)"));
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(searchFn.mock.calls[0]?.[0].query).toBe("pri");
    // …while the device searched each time.
    expect(localFn.mock.calls.map((c) => c[0].query)).toEqual(["p", "pr", "pri"]);
  });
});

describe("SearchView filter order (B-355)", () => {
  it("keeps Updated after and Updated before next to each other, as the one range they are", async () => {
    const { container } = await renderSearch();
    // A label's own words, without the option texts of the select inside it.
    const names = [...container.querySelectorAll(".search-filters > label")].map((label) =>
      [...label.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim() ?? "")
        .join(""),
    );
    const after = names.indexOf("Updated after");
    expect(after).toBeGreaterThanOrEqual(0);
    expect(names[after + 1]).toBe("Updated before");
  });
});

describe("SearchView fallback note (B-520)", () => {
  it("says why a hybrid search fell back, and its Settings button opens the embeddings section", async () => {
    serverFallback = {
      reason: "not_configured",
      message: "Semantic search is not set up: no embedding model is configured.",
    };
    await renderSearch();
    type("pricing");

    const note = await screen.findByRole("status");
    expect(note.textContent).toContain(
      "Fell back to keyword search: semantic search is not set up.",
    );
    // The device's keyword hits are still there under it.
    expect(document.querySelector(".search-summary")?.textContent).toBe("1 result");
    fireEvent.click(screen.getByRole("button", { name: "Set up semantic search…" }));
    expect(openEmbeddingsSettings).toHaveBeenCalledTimes(1);
  });

  it("Check again re-runs the same search", async () => {
    serverFallback = { reason: "indexing", message: "…", indexed: 3, total: 9, errors: 0 };
    await renderSearch();
    type("pricing");
    await screen.findByText(/still being built \(3 of 9 embedded\)/);
    const calls = searchFn.mock.calls.length;

    serverFallback = { reason: "indexing", message: "…", indexed: 8, total: 9, errors: 0 };
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText(/still being built \(8 of 9 embedded\)/);
    expect(searchFn.mock.calls.length).toBe(calls + 1);
    expect(lastInput?.query).toBe("pricing");
  });

  it("Check again keeps keyboard focus on the button when the same reason comes back (B-525)", async () => {
    // A keyboard user presses Enter on "Check again" while the index builds; the answer is the
    // same reason with a new count. The button must be the same node, still focused — not a
    // replacement mounted by a `<For>` keyed on freshly built action objects, which left focus on
    // <body> in Chromium and WebKit. This covers that half only: jsdom does not blur an element
    // Solid MOVES, the other half of B-525, which `e2e/tests/search-fallback.spec.ts` covers.
    serverFallback = { reason: "indexing", message: "…", indexed: 3, total: 9, errors: 0 };
    await renderSearch();
    type("pricing");
    await screen.findByText(/still being built \(3 of 9 embedded\)/);
    const button = screen.getByRole("button", { name: "Check again" });
    button.focus();
    expect(document.activeElement).toBe(button);

    serverFallback = { reason: "indexing", message: "…", indexed: 8, total: 9, errors: 0 };
    fireEvent.click(button);
    await screen.findByText(/still being built \(8 of 9 embedded\)/);
    expect(screen.getByRole("button", { name: "Check again" })).toBe(button);
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("closing Settings re-runs a search that fell back, and only one that did (B-523)", async () => {
    serverFallback = { reason: "not_configured", message: "…" };
    await renderSearch();
    type("pricing");
    await screen.findByText(/semantic search is not set up/);
    const calls = searchFn.mock.calls.length;

    settingsState.setOpen(true);
    serverFallback = { reason: "indexing", message: "…", indexed: 0, total: 9, errors: 0 };
    settingsState.setOpen(false);
    await screen.findByText(/still being built \(0 of 9 embedded\)/);
    expect(searchFn.mock.calls.length).toBe(calls + 1);

    // A search that did not fall back is not re-run by opening and closing Settings.
    serverFallback = undefined;
    fireEvent.click(screen.getByRole("button", { name: "hybrid" }));
    fireEvent.click(screen.getByRole("button", { name: "keyword" }));
    await vi.waitFor(() => expect(sourceLine()).toBe("Keyword search on this device."));
    const localCalls = localFn.mock.calls.length;
    const serverCalls = searchFn.mock.calls.length;
    settingsState.setOpen(true);
    settingsState.setOpen(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(localFn.mock.calls.length).toBe(localCalls);
    expect(searchFn.mock.calls.length).toBe(serverCalls);
  });

  it("shows no note when the server's semantic search ran", async () => {
    await renderSearch();
    type("pricing");
    await vi.waitFor(() => expect(sourceLine()).toContain("semantic (server)"));
    expect(document.querySelector(".search-fallback")).toBeNull();
  });
});
