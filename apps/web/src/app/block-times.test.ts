import { describe, expect, it } from "vitest";
import { blockTimesLabel, blockTimesTitle } from "./block-times.js";

describe("blockTimesLabel", () => {
  const now = Date.parse("2026-09-12T15:00:00");

  it("shows only the creation time for a block whose text was never edited", () => {
    const t = Date.parse("2026-09-12T14:55:00");
    expect(blockTimesLabel({ createdAt: t, updatedAt: t }, now)).toBe("Created 5 minutes ago");
  });

  it("adds the edit time once the text changed after creation", () => {
    expect(
      blockTimesLabel(
        {
          createdAt: Date.parse("2026-09-03T09:15:00"),
          updatedAt: Date.parse("2026-09-12T14:59:30"),
        },
        now,
      ),
    ).toBe("Created 3 Sep 2026 09:15 · Edited just now");
  });

  it("uses the History view's day words for yesterday and today", () => {
    expect(
      blockTimesLabel(
        {
          createdAt: Date.parse("2026-09-11T08:05:00"),
          updatedAt: Date.parse("2026-09-12T10:30:00"),
        },
        now,
      ),
    ).toBe("Created yesterday 08:05 · Edited today 10:30");
  });

  it("never claims an edit earlier than the creation (clock skew between devices)", () => {
    // `updated_at` is the edit op's HLC wall time; a device whose clock ran behind can stamp one
    // before the creation. Showing "Edited" before "Created" would read as a bug.
    const created = Date.parse("2026-09-12T14:00:00");
    expect(blockTimesLabel({ createdAt: created, updatedAt: created - 5000 }, now)).toBe(
      "Created today 14:00",
    );
  });
});

describe("blockTimesTitle", () => {
  it("carries both exact times on separate lines, or one when never edited", () => {
    const t = Date.parse("2026-09-12T14:00:00");
    expect(blockTimesTitle({ createdAt: t, updatedAt: t })).toBe(
      `Created ${new Date(t).toLocaleString()}`,
    );
    expect(blockTimesTitle({ createdAt: t, updatedAt: t + 60_000 }).split("\n")).toHaveLength(2);
  });
});
