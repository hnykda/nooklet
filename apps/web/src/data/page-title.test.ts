// @vitest-environment jsdom
/**
 * The display/storage split of ADR 018, and the one rule in it that is easy to get backwards: a
 * graph may *suggest* a date format, but a choice the reader has made always wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "nooklet.journalTitleFormat";

/** Fresh module per test: the format is module-level state seeded from localStorage at import, so
 *  a shared instance would carry one test's choice into the next. */
async function load(): Promise<typeof import("./page-title.js")> {
  vi.resetModules();
  return import("./page-title.js");
}

beforeEach(() => {
  localStorage.clear();
});

describe("displayPageName", () => {
  it("renders a journal by its day and an ordinary page by its name", async () => {
    const m = await load();
    expect(m.displayPageName({ name: "2026-09-07", journalDay: 20260907 })).toBe("Sep 7th, 2026");
    expect(m.displayPageName({ name: "travel/trip-planning", journalDay: null })).toBe(
      "travel/trip-planning",
    );
  });

  it("follows the chosen format without a reload", async () => {
    const m = await load();
    m.setJournalTitleFormat("EEEE, dd.MM.yyyy");
    expect(m.displayPageName({ name: "2026-09-07", journalDay: 20260907 })).toBe(
      "Monday, 07.09.2026",
    );
  });

  it("refuses a pattern date-fns cannot format, rather than breaking every page", async () => {
    const m = await load();
    m.setJournalTitleFormat("YYYY-MM-DD"); // the classic: uppercase tokens date-fns rejects
    expect(m.journalTitleFormat()).toBe("MMM do, yyyy");
  });
});

describe("displayRefName", () => {
  it("shows a date written any recognised way in the chosen format", async () => {
    const m = await load();
    m.setJournalTitleFormat("E, dd.MM.yyyy");
    expect(m.displayRefName("2026-09-07")).toBe("Mon, 07.09.2026");
    expect(m.displayRefName("Sep 7th, 2026")).toBe("Mon, 07.09.2026");
  });

  it("passes a name that is not a date straight through", async () => {
    const m = await load();
    expect(m.displayRefName("97 poets of Revachol")).toBe("97 poets of Revachol");
  });
});

describe("suggestJournalTitleFormat", () => {
  it("adopts the imported graph's format when nothing has been chosen", async () => {
    const m = await load();
    m.suggestJournalTitleFormat("E, dd.MM.yyyy");
    expect(m.displayPageName({ name: "2026-09-07", journalDay: 20260907 })).toBe("Mon, 07.09.2026");
  });

  it("never overrides a format the reader picked", async () => {
    localStorage.setItem(STORAGE_KEY, "yyyy-MM-dd");
    const m = await load();
    m.suggestJournalTitleFormat("E, dd.MM.yyyy");
    expect(m.journalTitleFormat()).toBe("yyyy-MM-dd");
  });

  it("takes a pattern that is not one of the presets, since a Logseq graph may use any", async () => {
    const m = await load();
    m.suggestJournalTitleFormat("do MMM yyyy");
    expect(m.displayPageName({ name: "2026-09-07", journalDay: 20260907 })).toBe("7th Sep 2026");
    // …and the picker offers it, so it is not active-but-unselectable.
    expect(m.journalTitleOptions()[0]).toEqual({ pattern: "do MMM yyyy", label: "7th Sep 2026" });
  });

  it("ignores a suggestion that cannot be formatted", async () => {
    const m = await load();
    m.suggestJournalTitleFormat("nonsense");
    expect(m.journalTitleFormat()).toBe("MMM do, yyyy");
  });
});
