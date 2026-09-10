// @vitest-environment jsdom
import { Route, Router } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createResource } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchInput, SearchResult } from "../data/api-client.js";

let lastInput: SearchInput | undefined;
const searchFn = vi.fn(
  async (input: SearchInput): Promise<SearchResult> => ({
    hits: [
      {
        kind: "block",
        id: "b1",
        page: "Projects/Aurora",
        snippet: "Vendor **pricing** not confirmed",
        breadcrumb: ["Launch checklist", "Open risks"],
        score: 0.9,
        updatedAt: "2026-09-09T00:00:00.000Z",
      },
    ],
    modeUsed: input.mode ?? "hybrid",
  }),
);

vi.mock("../data/store.js", () => ({
  useSearchResults: (inputAccessor: () => SearchInput | undefined) => {
    // Real createResource under the mock: exercises the same async/loading behavior SearchView
    // relies on, just with a fake fetcher instead of the real HTTP client.
    const [resource, { refetch }] = createResource(inputAccessor, (i: SearchInput) => {
      lastInput = i;
      return searchFn(i);
    });
    return [resource, { refetch: () => void refetch() }];
  },
  useAllPages: () => Object.assign(() => [], { loading: false, error: undefined }),
}));

afterEach(() => {
  cleanup();
  searchFn.mockClear();
  lastInput = undefined;
});

async function renderSearch() {
  const { SearchView } = await import("./SearchView.js");
  return render(() => (
    <Router>
      <Route path="*" component={SearchView} />
    </Router>
  ));
}

describe("SearchView", () => {
  it("shows a hint and does not search before anything is typed", async () => {
    await renderSearch();
    expect(screen.getByText("Type to search.")).toBeTruthy();
    expect(searchFn).not.toHaveBeenCalled();
  });

  it("searches on input and renders a result with page, breadcrumb, and a highlighted snippet", async () => {
    await renderSearch();
    fireEvent.input(screen.getByPlaceholderText("Search…"), { target: { value: "pricing" } });

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
    fireEvent.input(screen.getByPlaceholderText("Search…"), { target: { value: "pricing" } });
    await screen.findByText("Projects/Aurora");
    expect(lastInput?.mode).toBe("hybrid");

    fireEvent.click(screen.getByRole("button", { name: "keyword" }));
    await screen.findByText("Projects/Aurora");
    expect(lastInput?.mode).toBe("keyword");
    expect(screen.getByRole("button", { name: "keyword" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "hybrid" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("includes tag/namespace/date filters typed into the filters panel in the search input", async () => {
    await renderSearch();
    fireEvent.input(screen.getByPlaceholderText("Search…"), { target: { value: "pricing" } });
    fireEvent.input(screen.getByPlaceholderText("e.g. launch"), { target: { value: "aurora" } });
    fireEvent.input(screen.getByPlaceholderText("e.g. Projects"), {
      target: { value: "Projects" },
    });

    await screen.findByText("Projects/Aurora");
    expect(lastInput?.tags).toEqual(["aurora"]);
    expect(lastInput?.namespace).toBe("Projects");
  });
});
