/**
 * What a block's scheduled/deadline chips say and how loud they are (B-102). Pure: `today` is
 * passed in, so the whole table below is unit-testable without a clock or a DOM.
 *
 * Why chips at all: `scheduled::`/`deadline::` are typed columns (ADR 011), not text, so the
 * editor buffer never shows them — before this, the only place a person could see a task's date
 * was the Tasks view, and a "TODO call mom" scheduled for yesterday looked exactly like one with
 * no date.
 *
 * Tone rules, in order:
 * - a closed task (DONE/CANCELED) is muted whatever its date: it no longer asks for anything;
 * - a date before today is `overdue` on an open task, and merely `past` on a block that is not a
 *   task — red on a plain note would be an alarm about nothing;
 * - today is `today`; anything later is `upcoming`.
 * Day granularity only, like the query language's date filters: 09:00 today is "today" at noon.
 */
import { formatJournalTitle, type JournalDay, journalDayToDate } from "@nooklet/core";
import { parseStoredDate } from "../commands/date-picker/parse.js";

export type DateChipField = "scheduled" | "deadline";
export type DateChipTone = "overdue" | "today" | "upcoming" | "past" | "closed";

export interface DateChip {
  field: DateChipField;
  /** The stored value, `YYYY-MM-DD[ HH:MM]`. */
  value: string;
  label: string;
  tone: DateChipTone;
  /** Tooltip / accessible name: the exact value, the tone in words, and what a click does. */
  title: string;
}

const CLOSED_MARKERS = new Set(["DONE", "CANCELED", "CANCELLED"]);

function daysBetween(from: JournalDay, to: JournalDay): number {
  return Math.round(
    (journalDayToDate(to).getTime() - journalDayToDate(from).getTime()) / 86_400_000,
  );
}

/** Short and relative where relative reads faster: Today, Tomorrow, Yesterday, the weekday for
 * the rest of the coming week, then `Sep 20`, and `Sep 20, 2027` outside the current year. */
export function dateChipLabel(day: JournalDay, time: string | null, today: JournalDay): string {
  const diff = daysBetween(today, day);
  let label: string;
  if (diff === 0) label = "Today";
  else if (diff === 1) label = "Tomorrow";
  else if (diff === -1) label = "Yesterday";
  else if (diff > 1 && diff < 7) label = formatJournalTitle(day, "EEE");
  else if (Math.floor(day / 10000) === Math.floor(today / 10000))
    label = formatJournalTitle(day, "MMM d");
  else label = formatJournalTitle(day, "MMM d, yyyy");
  return time ? `${label} ${time}` : label;
}

export function dateChipTone(
  day: JournalDay,
  marker: string | null,
  today: JournalDay,
): DateChipTone {
  if (marker !== null && CLOSED_MARKERS.has(marker)) return "closed";
  if (day < today) return marker !== null ? "overdue" : "past";
  if (day === today) return "today";
  return "upcoming";
}

const FIELD_WORD: Record<DateChipField, string> = { scheduled: "Scheduled", deadline: "Deadline" };

export function dateChips(
  block: { scheduled: string | null; deadline: string | null; marker: string | null },
  today: JournalDay,
): DateChip[] {
  const out: DateChip[] = [];
  for (const field of ["scheduled", "deadline"] as const) {
    const value = block[field];
    const parsed = parseStoredDate(value);
    if (!value || !parsed) continue;
    const tone = dateChipTone(parsed.day, block.marker, today);
    const late = tone === "overdue" ? `, overdue by ${daysBetween(parsed.day, today)}d` : "";
    out.push({
      field,
      value,
      label: dateChipLabel(parsed.day, parsed.time, today),
      tone,
      title: `${FIELD_WORD[field]} ${value}${late} — click to change`,
    });
  }
  return out;
}
