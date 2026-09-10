/**
 * Pure filter/sort/group logic for the Tasks view (BUILD item 5; PLAN.md §8: "open tasks grouped
 * by page with filters (state, tag, scheduled/deadline window, page/namespace) ... sorted by due
 * date"). Split out from `views/TasksView.tsx` so it is testable with no DOM/component and no
 * SQL/worker at all (`taskFilters.test.ts`) — `../data/store.ts#useOpenTasks` hands over every
 * open task once (already a cheap, indexed local query per docs/spec/sql-schema.md rule 9); all
 * filtering/sorting/grouping below is plain array code over that snapshot.
 *
 * Tag filtering is a deliberate simplification: the client-only schema has no `ref` table
 * (docs/spec/sql-schema.md rule 1 — refs are server-only derived data), so "tag" here means
 * `extractRefs` finds `#tag`/`#[[tag]]` directly in the block's own `content` — a block whose only
 * tag comes from a `tags::` property line is not matched. Noted in the task summary.
 */
import { extractRefs, normalizePageName, type TaskMarker } from "@nooklet/core";
import type { TaskRow } from "../data/types.js";

export const OPEN_TASK_STATES: readonly TaskMarker[] = ["TODO", "DOING", "LATER", "NOW", "WAITING"];

export interface TaskFilters {
  /** Empty/undefined = every open state. */
  states?: readonly TaskMarker[];
  /** Case-insensitive; matches `#tag`/`#[[tag]]` found in the block's own content. */
  tag?: string;
  /** Matches the task's page itself or any of its namespace descendants. */
  namespace?: string;
  /** Inclusive `due_day` (YYYYMMDD) window. A task with no scheduled/deadline date is excluded by
   * either bound (it has nothing to compare). */
  dueFrom?: number;
  dueTo?: number;
}

export function filterTasks(tasks: readonly TaskRow[], filters: TaskFilters): TaskRow[] {
  const wantedStates =
    filters.states && filters.states.length > 0 ? new Set(filters.states) : undefined;
  const wantedTag = filters.tag?.trim().toLowerCase() || undefined;
  const wantedNamespace = filters.namespace ? normalizePageName(filters.namespace) : undefined;

  return tasks.filter((t) => {
    if (wantedStates && (t.marker === null || !wantedStates.has(t.marker))) return false;

    if (wantedTag) {
      const tags = extractRefs(t.content).tags.map((tag) => tag.toLowerCase());
      if (!tags.includes(wantedTag)) return false;
    }

    if (wantedNamespace) {
      const pageKey = normalizePageName(t.pageName);
      if (pageKey !== wantedNamespace && !pageKey.startsWith(`${wantedNamespace}/`)) return false;
    }

    if (filters.dueFrom !== undefined && (t.dueDay === null || t.dueDay < filters.dueFrom))
      return false;
    if (filters.dueTo !== undefined && (t.dueDay === null || t.dueDay > filters.dueTo))
      return false;

    return true;
  });
}

/** Sorted by due date ascending, tasks with no scheduled/deadline date last (matches
 * docs/spec/sql-schema.md rule 9's `ORDER BY due_day IS NULL, due_day, id`). */
export function sortTasksByDue(tasks: readonly TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => {
    if (a.dueDay === null && b.dueDay === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (a.dueDay === null) return 1;
    if (b.dueDay === null) return -1;
    if (a.dueDay !== b.dueDay) return a.dueDay - b.dueDay;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface TaskGroup {
  pageId: string;
  pageName: string;
  pageJournalDay: number | null;
  tasks: TaskRow[];
}

/** Group an already-sorted task list by page, preserving each page's first appearance in the
 * input order — i.e. "grouped by page" without losing the due-date sort (a page's group appears
 * where its soonest-due task would have sorted). */
export function groupTasksByPage(sorted: readonly TaskRow[]): TaskGroup[] {
  const order: string[] = [];
  const byPage = new Map<string, TaskGroup>();
  for (const t of sorted) {
    let g = byPage.get(t.pageId);
    if (!g) {
      g = { pageId: t.pageId, pageName: t.pageName, pageJournalDay: t.pageJournalDay, tasks: [] };
      byPage.set(t.pageId, g);
      order.push(t.pageId);
    }
    g.tasks.push(t);
  }
  return order.map((id) => byPage.get(id) as TaskGroup);
}
