import { describe, expect, it } from "vitest";
import {
  formatJournalTitle,
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
