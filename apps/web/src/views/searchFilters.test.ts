import { describe, expect, it } from "vitest";
import { NO_SEARCH_FILTERS, searchFilterInput, withMarker } from "./searchFilters.js";

describe("searchFilterInput", () => {
  it("adds nothing beyond the default scope when no filter is chosen", () => {
    expect(searchFilterInput(NO_SEARCH_FILTERS)).toEqual({ scope: "all" });
  });

  it("maps blocks-only and pages-only to scope, and journals-only to its flag", () => {
    expect(searchFilterInput({ ...NO_SEARCH_FILTERS, kind: "pages" })).toEqual({ scope: "pages" });
    expect(searchFilterInput({ ...NO_SEARCH_FILTERS, kind: "blocks", journalsOnly: true })).toEqual(
      { scope: "blocks", journalsOnly: true },
    );
  });

  it("a task marker filters blocks by their marker and searches blocks only", () => {
    expect(searchFilterInput({ ...NO_SEARCH_FILTERS, marker: "LATER" })).toEqual({
      scope: "blocks",
      properties: { marker: "LATER" },
    });
    // Pages have no marker: a marker with "pages only" still means tasks, not zero results.
    expect(searchFilterInput({ marker: "DONE", kind: "pages", journalsOnly: true })).toEqual({
      scope: "blocks",
      properties: { marker: "DONE" },
      journalsOnly: true,
    });
  });
});

describe("withMarker", () => {
  it("moves Show off a pages-only choice that a marker cannot honour, and leaves others alone", () => {
    // Before: Show kept reading "Pages only" (a disabled, selected option) over task blocks.
    const pages = { ...NO_SEARCH_FILTERS, kind: "pages" as const };
    expect(withMarker(pages, "TODO")).toEqual({ ...pages, marker: "TODO", kind: "blocks" });
    expect(withMarker({ ...NO_SEARCH_FILTERS, kind: "all" }, "TODO").kind).toBe("all");
    expect(withMarker(pages, "")).toEqual(pages);
  });
});
