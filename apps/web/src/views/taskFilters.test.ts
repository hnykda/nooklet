import { describe, expect, it } from "vitest";
import type { TaskRow } from "../data/types.js";
import { filterTasks, groupTasksByPage, sortTasksByDue, taskDateLabels } from "./taskFilters.js";

function task(overrides: Partial<TaskRow> & Pick<TaskRow, "id" | "pageId" | "pageName">): TaskRow {
  return {
    graphId: "default",
    parentId: null,
    order: "a",
    content: "",
    marker: "TODO",
    priority: null,
    collapsed: false,
    scheduledDay: null,
    scheduledTime: null,
    deadlineDay: null,
    deadlineTime: null,
    repeat: null,
    doneAt: null,
    dueDay: null,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    placeHlc: "2026-09-10T00:00:00.000Z-0000-aaaaaaaa",
    contentHlc: "2026-09-10T00:00:00.000Z-0000-aaaaaaaa",
    markerHlc: null,
    priorityHlc: null,
    collapsedHlc: null,
    scheduledHlc: null,
    deadlineHlc: null,
    repeatHlc: null,
    doneHlc: null,
    deletedHlc: null,
    pageJournalDay: null,
    ...overrides,
  };
}

describe("filterTasks", () => {
  const tasks = [
    task({
      id: "t1",
      pageId: "p1",
      pageName: "Projects/Aurora",
      marker: "TODO",
      content: "Ship it #launch",
    }),
    task({
      id: "t2",
      pageId: "p1",
      pageName: "Projects/Aurora",
      marker: "DOING",
      content: "No tag here",
    }),
    task({
      id: "t3",
      pageId: "p2",
      pageName: "Vendors/Acme",
      marker: "WAITING",
      content: "Waiting on #launch reply",
    }),
    task({
      id: "t4",
      pageId: "p3",
      pageName: "Personal",
      marker: "TODO",
      content: "Buy milk",
      scheduledDay: 20260915,
      dueDay: 20260915,
    }),
  ];

  it("with no filters, returns every open task unchanged", () => {
    expect(filterTasks(tasks, {})).toHaveLength(4);
  });

  it("filters by state", () => {
    const result = filterTasks(tasks, { states: ["DOING"] });
    expect(result.map((t) => t.id)).toEqual(["t2"]);
  });

  it("filters by tag, case-insensitively, matching content-derived tags only", () => {
    const result = filterTasks(tasks, { tag: "LAUNCH" });
    expect(result.map((t) => t.id).sort()).toEqual(["t1", "t3"]);
  });

  it("filters by namespace (page itself and descendants)", () => {
    const result = filterTasks(tasks, { namespace: "Projects" });
    expect(result.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("filters by a scheduled/deadline window, excluding tasks with no due date", () => {
    const result = filterTasks(tasks, { dueFrom: 20260901, dueTo: 20260930 });
    expect(result.map((t) => t.id)).toEqual(["t4"]);
  });

  // B-171: `due_day` is `coalesce(scheduled_day, deadline_day)`, so a window compared against it
  // alone never saw the deadline of a task that is also scheduled.
  describe("the due window looks at the scheduled date AND the deadline", () => {
    const both = task({
      id: "both",
      pageId: "p",
      pageName: "P",
      scheduledDay: 20260901,
      deadlineDay: 20260920,
      dueDay: 20260901,
    });
    const deadlineOnly = task({
      id: "deadline",
      pageId: "p",
      pageName: "P",
      deadlineDay: 20260920,
      dueDay: 20260920,
    });
    const ids = (filters: Parameters<typeof filterTasks>[1]) =>
      filterTasks([both, deadlineOnly], filters).map((t) => t.id);

    it("a deadline inside the window matches although the scheduled date is outside it", () => {
      expect(ids({ dueFrom: 20260915, dueTo: 20260925 })).toEqual(["both", "deadline"]);
    });

    it("a scheduled date inside the window matches although the deadline is outside it", () => {
      expect(ids({ dueFrom: 20260825, dueTo: 20260905 })).toEqual(["both"]);
    });

    it("one date must satisfy both bounds: dates either side of a window are not a match", () => {
      expect(ids({ dueFrom: 20260905, dueTo: 20260915 })).toEqual([]);
    });

    it("an open-ended bound matches on either date", () => {
      expect(ids({ dueFrom: 20260910 })).toEqual(["both", "deadline"]);
      expect(ids({ dueTo: 20260901 })).toEqual(["both"]);
    });
  });

  it("combines filters", () => {
    const result = filterTasks(tasks, { states: ["TODO"], namespace: "Projects" });
    expect(result.map((t) => t.id)).toEqual(["t1"]);
  });
});

// B-324: the row showed `dueDay` alone — the scheduled date whenever there is one — so a task the
// window found by its deadline was labelled with a date outside that window.
describe("taskDateLabels", () => {
  const base = { scheduledDay: null, scheduledTime: null, deadlineDay: null, deadlineTime: null };

  it("labels both dates when a task is scheduled and has a deadline, scheduled first", () => {
    expect(taskDateLabels({ ...base, scheduledDay: 20310301, deadlineDay: 20310320 })).toEqual([
      { kind: "scheduled", label: "Scheduled 2031-03-01" },
      { kind: "deadline", label: "Deadline 2031-03-20" },
    ]);
  });

  it("labels a lone date with its kind, and adds a time when there is one", () => {
    expect(taskDateLabels({ ...base, deadlineDay: 20260920, deadlineTime: "14:00" })).toEqual([
      { kind: "deadline", label: "Deadline 2026-09-20 14:00" },
    ]);
    expect(taskDateLabels({ ...base, scheduledDay: 20260901 })).toEqual([
      { kind: "scheduled", label: "Scheduled 2026-09-01" },
    ]);
    expect(taskDateLabels(base)).toEqual([]);
  });
});

describe("sortTasksByDue", () => {
  it("sorts ascending by due day, with no-due-date tasks last", () => {
    const tasks = [
      task({ id: "a", pageId: "p", pageName: "P", dueDay: 20260920 }),
      task({ id: "b", pageId: "p", pageName: "P", dueDay: null }),
      task({ id: "c", pageId: "p", pageName: "P", dueDay: 20260910 }),
    ];
    expect(sortTasksByDue(tasks).map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("breaks ties on id for determinism", () => {
    const tasks = [
      task({ id: "b", pageId: "p", pageName: "P", dueDay: 20260910 }),
      task({ id: "a", pageId: "p", pageName: "P", dueDay: 20260910 }),
    ];
    expect(sortTasksByDue(tasks).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("groupTasksByPage", () => {
  it("groups by page, preserving each page's first-appearance position in a sorted list", () => {
    const sorted = [
      task({ id: "t1", pageId: "p2", pageName: "Vendors/Acme", dueDay: 20260910 }),
      task({ id: "t2", pageId: "p1", pageName: "Projects/Aurora", dueDay: 20260912 }),
      task({ id: "t3", pageId: "p2", pageName: "Vendors/Acme", dueDay: 20260915 }),
    ];
    const groups = groupTasksByPage(sorted);
    expect(groups.map((g) => g.pageName)).toEqual(["Vendors/Acme", "Projects/Aurora"]);
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(groups[1]?.tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("returns nothing for no tasks", () => {
    expect(groupTasksByPage([])).toEqual([]);
  });
});
