import { format, isValid, parse } from "date-fns";

/** Journal day as YYYYMMDD integer (local calendar date, no timezone). */
export type JournalDay = number;

export function dateToJournalDay(d: Date): JournalDay {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function journalDayToDate(day: JournalDay): Date {
  const y = Math.floor(day / 10000);
  const m = Math.floor((day % 10000) / 100);
  const d = day % 100;
  return new Date(y, m - 1, d);
}

export function isValidJournalDay(day: number): boolean {
  if (!Number.isInteger(day) || day < 10000101 || day > 99991231) return false;
  const dt = journalDayToDate(day);
  return dateToJournalDay(dt) === day;
}

export function todayJournalDay(now: Date = new Date()): JournalDay {
  return dateToJournalDay(now);
}

/** Logseq journal file names: journals/2026_09_10.md (also accepts 2026-09-10). */
export function journalDayFromFileName(base: string): JournalDay | null {
  const m = /^(\d{4})[_-](\d{2})[_-](\d{2})$/.exec(base);
  if (!m) return null;
  const day = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  return isValidJournalDay(day) ? day : null;
}

export function journalDayToFileName(day: JournalDay): string {
  return format(journalDayToDate(day), "yyyy_MM_dd");
}

/** Default title format is Logseq's default ("Sep 10th, 2026"). date-fns tokens. */
export const DEFAULT_JOURNAL_TITLE_FORMAT = "MMM do, yyyy";

export function formatJournalTitle(
  day: JournalDay,
  pattern: string = DEFAULT_JOURNAL_TITLE_FORMAT,
): string {
  return format(journalDayToDate(day), pattern);
}

/**
 * The name a journal page is STORED under (ADR 018): the ISO date, always, whatever format the
 * user chooses to read it in. `2026-09-07`.
 *
 * Not `formatJournalTitle(day)` with some pattern — that is a display concern, and a display
 * concern that leaks into storage is what B-22 was: a graph written with `EEEE, dd.MM.yyyy` stored
 * pages the API then handed out as ISO, so half the system could not find the other half.
 */
export function isoJournalName(day: JournalDay): string {
  const s = String(day).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * The canonical name for a page reference: a journal day written in ANY recognised title format
 * collapses to its ISO name, everything else passes through untouched.
 *
 * This is what makes `[[Mon, 07.09.2026]]`, `[[Sep 7th, 2026]]` and `[[2026-09-07]]` one
 * reference rather than three. Note it is deliberately *not* applied to page names on creation —
 * there the journal day is known outright (`isoJournalName`) and guessing from the string would
 * turn an ordinary page honestly named `11.12.2024` into a journal.
 */
export function canonicalRefName(name: string): string {
  const day = parseJournalTitle(name);
  return day === null ? name : isoJournalName(day);
}

/**
 * Title formats we try when resolving a page reference to a journal day.
 * Covers Logseq's default, common custom formats, and ISO.
 */
export const JOURNAL_TITLE_FORMATS: readonly string[] = [
  "MMM do, yyyy",
  "MMMM do, yyyy",
  "MMM d, yyyy",
  "MMMM d, yyyy",
  "yyyy-MM-dd",
  "yyyy_MM_dd",
  "yyyy/MM/dd",
  "dd.MM.yyyy",
  "do MMM yyyy",
  "do MMMM yyyy",
  "E, dd.MM.yyyy",
  "EEEE, dd.MM.yyyy",
  "E, MMM do, yyyy",
  "EEEE, MMM do, yyyy",
  "E, yyyy-MM-dd",
  "EEEE, yyyy-MM-dd",
];

const WEEKDAY_PREFIX = /^[a-z]{2,9},\s+/i;

/** Parse a page name as a journal title. Returns null when it is not a date. */
export function parseJournalTitle(
  name: string,
  formats: readonly string[] = JOURNAL_TITLE_FORMATS,
): JournalDay | null {
  const candidates = [name.trim()];
  const stripped = name.trim().replace(WEEKDAY_PREFIX, "");
  if (stripped !== candidates[0]) candidates.push(stripped);
  const ref = new Date(2000, 0, 1);
  for (const candidate of candidates) {
    if (!/\d/.test(candidate)) continue;
    for (const fmt of formats) {
      const d = parse(candidate, fmt, ref);
      if (isValid(d) && d.getFullYear() >= 1000 && d.getFullYear() <= 9999) {
        return dateToJournalDay(d);
      }
    }
  }
  return null;
}
