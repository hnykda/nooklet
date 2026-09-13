/**
 * The rows behind a journal day's "Scheduled and deadline" section (PLAN.md §8): every open task
 * that carries a scheduled or deadline date, and every dated block that is not a task at all, read
 * from the LOCAL replica — `scheduled_day`, `deadline_day` and `marker` are shared-schema block
 * columns, so this works offline and needs no server round trip.
 *
 * ONE query serves every day on screen. The journal stream renders fourteen days and grows as it
 * scrolls; a query per day would multiply every refetch (and every edit refetches — the resource
 * is stamped on `block`) by the number of days loaded. Deciding which row belongs to which day
 * is plain array work in `../views/agendaDay.ts`, over a set that is small by nature: blocks with
 * a date.
 *
 * Open markers or no marker, never DONE/CANCELED: a finished task is off the agenda. A block with
 * no marker is listed only on its own day, never as overdue (`agendaDay.ts`) — it can never be
 * completed, so as an overdue item it would stay under today forever. The read goes through the
 * replica's `block_dated` index (`../db/schema-client.ts`), which holds only dated blocks.
 * `block_marker`, which served the tasks-only read, leaves out `marker IS NULL` rows, so without
 * `block_dated` this read scans every block — 18.6k on the owner's graph, on every write
 * (`tools/probes/agenda-sql-cost.mjs`). The unit test pins the plan.
 */

import type { Priority, TaskMarker } from "@nooklet/core";
import { type Accessor, createResource, type InitializedResource } from "solid-js";
import { queryAs } from "../db/client.js";
import { stampedFor } from "./store.js";

export interface AgendaTask {
  id: string;
  pageId: string;
  pageName: string;
  pageJournalDay: number | null;
  /** Sibling order within its parent — only a tiebreak between tasks on the same page. */
  order: string;
  content: string;
  /** `null` for a dated block that is not a task: listed on its own day only, never overdue. */
  marker: TaskMarker | null;
  priority: Priority | null;
  scheduledDay: number | null;
  scheduledTime: string | null;
  deadlineDay: number | null;
  deadlineTime: string | null;
}

interface AgendaSqlRow {
  id: string;
  page_id: string;
  order_key: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  page_name: string;
  page_journal_day: number | null;
}

export const AGENDA_SQL = `SELECT b.id, b.page_id, b.order_key, b.content, b.marker, b.priority,
    b.scheduled_day, b.scheduled_time, b.deadline_day, b.deadline_time,
    p.name AS page_name, p.journal_day AS page_journal_day
  FROM block b JOIN page p ON p.id = b.page_id AND p.deleted_at IS NULL
  WHERE b.deleted_at IS NULL AND b.due_day IS NOT NULL
    AND (b.marker IS NULL OR b.marker IN ('TODO','DOING','LATER','NOW','WAITING'))`;

export type AgendaSqlRunner = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** One read. `sql` is injectable for tests; production callers pass nothing. */
export async function loadAgendaTasks(sql: AgendaSqlRunner = queryAs): Promise<AgendaTask[]> {
  const rows = await sql<AgendaSqlRow>(AGENDA_SQL);
  return rows.map((r) => ({
    id: r.id,
    pageId: r.page_id,
    pageName: r.page_name,
    pageJournalDay: r.page_journal_day,
    order: r.order_key,
    content: r.content,
    marker: r.marker,
    priority: r.priority,
    scheduledDay: r.scheduled_day,
    scheduledTime: r.scheduled_time,
    deadlineDay: r.deadline_day,
    deadlineTime: r.deadline_time,
  }));
}

/**
 * Live open tasks and non-task blocks with a date. Refetches after any write to `block` (a marker,
 * a date, the text) or `page` (a rename, a deletion). `enabled` lets a view that only sometimes shows the section —
 * `PageView`, for journal pages — skip the read entirely otherwise.
 */
export function useAgendaTasks(
  enabled: Accessor<boolean> = () => true,
): InitializedResource<AgendaTask[]> {
  const [resource] = createResource(
    () => (enabled() ? stampedFor(true, ["block", "page"]) : undefined),
    () => loadAgendaTasks(),
    { initialValue: [] },
  );
  return resource;
}
