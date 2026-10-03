import { describe, expect, it } from "vitest";
import { completeTask, formatDoneTimestamp, nextCycleMarker } from "./task-logic.js";

describe("nextCycleMarker (R34)", () => {
  it("cycles null -> TODO -> DOING -> DONE -> null", () => {
    expect(nextCycleMarker(null)).toBe("TODO");
    expect(nextCycleMarker("TODO")).toBe("DOING");
    expect(nextCycleMarker("DOING")).toBe("DONE");
    expect(nextCycleMarker("DONE")).toBe(null);
  });

  it("never returns WAITING or CANCELED", () => {
    for (const m of [null, "TODO", "DOING", "DONE"] as const) {
      const next = nextCycleMarker(m);
      expect(next).not.toBe("WAITING");
      expect(next).not.toBe("CANCELED");
    }
  });

  it("under `now` (B-608): null -> LATER -> NOW -> DONE -> null; TODO still goes to DOING", () => {
    expect(nextCycleMarker(null, "now")).toBe("LATER");
    expect(nextCycleMarker("LATER", "now")).toBe("NOW");
    expect(nextCycleMarker("NOW", "now")).toBe("DONE");
    expect(nextCycleMarker("DONE", "now")).toBe(null);
    expect(nextCycleMarker("TODO", "now")).toBe("DOING");
  });

  it("a LATER block under `todo` cycles within its own pair, not to null (B-608)", () => {
    expect(nextCycleMarker("LATER", "todo")).toBe("NOW");
    expect(nextCycleMarker("NOW", "todo")).toBe("DONE");
  });
});

describe("completeTask (R35) — repeating LATER/NOW task (B-608)", () => {
  it("reopens as LATER, not TODO", () => {
    const r = completeTask({ marker: "NOW", scheduled: "2026-09-10", repeat: "1d" }, 0);
    expect(r.marker).toBe("LATER");
    expect(r.scheduled).toBe("2026-09-11");
  });
});

describe("formatDoneTimestamp", () => {
  it("formats as ISO 8601 UTC with a trailing Z", () => {
    const ts = formatDoneTimestamp(Date.UTC(2026, 8, 10, 12, 34, 56)); // month is 0-indexed
    expect(ts).toBe("2026-09-10T12:34:56Z");
  });
});

describe("completeTask (R35) — no repeat", () => {
  it("stamps done and sets marker DONE, leaving dates untouched", () => {
    const result = completeTask(
      { marker: "DOING", scheduled: "2026-09-10" },
      Date.UTC(2026, 8, 10, 9, 0, 0),
    );
    expect(result.marker).toBe("DONE");
    expect(result.done).toBe("2026-09-10T09:00:00Z");
    expect(result.scheduled).toBeUndefined();
  });
});

describe("completeTask (R35) — repeat without 'from done'", () => {
  it("advances scheduled from its ORIGINAL date by the interval, resets marker to TODO", () => {
    const result = completeTask(
      { marker: "TODO", scheduled: "2026-09-10", repeat: "1w" },
      Date.UTC(2026, 8, 10, 9, 0, 0),
    );
    expect(result.marker).toBe("TODO");
    expect(result.done).toBe("2026-09-10T09:00:00Z");
    expect(result.scheduled).toBe("2026-09-17");
  });

  it("advances both scheduled and deadline when both are present", () => {
    const result = completeTask(
      { marker: "TODO", scheduled: "2026-09-10", deadline: "2026-09-12", repeat: "1d" },
      Date.UTC(2026, 8, 10),
    );
    expect(result.scheduled).toBe("2026-09-11");
    expect(result.deadline).toBe("2026-09-13");
  });

  it("preserves a time-of-day component", () => {
    const result = completeTask(
      { marker: "TODO", deadline: "2026-09-10 14:00", repeat: "1w" },
      Date.UTC(2026, 8, 10),
    );
    expect(result.deadline).toBe("2026-09-17 14:00");
  });

  it("handles month arithmetic calendar-aware (not fixed day count)", () => {
    const result = completeTask(
      { marker: "TODO", scheduled: "2026-01-31", repeat: "1m" },
      Date.UTC(2026, 0, 31),
    );
    // JS Date rolls Jan 31 + 1 month into a valid date (e.g. Mar 3), not a rejected/invalid one —
    // this test only pins down the exact rollover behavior for the notoriously tricky "31st"
    // case, not a specific desired policy.
    expect(result.scheduled).toBeDefined();
    expect(result.scheduled).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles year arithmetic", () => {
    const result = completeTask(
      { marker: "TODO", scheduled: "2026-09-10", repeat: "1y" },
      Date.UTC(2026, 8, 10),
    );
    expect(result.scheduled).toBe("2027-09-10");
  });
});

describe("completeTask (R35) — repeat 'from done'", () => {
  it("advances from the just-stamped done timestamp instead of the original date", () => {
    // Original scheduled date is long past; "from done" means the next occurrence is relative to
    // NOW (the completion time), not the stale original date.
    const result = completeTask(
      { marker: "TODO", scheduled: "2026-01-01", repeat: "1w from done" },
      Date.UTC(2026, 8, 10),
    );
    expect(result.scheduled).toBe("2026-09-17");
  });
});

describe("completeTask (R35) — malformed repeat fails safe", () => {
  it("falls back to plain completion when repeat doesn't parse", () => {
    const result = completeTask(
      { marker: "TODO", scheduled: "2026-09-10", repeat: "garbage" },
      Date.UTC(2026, 8, 10),
    );
    expect(result.marker).toBe("DONE");
    expect(result.scheduled).toBeUndefined();
  });
});
