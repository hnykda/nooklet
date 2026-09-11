import { describe, expect, it } from "vitest";
import {
  canonicalRefName,
  formatJournalTitle,
  isoJournalName,
  isValidJournalDay,
  journalDayFromFileName,
  journalDayToFileName,
  parseJournalTitle,
} from "./journal.js";

describe("journal", () => {
  it("parses file names", () => {
    expect(journalDayFromFileName("2026_09_10")).toBe(20260910);
    expect(journalDayFromFileName("2026-09-10")).toBe(20260910);
    expect(journalDayFromFileName("2026_13_10")).toBeNull();
    expect(journalDayFromFileName("notes")).toBeNull();
    expect(journalDayToFileName(20260910)).toBe("2026_09_10");
  });

  it("formats and parses titles in many formats", () => {
    expect(formatJournalTitle(20260910)).toBe("Sep 10th, 2026");
    for (const [title, day] of [
      ["Sep 10th, 2026", 20260910],
      ["sep 10th, 2026", 20260910],
      ["apr 1st, 2024", 20240401],
      ["fri, 06.01.2023", 20230106],
      ["Friday, 06.01.2023", 20230106],
      ["2024-04-10", 20240410],
      ["2024_04_10", 20240410],
      ["10.04.2024", 20240410],
      ["September 10th, 2026", 20260910],
      ["Sep 10, 2026", 20260910],
    ] as const) {
      expect(parseJournalTitle(title), title).toBe(day);
    }
  });

  it("rejects non-dates", () => {
    for (const t of ["hello", "97 poets of revachol", "2024", "1", "v1.0", "may"]) {
      expect(parseJournalTitle(t), t).toBeNull();
    }
  });

  it("validates days", () => {
    expect(isValidJournalDay(20240229)).toBe(true);
    expect(isValidJournalDay(20230229)).toBe(false);
  });
});

describe("canonical journal names (ADR 018)", () => {
  it("names a journal page by its ISO date, whatever the display format", () => {
    expect(isoJournalName(20260907)).toBe("2026-09-07");
    expect(isoJournalName(20240101)).toBe("2024-01-01");
  });

  it("collapses every recognised journal title to one reference key", () => {
    for (const written of [
      "2026-09-07",
      "Sep 7th, 2026",
      "September 7th, 2026",
      "Mon, 07.09.2026",
      "Monday, 07.09.2026",
      "07.09.2026",
      "2026_09_07",
    ]) {
      expect(canonicalRefName(written), written).toBe("2026-09-07");
    }
  });

  it("leaves a name that is not a date exactly as written", () => {
    // The last two are the interesting ones: digits and dots in a name must not be enough to
    // turn an ordinary page into a journal.
    for (const name of ["travel/trip-planning", "97 poets of Revachol", "v1.2.3", "Q3 2026"]) {
      expect(canonicalRefName(name), name).toBe(name);
    }
  });
});
