/**
 * What the date picker understands when you type into it (R38, exposure audit §2 item 3).
 *
 * Pure and platform-free: `today` is passed in, never read, so every answer is reproducible and a
 * test can pin the calendar. The picker (`DatePicker.tsx`) feeds it the typed text on every
 * keystroke to preview where Enter would land; the task commands feed it an agent's argument.
 *
 * The OUTPUT is always ADR 011's storage shape — a calendar day (`YYYYMMDD`), an optional 24-hour
 * `HH:MM`, and a `repeat` value `<n><unit>[ from done]` — never a second syntax. The INPUT is
 * deliberately loose, because typing is the fast path and nobody should have to remember a
 * format:
 *
 *   today · tomorrow (tmr) · yesterday · unique prefixes of those and of weekday names (`tom`, `fr`)
 *   mon … sun, monday … sunday   the next one strictly AFTER today (today is spelled "today")
 *   next week · next month · next year · next fri
 *                                 Monday of next week, the 1st of next month, Jan 1 — the same
 *                                 days the `[[` date shortcuts mean (`../autocomplete/dates.ts`)
 *   +3d  -2w  +1m  +1y  +3  3d  in 3 days  2 weeks
 *   2026-09-20  2026-9-5         ISO, single-digit month/day accepted
 *   20.9.  20. 9. 2026           day.month[.year] — the owner writes Czech dates
 *   sep 20 · 20 sep · september 20th, 2027
 *   … 14:00  … at 9:30  … no time  a time after any of the above; a time on its own keeps the day
 *   … every 2w  … every month from done  … no repeat
 *   none · clear · remove · delete   take the date off (whole words only: this one is destructive)
 *
 * A date typed without a year that is already behind today rolls to next year — in September,
 * "jan 5" means the coming January, because you schedule forward.
 */

import {
  dateToJournalDay,
  isValidJournalDay,
  type JournalDay,
  journalDayToDate,
} from "@nooklet/core";

export type DateField = "scheduled" | "deadline";

/** The parts a typed string sets. An absent key means "not typed — keep what the picker has". */
export interface DateInputParts {
  day?: JournalDay;
  /** `null` = "no time" was typed. */
  time?: string | null;
  /** `null` = "no repeat" was typed. */
  repeat?: string | null;
}

export type DateInputResult =
  | { kind: "empty" }
  | { kind: "clear" }
  | { kind: "value"; parts: DateInputParts }
  | { kind: "invalid"; message: string };

const CLEAR_WORDS = new Set(["none", "clear", "remove", "delete", "no date"]);

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Words that name a day relative to today, with the aliases nobody should have to spell out.
 * Weekday names are added below with their index (0 = Monday). */
const DAY_WORDS: ReadonlyArray<{
  words: readonly string[];
  resolve: (today: JournalDay) => JournalDay;
}> = [
  { words: ["today"], resolve: (t) => t },
  { words: ["tomorrow", "tmr", "tmrw"], resolve: (t) => addDays(t, 1) },
  { words: ["yesterday"], resolve: (t) => addDays(t, -1) },
  ...WEEKDAYS.map((name, index) => ({
    words: [
      name,
      name.slice(0, 3),
      ...(index === 1 ? ["tues"] : []),
      ...(index === 3 ? ["thur", "thurs"] : []),
    ],
    resolve: (t: JournalDay) => nextWeekday(t, index),
  })),
];

const UNIT_RE = "(d|days?|w|wks?|weeks?|m|mos?|months?|y|yrs?|years?)";
const REPEAT_SUFFIX_RE = new RegExp(
  `(?:^|\\s)(?:every|repeat|repeats)\\s+(?:(\\d+)\\s*)?${UNIT_RE}(?:\\s+from\\s+(?:done|completion))?$`,
);
const NO_REPEAT_SUFFIX_RE = /(?:^|\s)no repeat$/;
const TIME_SUFFIX_RE = /(?:^|\s)(?:at\s+)?(\d{1,2}):(\d{2})$/;
const NO_TIME_SUFFIX_RE = /(?:^|\s)no time$/;
const SIGNED_REL_RE = new RegExp(`^([+-])\\s*(\\d+)\\s*${UNIT_RE}?$`);
const UNSIGNED_REL_RE = new RegExp(`^(?:in\\s+)?(\\d+)\\s*${UNIT_RE}$`);
const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DOTTED_RE = /^(\d{1,2})\.\s*(\d{1,2})\.?(?:\s*(\d{4}))?$/;
const DAY_MONTH_RE = /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+([a-z]+)\.?,?(?:\s+(\d{4}))?$/;
const MONTH_DAY_RE = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?$/;

