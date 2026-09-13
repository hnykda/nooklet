import { describe, expect, it } from "vitest";
import { dateChipLabel, dateChips, dateChipTone } from "./date-chips.js";

const TODAY = 20260913; // a Sunday

describe("dateChipLabel", () => {
  it("is relative near today, a weekday within the week, a date after that", () => {
    expect(dateChipLabel(20260913, null, TODAY)).toBe("Today");
    expect(dateChipLabel(20260914, null, TODAY)).toBe("Tomorrow");
    expect(dateChipLabel(20260912, null, TODAY)).toBe("Yesterday");
    expect(dateChipLabel(20260918, null, TODAY)).toBe("Fri");
    expect(dateChipLabel(20260920, null, TODAY)).toBe("Sep 20");
    expect(dateChipLabel(20260901, null, TODAY)).toBe("Sep 1");
    expect(dateChipLabel(20270105, null, TODAY)).toBe("Jan 5, 2027");
    expect(dateChipLabel(20260914, "14:00", TODAY)).toBe("Tomorrow 14:00");
  });
});

describe("dateChipTone", () => {
  it("overdue only for an open task; a closed task is muted whatever its date", () => {
    expect(dateChipTone(20260910, "TODO", TODAY)).toBe("overdue");
    expect(dateChipTone(20260910, "WAITING", TODAY)).toBe("overdue");
    expect(dateChipTone(20260910, null, TODAY)).toBe("past");
    expect(dateChipTone(20260910, "DONE", TODAY)).toBe("closed");
    expect(dateChipTone(20260920, "CANCELED", TODAY)).toBe("closed");
    expect(dateChipTone(20260913, "TODO", TODAY)).toBe("today");
    expect(dateChipTone(20260914, "TODO", TODAY)).toBe("upcoming");
  });
});

describe("dateChips (B-102)", () => {
  it("one chip per set field, scheduled first, with the stored value and a tooltip that says what is late", () => {
    const chips = dateChips(
      { scheduled: "2026-09-10", deadline: "2026-09-20 14:00", marker: "TODO" },
      TODAY,
    );
    expect(chips).toEqual([
      {
        field: "scheduled",
        value: "2026-09-10",
        label: "Sep 10",
        tone: "overdue",
        title: "Scheduled 2026-09-10, overdue by 3d — click to change",
      },
      {
        field: "deadline",
        value: "2026-09-20 14:00",
        label: "Sep 20 14:00",
        tone: "upcoming",
        title: "Deadline 2026-09-20 14:00 — click to change",
      },
    ]);
  });

  it("no dates, no chips; a malformed value is skipped rather than rendered as garbage", () => {
    expect(dateChips({ scheduled: null, deadline: null, marker: "TODO" }, TODAY)).toEqual([]);
    expect(
      dateChips({ scheduled: "<2026-09-10 Thu>", deadline: null, marker: null }, TODAY),
    ).toEqual([]);
  });
});
