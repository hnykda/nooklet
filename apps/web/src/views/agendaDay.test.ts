/**
 * The "Scheduled and deadline" section's rules (PLAN.md §8), pure: which open dated tasks a day
 * lists, overdue only on today, both dates counted, the day's own page left out, grouped by page.
 */

import { describe, expect, it } from "vitest";
import type { AgendaTask } from "../data/agenda.js";
import { agendaForDay } from "./agendaDay.js";

const TODAY = 20260913;

let seq = 0;
function task(over: Partial<AgendaTask> & { page?: string }): AgendaTask {
  seq++;
  const page = over.page ?? "Project";
  return {
    id: over.id ?? `t${String(seq).padStart(3, "0")}`,
    pageId: over.pageId ?? `p-${page}`,
    pageName: over.pageName ?? page,
    pageJournalDay: over.pageJournalDay ?? null,
    order: over.order ?? `a${seq}`,
    content: over.content ?? `task ${seq}`,
    marker: over.marker ?? "TODO",
    priority: over.priority ?? null,
    scheduledDay: over.scheduledDay ?? null,
    scheduledTime: over.scheduledTime ?? null,
    deadlineDay: over.deadlineDay ?? null,
    deadlineTime: over.deadlineTime ?? null,
  };
}

function ids(groups: ReturnType<typeof agendaForDay>): string[] {
  return groups.flatMap((g) => g.entries.map((e) => e.task.content));
}

describe("agendaForDay", () => {
  it("today lists what is scheduled or due today plus everything overdue", () => {
    const tasks = [
      task({ content: "scheduled today", scheduledDay: TODAY }),
      task({ content: "due today", deadlineDay: TODAY }),
      task({ content: "scheduled last week", scheduledDay: 20260906 }),
      task({ content: "deadline yesterday", deadlineDay: 20260912 }),
      task({ content: "tomorrow", scheduledDay: 20260914 }),
      task({ content: "next month", deadlineDay: 20261013 }),
    ];
    expect(ids(agendaForDay(tasks, TODAY, TODAY))).toEqual([
      "scheduled last week",
      "deadline yesterday",
      "scheduled today",
      "due today",
    ]);
  });

  it("any other day lists only what is scheduled or due that day — nothing overdue", () => {
    const tasks = [
      task({ content: "on the 10th", scheduledDay: 20260910 }),
      task({ content: "before the 10th", scheduledDay: 20260905 }),
      task({ content: "tomorrow", deadlineDay: 20260914 }),
    ];
    expect(ids(agendaForDay(tasks, 20260910, TODAY))).toEqual(["on the 10th"]);
    expect(ids(agendaForDay(tasks, 20260914, TODAY))).toEqual(["tomorrow"]);
    expect(agendaForDay(tasks, 20260920, TODAY)).toEqual([]);
  });

  it("counts the deadline on its own day even when the task is also scheduled (B-171)", () => {
    const both = task({ content: "both", scheduledDay: 20260915, deadlineDay: 20260920 });
    expect(ids(agendaForDay([both], 20260915, TODAY))).toEqual(["both"]);
    expect(ids(agendaForDay([both], 20260920, TODAY))).toEqual(["both"]);
    expect(agendaForDay([both], 20260915, TODAY)[0]?.entries[0]?.dates).toEqual([
      { kind: "scheduled", day: 20260915, time: null, overdue: false },
    ]);
    expect(agendaForDay([both], 20260920, TODAY)[0]?.entries[0]?.dates).toEqual([
      { kind: "deadline", day: 20260920, time: null, overdue: false },
    ]);
  });

  it("marks overdue dates, and lists a task once even when both its dates qualify", () => {
    const t = task({
      content: "late twice",
      scheduledDay: 20260901,
      deadlineDay: TODAY,
      deadlineTime: "17:00",
    });
    const groups = agendaForDay([t], TODAY, TODAY);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.entries[0]?.dates).toEqual([
      { kind: "scheduled", day: 20260901, time: null, overdue: true },
      { kind: "deadline", day: TODAY, time: "17:00", overdue: false },
    ]);
  });

  it("leaves out tasks that live on the day's own journal page", () => {
    const tasks = [
      task({
        content: "written today",
        page: "2026-09-13",
        pageJournalDay: TODAY,
        scheduledDay: TODAY,
      }),
      task({
        content: "written today, overdue",
        page: "2026-09-13",
        pageJournalDay: TODAY,
        deadlineDay: 20260901,
      }),
      task({
        content: "from yesterday's page",
        page: "2026-09-12",
        pageJournalDay: 20260912,
        scheduledDay: TODAY,
      }),
    ];
    expect(ids(agendaForDay(tasks, TODAY, TODAY))).toEqual(["from yesterday's page"]);
    // The same task is listed on another day's section, where it is not on screen already.
    expect(ids(agendaForDay([tasks[0] as AgendaTask], TODAY, 20260910))).toEqual([]);
  });

  it("groups by page in the order each page's first entry sorts, keeping entry order inside", () => {
    const tasks = [
      task({ content: "B late", page: "Beta", scheduledDay: 20260910 }),
      task({
        content: "A today 09:00",
        page: "Alpha",
        scheduledDay: TODAY,
        scheduledTime: "09:00",
      }),
      task({ content: "A oldest", page: "Alpha", deadlineDay: 20260801 }),
      task({ content: "B today untimed", page: "Beta", scheduledDay: TODAY }),
      task({ content: "A today 08:00", page: "Alpha", deadlineDay: TODAY, deadlineTime: "08:00" }),
    ];
    const groups = agendaForDay(tasks, TODAY, TODAY);
    expect(groups.map((g) => g.pageName)).toEqual(["Alpha", "Beta"]);
    expect(groups[0]?.entries.map((e) => e.task.content)).toEqual([
      "A oldest",
      "A today 08:00",
      "A today 09:00",
    ]);
    expect(groups[1]?.entries.map((e) => e.task.content)).toEqual(["B late", "B today untimed"]);
  });

  it("is empty when nothing qualifies, so the section can hide", () => {
    expect(agendaForDay([], TODAY, TODAY)).toEqual([]);
    expect(agendaForDay([task({ scheduledDay: 20261231 })], TODAY, TODAY)).toEqual([]);
  });
});
