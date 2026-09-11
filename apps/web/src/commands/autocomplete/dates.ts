/**
 * The date shortcuts `[[` offers before you have typed anything — Logseq's behaviour, and the
 * reason it is worth copying: linking to "tomorrow" is one of the most common things anyone does
 * in a journal, and spelling out the title format by hand is tedious and easy to get wrong.
 *
 * Each entry resolves to a journal DAY; the caller turns that into whatever title format the graph
 * uses (`formatJournalTitle`), so these never hard-code a format.
 */

import { dateToJournalDay, type JournalDay } from "@nooklet/core";

export interface DateShortcut {
  id: string;
  label: string;
  day: JournalDay;
}

function shift(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

/** Monday of the week containing `base`, matching the ISO week the journal stream uses. */
function startOfWeek(base: Date): Date {
  const d = new Date(base);
  const weekday = (d.getDay() + 6) % 7; // Monday = 0
  return shift(d, -weekday);
}

function startOfMonth(base: Date, monthOffset: number): Date {
  return new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);
}

export function dateShortcuts(now: Date = new Date()): DateShortcut[] {
  const entries: Array<[string, Date]> = [
    ["Today", now],
    ["Tomorrow", shift(now, 1)],
    ["Yesterday", shift(now, -1)],
    ["Next week", shift(startOfWeek(now), 7)],
    ["This week", startOfWeek(now)],
    ["Last week", shift(startOfWeek(now), -7)],
    ["Next month", startOfMonth(now, 1)],
    ["This month", startOfMonth(now, 0)],
    ["Last month", startOfMonth(now, -1)],
    ["Next year", new Date(now.getFullYear() + 1, 0, 1)],
  ];
  return entries.map(([label, date]) => ({
    id: `date:${label}`,
    label,
    day: dateToJournalDay(date),
  }));
}
