import type { PageRow } from "@nooklet/core";
import { describe, expect, it } from "vitest";
import { foldDiacritics, fuzzyFindPages, pageDisplayTitle } from "./pageSearch.js";

function page(overrides: Partial<PageRow> & Pick<PageRow, "id" | "name">): PageRow {
  return {
    graphId: "default",
    key: overrides.name.toLowerCase(),
    journalDay: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    nameHlc: "2026-09-10T00:00:00.000Z-0000-aaaaaaaa",
    deletedHlc: null,
    ...overrides,
  };
}

describe("foldDiacritics", () => {
  it("folds diacritics and lowercases", () => {
    expect(foldDiacritics("Šimon Dvořák")).toBe("simon dvorak");
    expect(foldDiacritics("café")).toBe("cafe");
  });
});

describe("pageDisplayTitle", () => {
  it("uses the page name for a non-journal page", () => {
    expect(pageDisplayTitle(page({ id: "p1", name: "Projects/Aurora" }))).toBe("Projects/Aurora");
  });

  it("formats a journal page's title from its journalDay", () => {
    expect(pageDisplayTitle(page({ id: "p2", name: "2026-09-10", journalDay: 20260910 }))).toBe(
      "Sep 10th, 2026",
    );
  });
});

describe("fuzzyFindPages", () => {
  const pages = [
    page({ id: "p1", name: "Projects/Aurora" }),
    page({ id: "p2", name: "@Šimon Dvořák" }),
    page({ id: "p3", name: "Vendors/Acme Supply" }),
  ];

  it("returns everything (up to limit) for an empty query", () => {
    expect(fuzzyFindPages(pages, "", 2).map((m) => m.page.id)).toEqual(["p1", "p2"]);
  });

  it("matches accent-insensitively", () => {
    const matches = fuzzyFindPages(pages, "simon");
    expect(matches.map((m) => m.page.id)).toContain("p2");
  });

  it("matches with diacritics typed too", () => {
    const matches = fuzzyFindPages(pages, "dvořák");
    expect(matches.map((m) => m.page.id)).toContain("p2");
  });

  it("excludes non-matching pages", () => {
    const matches = fuzzyFindPages(pages, "zzz-does-not-exist");
    expect(matches).toEqual([]);
  });
});
