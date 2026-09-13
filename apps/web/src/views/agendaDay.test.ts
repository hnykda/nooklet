/**
 * The "Scheduled and deadline" section's rules (PLAN.md §8), pure: which open dated tasks and
 * dated non-task blocks a day lists, overdue only on today and only for tasks, both dates counted,
 * the day's own page left out, grouped by page, overdue entries past ten held back.
 */

import { describe, expect, it } from "vitest";
import type { AgendaTask } from "../data/agenda.js";
import { agendaForDay, agendaSection, OVERDUE_SHOWN } from "./agendaDay.js";

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
    // `in`, not `??`: an explicit `marker: null` is a block that is not a task.
    marker: "marker" in over ? (over.marker ?? null) : "TODO",
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

  it("lists a dated block that is not a task on its exact day, and never as overdue", () => {
    const tasks = [
      task({ content: "note today", marker: null, scheduledDay: TODAY, order: "b" }),
      task({ content: "note due on the 10th", marker: null, deadlineDay: 20260910 }),
      task({ content: "note scheduled last week", marker: null, scheduledDay: 20260906 }),
      task({ content: "task last week", scheduledDay: 20260906 }),
      task({
        content: "note both",
        marker: null,
        order: "c",
        scheduledDay: 20260901,
        deadlineDay: TODAY,
      }),
    ];
    expect(ids(agendaForDay(tasks, TODAY, TODAY))).toEqual([
      "task last week",
      "note today",
      "note both",
    ]);
    // Only today's date put it here: the earlier one is not shown as overdue.
    expect(
      agendaForDay(tasks, TODAY, TODAY)
        .flatMap((g) => g.entries)
        .find((e) => e.task.content === "note both")?.dates,
    ).toEqual([{ kind: "deadline", day: TODAY, time: null, overdue: false }]);
    expect(ids(agendaForDay(tasks, 20260910, TODAY))).toEqual(["note due on the 10th"]);
    expect(ids(agendaForDay(tasks, 20260906, TODAY))).toEqual([
      "note scheduled last week",
      "task last week",
    ]);
  });
});

describe("agendaSection — overdue entries past OVERDUE_SHOWN", () => {
  const overdue = (n: number): AgendaTask[] =>
    Array.from({ length: n }, (_, i) =>
      task({
        content: `late ${i + 1}`,
        page: i % 2 === 0 ? "Even" : "Odd",
        // Oldest first: late 1 is the most overdue.
        scheduledDay: 20260801 + i,
      }),
    );

  it("keeps the first ten overdue in list order and counts the rest", () => {
    expect(OVERDUE_SHOWN).toBe(10);
    const tasks = [...overdue(13), task({ content: "due today", page: "Odd", deadlineDay: TODAY })];
    const all = agendaSection(tasks, TODAY, TODAY);
    expect(all).toMatchObject({ overdue: 13, hidden: 0 });
    expect(ids(all.groups)).toHaveLength(14);

    const few = agendaSection(tasks, TODAY, TODAY, { overdueLimit: OVERDUE_SHOWN });
    expect(few).toMatchObject({ overdue: 13, hidden: 3 });
    const shown = few.groups.flatMap((g) => g.entries.map((e) => e.task.content));
    expect(shown.sort()).toEqual(
      [...Array.from({ length: 10 }, (_, i) => `late ${i + 1}`), "due today"].sort(),
    );
    // What is shown is what the full list shows, in the same order within each page.
    for (const g of few.groups) {
      const full = all.groups.find((a) => a.pageId === g.pageId);
      const order = full?.entries.map((e) => e.task.content) ?? [];
      const mine = g.entries.map((e) => e.task.content);
      expect(mine).toEqual(order.filter((c) => mine.includes(c)));
    }
  });

  it("never holds back a task also due today, or anything on another day", () => {
    const tasks = [
      ...overdue(12),
      task({ content: "late but due today", scheduledDay: 20260701, deadlineDay: TODAY }),
    ];
    const few = agendaSection(tasks, TODAY, TODAY, { overdueLimit: OVERDUE_SHOWN });
    expect(few).toMatchObject({ overdue: 12, hidden: 2 });
    expect(ids(few.groups)).toContain("late but due today");
    expect(agendaSection(tasks, 20260805, TODAY, { overdueLimit: 0 })).toMatchObject({
      overdue: 0,
      hidden: 0,
    });
  });

  it("ten or fewer overdue: nothing held back", () => {
    expect(agendaSection(overdue(10), TODAY, TODAY, { overdueLimit: OVERDUE_SHOWN })).toMatchObject(
      { overdue: 10, hidden: 0 },
    );
  });
});
