import { describe, expect, it } from "vitest";
import {
  addMonths,
  formatStoredDate,
  parseDateInput,
  parseStoredDate,
  weekdayIndex,
} from "./parse.js";

// A Sunday, pinned: every relative answer below is checked against a calendar a person can read.
const SUN = 20260913;
// A Wednesday, for weekday arithmetic mid-week.
const WED = 20260916;

function day(input: string, today = SUN): number | undefined {
  const r = parseDateInput(input, today);
  return r.kind === "value" ? r.parts.day : undefined;
}

describe("parseDateInput — words", () => {
  it("today, tomorrow, yesterday and their aliases", () => {
    expect(day("today")).toBe(20260913);
    expect(day("Tomorrow")).toBe(20260914);
    expect(day("tmr")).toBe(20260914);
    expect(day("tmrw")).toBe(20260914);
    expect(day("yesterday")).toBe(20260912);
  });

  it("a unique prefix of two or more letters is enough; an ambiguous one is not a date", () => {
    expect(day("tom")).toBe(20260914);
    expect(day("tod")).toBe(20260913);
    expect(day("fr")).toBe(20260918);
    expect(parseDateInput("to", SUN).kind).toBe("invalid"); // today or tomorrow?
    expect(parseDateInput("t", SUN).kind).toBe("invalid");
  });

  it("a weekday is the next one strictly after today", () => {
    expect(weekdayIndex(SUN)).toBe(6);
    expect(day("mon")).toBe(20260914);
    expect(day("fri")).toBe(20260918);
    expect(day("friday")).toBe(20260918);
    // Today is Sunday: "sun" means next Sunday, because today is spelled "today".
    expect(day("sun")).toBe(20260920);
    expect(day("wed", WED)).toBe(20260923);
    expect(day("thu", WED)).toBe(20260917);
    expect(day("thurs", WED)).toBe(20260917);
    expect(day("tues", WED)).toBe(20260922);
  });

  it("next week / month / year / <weekday> mean what the [[ date shortcuts mean", () => {
    expect(day("next week")).toBe(20260914); // Sunday → Monday of the next ISO week
    expect(day("next week", WED)).toBe(20260921);
    expect(day("next month")).toBe(20261001);
    expect(day("next year")).toBe(20270101);
    expect(day("next fri", WED)).toBe(20260925);
  });
});

describe("parseDateInput — relative", () => {
  it("+Nd/w/m/y, -N, bare +N as days, and 'in N units'", () => {
    expect(day("+3d")).toBe(20260916);
    expect(day("+3")).toBe(20260916);
    expect(day("-2d")).toBe(20260911);
    expect(day("+2w")).toBe(20260927);
    expect(day("+1m")).toBe(20261013);
    expect(day("+1y")).toBe(20270913);
    expect(day("3d")).toBe(20260916);
    expect(day("in 3 days")).toBe(20260916);
    expect(day("2 weeks")).toBe(20260927);
  });

  it("an offset that leaves the calendar is not a date — never a garbage or NaN day (B-145)", () => {
    // `+10000y` once wrote `scheduled:: 1202-60-91` (the reducer's regex takes any 4-2-2 digits),
    // and `+99999999d` gave a NaN day that threw inside the picker's preview on every keystroke.
    for (const input of ["+10000y", "+99999999d", "in 99999999999 days", "-3000y"]) {
      const r = parseDateInput(input, SUN);
      expect(r.kind, input).toBe("invalid");
      expect(r.kind === "invalid" && r.message, input).toContain(`"${input}"`);
    }
    expect(day("+7973y")).toBe(99990913); // the last year a stored date can hold
  });

  it("months clamp to the end of a shorter month", () => {
    expect(addMonths(20260131, 1)).toBe(20260228);
    expect(addMonths(20280131, 1)).toBe(20280229);
    expect(addMonths(20261231, 1)).toBe(20270131);
    expect(addMonths(20260315, -3)).toBe(20251215);
  });
});

