/**
 * Which dated blocks a journal day's "Scheduled and deadline" section lists (PLAN.md §8), as pure
 * array code over `../data/agenda.ts`'s rows — no DOM, no SQL, so every rule below is a unit test
 * (`agendaDay.test.ts`).
 *
 * - On TODAY: open tasks and non-task blocks scheduled for or due today, plus overdue TASKS — any
 *   open task whose scheduled or deadline day has already passed. Past the first
 *   `OVERDUE_SHOWN` of those, the rest wait behind "Show all N overdue" (`agendaSection`).
 * - On any other day, past or future: open tasks and non-task blocks scheduled for or due on that
 *   day.
 * - A block that is not a task is listed on its exact day only, never as overdue: it has nothing
 *   to complete, so it would stay under today forever.
 *
 * Both dates count on their own. A task scheduled for the 1st with a deadline on the 20th appears
 * on both days; comparing `due_day` (= `coalesce(scheduled, deadline)`) instead, the way the
 * Tasks view's window filter does, would hide it on the 20th (B-171).
 *
 * A task that lives on the day's own journal page is left out: it is already on screen directly
 * above the section, and repeating it made the section a copy of the page rather than a view of
 * what the rest of the graph has due.
 */

import type { AgendaTask } from "../data/agenda.js";

export type AgendaDateKind = "scheduled" | "deadline";

export interface AgendaDate {
  kind: AgendaDateKind;
  day: number;
  time: string | null;
  /** Before today, on today's section. Never true on any other day's section. */
  overdue: boolean;
}

export interface AgendaEntry {
  task: AgendaTask;
  /** The dates that put this task on this day, scheduled before deadline. */
  dates: AgendaDate[];
}

export interface AgendaGroup {
  pageId: string;
  pageName: string;
  pageJournalDay: number | null;
  entries: AgendaEntry[];
}

function relevantDates(task: AgendaTask, day: number, today: number): AgendaDate[] {
  const out: AgendaDate[] = [];
  const consider = (kind: AgendaDateKind, d: number | null, time: string | null): void => {
    if (d === null) return;
    if (d === day) out.push({ kind, day: d, time, overdue: false });
    else if (task.marker !== null && day === today && d < today) {
      out.push({ kind, day: d, time, overdue: true });
    }
  };
  consider("scheduled", task.scheduledDay, task.scheduledTime);
  consider("deadline", task.deadlineDay, task.deadlineTime);
  return out;
}

/** "HH:MM" sorts correctly as a string; an untimed date sorts after the timed ones that day. */
function sortKey(e: AgendaEntry): [number, string] {
  let best: AgendaDate | undefined;
  for (const d of e.dates) {
    if (!best || d.day < best.day || (d.day === best.day && (d.time ?? "~") < (best.time ?? "~"))) {
      best = d;
    }
  }
  return best ? [best.day, best.time ?? "~"] : [0, "~"];
}

function compareEntries(a: AgendaEntry, b: AgendaEntry): number {
  const [ad, at] = sortKey(a);
  const [bd, bt] = sortKey(b);
  if (ad !== bd) return ad - bd;
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.task.pageId === b.task.pageId && a.task.order !== b.task.order) {
    return a.task.order < b.task.order ? -1 : 1;
  }
  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
}

/** How many overdue entries today's section lists before the rest wait behind "Show all N
 * overdue" (owner's call, 2026-09-13: a neglected graph put hundreds under Today). */
export const OVERDUE_SHOWN = 10;

export interface AgendaSection {
  groups: AgendaGroup[];
  /** Entries listed only for being overdue — every date that puts them here is before today. */
  overdue: number;
  /** How many of those `groups` leaves out: past `overdueLimit`, 0 without one. */
  hidden: number;
}

/**
 * The section for `day`, grouped by page. Entries are ordered oldest date first (so the most
 * overdue task leads today's list), then by time; a page's group sits where its first entry
 * sorted. Empty when there is nothing to show — the section is hidden then.
 *
 * `overdueLimit` keeps only the first that many overdue-only entries in that order — the prefix
 * of the full list, so showing all of them adds rows and never reorders the ones on screen. An
 * entry also due today is not overdue-only and is always listed.
 */
export function agendaSection(
  tasks: readonly AgendaTask[],
  day: number,
  today: number,
  opts: { overdueLimit?: number } = {},
): AgendaSection {
  const entries: AgendaEntry[] = [];
  for (const task of tasks) {
    if (task.pageJournalDay === day) continue;
    const dates = relevantDates(task, day, today);
    if (dates.length > 0) entries.push({ task, dates });
  }
  entries.sort(compareEntries);

  let overdue = 0;
  let hidden = 0;
  const groups: AgendaGroup[] = [];
  const byPage = new Map<string, AgendaGroup>();
  for (const e of entries) {
    if (e.dates.every((d) => d.overdue)) {
      overdue++;
      if (opts.overdueLimit !== undefined && overdue > opts.overdueLimit) {
        hidden++;
        continue;
      }
    }
    let g = byPage.get(e.task.pageId);
    if (!g) {
      g = {
        pageId: e.task.pageId,
        pageName: e.task.pageName,
        pageJournalDay: e.task.pageJournalDay,
        entries: [],
      };
      byPage.set(e.task.pageId, g);
      groups.push(g);
    }
    g.entries.push(e);
  }
  return { groups, overdue, hidden };
}

/** `agendaSection`'s groups, every overdue entry included. */
export function agendaForDay(
  tasks: readonly AgendaTask[],
  day: number,
  today: number,
): AgendaGroup[] {
  return agendaSection(tasks, day, today).groups;
}