export function parseDateInput(input: string, today: JournalDay): DateInputResult {
  let s = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "") return { kind: "empty" };
  if (CLEAR_WORDS.has(s)) return { kind: "clear" };

  const parts: DateInputParts = {};

  // Suffixes first, right to left, so "fri 14:00 every week" and "fri every week" both work and
  // the date expression left over is parsed on its own.
  const noRepeat = NO_REPEAT_SUFFIX_RE.exec(s);
  const repeat = noRepeat ? null : REPEAT_SUFFIX_RE.exec(s);
  if (noRepeat) {
    parts.repeat = null;
    s = s.slice(0, noRepeat.index).trim();
  } else if (repeat) {
    const n = repeat[1] === undefined ? 1 : Number(repeat[1]);
    if (n < 1) return { kind: "invalid", message: "a repeat needs a count of at least 1" };
    const unit = unitLetter(repeat[2] as string);
    parts.repeat = `${n}${unit}${/from/.test(repeat[0]) ? " from done" : ""}`;
    s = s.slice(0, repeat.index).trim();
  }

  const noTime = NO_TIME_SUFFIX_RE.exec(s);
  const time = noTime ? null : TIME_SUFFIX_RE.exec(s);
  if (noTime) {
    parts.time = null;
    s = s.slice(0, noTime.index).trim();
  } else if (time) {
    const hh = Number(time[1]);
    const mm = Number(time[2]);
    if (hh > 23 || mm > 59)
      return { kind: "invalid", message: `"${time[0].trim()}" is not a time` };
    parts.time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    s = s.slice(0, time.index).trim();
  }

  if (s === "") return { kind: "value", parts };

  const day = parseDayExpression(s, today);
  if (typeof day === "string") return { kind: "invalid", message: day };
  parts.day = day;
  return { kind: "value", parts };
}

/** A day, or a message saying why the text is not one. */
function parseDayExpression(s: string, today: JournalDay): JournalDay | string {
  const word = matchDayWord(s);
  if (word) return word.resolve(today);

  if (s.startsWith("next ")) {
    const rest = s.slice(5);
    if (rest === "week") return addDays(mondayOf(today), 7);
    if (rest === "month") return firstOfMonth(today, 1);
    if (rest === "year") return Math.floor(today / 10000 + 1) * 10000 + 101;
    const weekday = uniqueWeekday(rest);
    if (weekday !== undefined) return addDays(mondayOf(today), 7 + weekday);
  }

  const signed = SIGNED_REL_RE.exec(s);
  if (signed) {
    const n = Number(signed[2]) * (signed[1] === "-" ? -1 : 1);
    return addUnits(today, n, signed[3] ? unitLetter(signed[3]) : "d");
  }
  const unsigned = UNSIGNED_REL_RE.exec(s);
  if (unsigned) return addUnits(today, Number(unsigned[1]), unitLetter(unsigned[2] as string));

  const iso = ISO_RE.exec(s);
  if (iso) return realDay(Number(iso[1]), Number(iso[2]), Number(iso[3]), s);

  const dotted = DOTTED_RE.exec(s);
  if (dotted) return dayWithOptionalYear(Number(dotted[1]), Number(dotted[2]), dotted[3], today, s);

  const dayMonth = DAY_MONTH_RE.exec(s);
  if (dayMonth) {
    const month = monthIndex(dayMonth[2] as string);
    if (month !== undefined)
      return dayWithOptionalYear(Number(dayMonth[1]), month + 1, dayMonth[3], today, s);
  }
  const monthDay = MONTH_DAY_RE.exec(s);
  if (monthDay) {
    const month = monthIndex(monthDay[1] as string);
    if (month !== undefined)
      return dayWithOptionalYear(Number(monthDay[2]), month + 1, monthDay[3], today, s);
  }

  return `"${s}" is not a date — try tomorrow, fri, +3d or 2026-09-20`;
}

/** Exact alias first; otherwise a prefix of at least two letters that names exactly ONE day
 * (`tom` → tomorrow, `fr` → friday; `to` could be today or tomorrow, so it is nothing). */
