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

describe("SearchView filters (audit §2 #11)", () => {
  it("a task marker searches blocks with that marker; journals only and pages only pass through", async () => {
    await renderSearch();
    fireEvent.input(screen.getByPlaceholderText("Search…"), { target: { value: "pricing" } });
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