describe("parseDateInput — absolute", () => {
  it("ISO dates, single-digit parts accepted, impossible dates rejected", () => {
    expect(day("2026-09-20")).toBe(20260920);
    expect(day("2026-9-5")).toBe(20260905);
    const bad = parseDateInput("2026-02-30", SUN);
    expect(bad.kind).toBe("invalid");
  });

  it("day.month[.year] as the owner writes Czech dates", () => {
    expect(day("20.9.")).toBe(20260920);
    expect(day("20. 9. 2027")).toBe(20270920);
    // Already behind today and no year typed: the coming one.
    expect(day("5.1.")).toBe(20270105);
  });

  it("month names either side of the day", () => {
    expect(day("sep 20")).toBe(20260920);
    expect(day("20 sep")).toBe(20260920);
    expect(day("September 20th, 2027")).toBe(20270920);
    expect(day("jan 5")).toBe(20270105);
    expect(day("today", SUN)).toBe(20260913);
  });

  it("a day that has already passed this year but is today still means today", () => {
    expect(day("13.9.")).toBe(20260913);
  });
});

describe("parseDateInput — time, repeat, clear, junk", () => {
  it("a trailing 24-hour time is normalised to HH:MM; a time alone keeps the day", () => {
    expect(parseDateInput("fri 14:00", SUN)).toEqual({
      kind: "value",
      parts: { day: 20260918, time: "14:00" },
    });
    expect(parseDateInput("2026-09-20 at 9:05", SUN)).toEqual({
      kind: "value",
      parts: { day: 20260920, time: "09:05" },
    });
    expect(parseDateInput("9:30", SUN)).toEqual({ kind: "value", parts: { time: "09:30" } });
    expect(parseDateInput("fri 24:00", SUN).kind).toBe("invalid");
    expect(parseDateInput("fri no time", SUN)).toEqual({
      kind: "value",
      parts: { day: 20260918, time: null },
    });
  });

  it("every … writes ADR 011's repeat shape, 'from done' included; 'no repeat' removes it", () => {
    expect(parseDateInput("mon every week", SUN)).toEqual({
      kind: "value",
      parts: { day: 20260914, repeat: "1w" },
    });
    expect(parseDateInput("+1m 08:00 every 2 months from done", SUN)).toEqual({
      kind: "value",
      parts: { day: 20261013, time: "08:00", repeat: "2m from done" },
    });
    expect(parseDateInput("every 3d", SUN)).toEqual({ kind: "value", parts: { repeat: "3d" } });
    expect(parseDateInput("tomorrow no repeat", SUN)).toEqual({
      kind: "value",
      parts: { day: 20260914, repeat: null },
    });
    expect(parseDateInput("every 0w", SUN).kind).toBe("invalid");
  });

  it("none / clear / remove clear the date — whole words only", () => {
    expect(parseDateInput("none", SUN)).toEqual({ kind: "clear" });
    expect(parseDateInput(" Clear ", SUN)).toEqual({ kind: "clear" });
    expect(parseDateInput("remove", SUN)).toEqual({ kind: "clear" });
    expect(parseDateInput("non", SUN).kind).toBe("invalid");
  });

  it("empty is empty; junk says what to type instead", () => {
    expect(parseDateInput("   ", SUN)).toEqual({ kind: "empty" });
    const junk = parseDateInput("banana", SUN);
    expect(junk.kind).toBe("invalid");
    expect(junk.kind === "invalid" && junk.message).toContain("tomorrow");
  });
});

describe("stored value (ADR 011)", () => {
  it("formats exactly YYYY-MM-DD[ HH:MM] and parses it back", () => {
    expect(formatStoredDate(20260905, null)).toBe("2026-09-05");
    expect(formatStoredDate(20260905, "14:00")).toBe("2026-09-05 14:00");
    expect(parseStoredDate("2026-09-05 14:00")).toEqual({ day: 20260905, time: "14:00" });
    expect(parseStoredDate("2026-09-05")).toEqual({ day: 20260905, time: null });
    expect(parseStoredDate("<2026-09-05 Sat>")).toBeUndefined();
    expect(parseStoredDate(null)).toBeUndefined();
  });

  it("refuses to format a day that is not on the calendar rather than write a wrong one (B-145)", () => {
    expect(() => formatStoredDate(120260913, null)).toThrow(RangeError);
    expect(() => formatStoredDate(Number.NaN, null)).toThrow(RangeError);
  });
});