function matchDayWord(s: string): (typeof DAY_WORDS)[number] | undefined {
  const exact = DAY_WORDS.find((d) => d.words.includes(s));
  if (exact) return exact;
  if (s.length < 2 || !/^[a-z]+$/.test(s)) return undefined;
  const hits = DAY_WORDS.filter((d) => d.words.some((w) => w.startsWith(s)));
  return hits.length === 1 ? hits[0] : undefined;
}

function uniqueWeekday(s: string): number | undefined {
  if (s.length < 2) return undefined;
  const hits = WEEKDAYS.flatMap((name, i) => (name.startsWith(s) ? [i] : []));
  return hits.length === 1 ? hits[0] : undefined;
}

function monthIndex(s: string): number | undefined {
  if (s.length < 3) return undefined;
  const hits = MONTHS.flatMap((name, i) => (name.startsWith(s) ? [i] : []));
  return hits.length === 1 ? hits[0] : undefined;
}

function unitLetter(unit: string): "d" | "w" | "m" | "y" {
  return unit[0] as "d" | "w" | "m" | "y";
}

function realDay(y: number, m: number, d: number, raw: string): JournalDay | string {
  const day = y * 10000 + m * 100 + d;
  return isValidJournalDay(day) ? day : `"${raw}" is not a real date`;
}

function dayWithOptionalYear(
  d: number,
  m: number,
  year: string | undefined,
  today: JournalDay,
  raw: string,
): JournalDay | string {
  if (year !== undefined) return realDay(Number(year), m, d, raw);
  const thisYear = Math.floor(today / 10000);
  // Validate against a leap year too, so "29.2." is a real date in a year that has one.
  const candidate = realDay(thisYear, m, d, raw);
  if (typeof candidate === "number" && candidate >= today) return candidate;
  const next = realDay(thisYear + 1, m, d, raw);
  if (typeof next === "number") return next;
  return typeof candidate === "number" ? candidate : `"${raw}" is not a real date`;
}

// ── Calendar arithmetic on YYYYMMDD, in the local calendar (a journal day has no timezone) ─────

export function addDays(day: JournalDay, n: number): JournalDay {
  const d = journalDayToDate(day);
  d.setDate(d.getDate() + n);
  return dateToJournalDay(d);
}

/** Calendar months, clamped: Jan 31 + 1 month is Feb 28/29, not Mar 3 (what `Date#setMonth`
 * alone gives), matching `task-logic.ts`'s "the 10th, not +30 days" repeat rule in spirit. */
export function addMonths(day: JournalDay, n: number): JournalDay {
  const y = Math.floor(day / 10000);
  const m = Math.floor(day / 100) % 100;
  const d = day % 100;
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(ny, nm, 0).getDate();
  return ny * 10000 + nm * 100 + Math.min(d, last);
}

function addUnits(day: JournalDay, n: number, unit: "d" | "w" | "m" | "y"): JournalDay {
  switch (unit) {
    case "d":
      return addDays(day, n);
    case "w":
      return addDays(day, n * 7);
    case "m":
      return addMonths(day, n);
    case "y":
      return addMonths(day, n * 12);
  }
}

/** Monday-first, like the journal calendar and the `[[` "Next week" shortcut. */
export function weekdayIndex(day: JournalDay): number {
  return (journalDayToDate(day).getDay() + 6) % 7;
}

function mondayOf(day: JournalDay): JournalDay {
  return addDays(day, -weekdayIndex(day));
}

function nextWeekday(today: JournalDay, weekday: number): JournalDay {
  const ahead = (weekday - weekdayIndex(today) + 7) % 7 || 7;
  return addDays(today, ahead);
}

function firstOfMonth(day: JournalDay, monthOffset: number): JournalDay {
  return addMonths(Math.floor(day / 100) * 100 + 1, monthOffset);
}

// ── The stored value (ADR 011) ─────────────────────────────────────────────────────────────────

/** `YYYYMMDD` + optional `HH:MM` → exactly `YYYY-MM-DD[ HH:MM]`, the only form the reducer takes. */
export function formatStoredDate(day: JournalDay, time: string | null | undefined): string {
  const s = String(day).padStart(8, "0");
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return time ? `${iso} ${time}` : iso;
}

/** The inverse: a stored `YYYY-MM-DD[ HH:MM]` → its parts, or `undefined` for anything else. */
export function parseStoredDate(
  value: string | null | undefined,
): { day: JournalDay; time: string | null } | undefined {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/.exec(value) : null;
  if (!m) return undefined;
  const day = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  if (!isValidJournalDay(day)) return undefined;
  return { day, time: m[4] ?? null };
}
