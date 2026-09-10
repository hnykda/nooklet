import { describe, expect, it } from "vitest";
import type { TaskRow } from "../data/types.js";
import { filterTasks, groupTasksByPage, sortTasksByDue } from "./taskFilters.js";

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

  it("combines filters", () => {
    const result = filterTasks(tasks, { states: ["TODO"], namespace: "Projects" });
    expect(result.map((t) => t.id)).toEqual(["t1"]);
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
