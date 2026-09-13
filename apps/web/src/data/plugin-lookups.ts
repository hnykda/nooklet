/**
 * `Block` and `Page` objects for the client plugin host (`../plugins/host.ts`, ADR 023), read from
 * the local replica. Plugins are typed against `@nooklet/core`'s `Block`/`Page` — the same shapes
 * the server's `DataApi` hands a server half — so these mirror `packages/server/src/rows.ts`
 * (`rowToBlock`/`rowToPage`) field for field, including folding the reserved scheduling columns
 * back into `properties` (ADR 011): a renderer must not see a different block depending on which
 * half of the plugin it runs in.
 *
 * One-shot async lookups, not `use*` resources: the host calls them when a renderer mounts or the
 * open page changes, never during render.
 */
import {
  type Block,
  formatDayTime,
  formatDoneIso,
  normalizePageName,
  type Page,
  type Priority,
  type Properties,
  parseJournalTitle,
  type TaskMarker,
} from "@nooklet/core";
import { queryAs } from "../db/client.js";

interface BlockSqlRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
  created_at: number;
  updated_at: number;
}

interface PageSqlRow {
  id: string;
  name: string;
  key: string;
  journal_day: number | null;
  created_at: number;
  updated_at: number;
}

async function propertiesOf(
  table: "block_prop" | "page_prop",
  idColumn: "block_id" | "page_id",
  id: string,
): Promise<Properties> {
  const rows = await queryAs<{ key: string; value: string | null }>(
    `SELECT key, value FROM ${table} WHERE ${idColumn} = ? AND value IS NOT NULL`,
    [id],
  );
  const properties: Properties = {};
  for (const r of rows) if (r.value !== null) properties[r.key] = r.value;
  return properties;
}

/** A live block by id, or `null` when it does not exist (or is deleted) in the replica. */
export async function loadBlock(id: string): Promise<Block | null> {
  const rows = await queryAs<BlockSqlRow>(
    `SELECT id, page_id, parent_id, order_key, content, marker, priority, collapsed,
            scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at,
            created_at, updated_at
     FROM block WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const properties = await propertiesOf("block_prop", "block_id", row.id);
  if (row.scheduled_day !== null)
    properties.scheduled = formatDayTime(row.scheduled_day, row.scheduled_time);
  if (row.deadline_day !== null)
    properties.deadline = formatDayTime(row.deadline_day, row.deadline_time);
  if (row.repeat !== null) properties.repeat = row.repeat;
  if (row.done_at !== null) properties.done = formatDoneIso(row.done_at);
  return {
    id: row.id,
    pageId: row.page_id,
    parentId: row.parent_id,
    order: row.order_key,
    content: row.content,
    marker: row.marker,
    priority: row.priority,
    properties,
    collapsed: row.collapsed !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function toPage(row: PageSqlRow): Promise<Page> {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    journalDay: row.journal_day,
    properties: await propertiesOf("page_prop", "page_id", row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PAGE_COLUMNS = "id, name, key, journal_day, created_at, updated_at";

/** A live page by id or by name. A name resolves the way the page route does
 * (`store.ts#usePageByName`): by key, then — for a journal title in any format — by its day. */
export async function loadPage(ref: { id: string } | { name: string }): Promise<Page | null> {
  if ("id" in ref) {
    const rows = await queryAs<PageSqlRow>(
      `SELECT ${PAGE_COLUMNS} FROM page WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [ref.id],
    );
    return rows[0] ? toPage(rows[0]) : null;
  }
  const byKey = await queryAs<PageSqlRow>(
    `SELECT ${PAGE_COLUMNS} FROM page WHERE key = ? AND deleted_at IS NULL LIMIT 1`,
    [normalizePageName(ref.name)],
  );
  if (byKey[0]) return toPage(byKey[0]);
  const day = parseJournalTitle(ref.name);
  if (day === null) return null;
  const byDay = await queryAs<PageSqlRow>(
    `SELECT ${PAGE_COLUMNS} FROM page WHERE journal_day = ? AND deleted_at IS NULL LIMIT 1`,
    [day],
  );
  return byDay[0] ? toPage(byDay[0]) : null;
}
