/**
 * Small read helpers over the state tables, driver-agnostic. Not a general query layer (that's
 * `packages/server`'s `DataApi`, out of scope here) — just enough to read back what `applyOps`
 * wrote in tests and examples.
 */

import type { SqlDriver } from "./driver.js";
import type { BlockRow, PageRow, PropRow } from "./types.js";

interface PageSqlRow {
  id: string;
  graph_id: string;
  name: string;
  key: string;
  journal_day: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  name_hlc: string;
  deleted_hlc: string | null;
}

function toPageRow(r: PageSqlRow): PageRow {
  return {
    id: r.id,
    graphId: r.graph_id,
    name: r.name,
    key: r.key,
    journalDay: r.journal_day,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    nameHlc: r.name_hlc,
    deletedHlc: r.deleted_hlc,
  };
}

export function getPage(driver: SqlDriver, id: string): PageRow | undefined {
  const r = driver.get<PageSqlRow>("SELECT * FROM page WHERE id = ?", [id]);
  return r ? toPageRow(r) : undefined;
}

export function listPages(driver: SqlDriver): PageRow[] {
  return driver.all<PageSqlRow>("SELECT * FROM page ORDER BY id").map(toPageRow);
}

/** A `block` row as SQLite returns it (`SELECT *`). Exported with `toBlockRow` for readers that run
 * their own SQL over the same table — the web client's replica queries (`apps/web/src/data/`) —
 * so the column-to-field mapping exists once. */
export interface BlockSqlRow {
  id: string;
  graph_id: string;
  page_id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: string | null;
  priority: string | null;
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
  due_day: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  place_hlc: string;
  content_hlc: string;
  marker_hlc: string | null;
  priority_hlc: string | null;
  collapsed_hlc: string | null;
  scheduled_hlc: string | null;
  deadline_hlc: string | null;
  repeat_hlc: string | null;
  done_hlc: string | null;
  deleted_hlc: string | null;
}

export function toBlockRow(r: BlockSqlRow): BlockRow {
  return {
    id: r.id,
    graphId: r.graph_id,
    pageId: r.page_id,
    parentId: r.parent_id,
    order: r.order_key,
    content: r.content,
    marker: r.marker as BlockRow["marker"],
    priority: r.priority as BlockRow["priority"],
    collapsed: r.collapsed !== 0,
    scheduledDay: r.scheduled_day,
    scheduledTime: r.scheduled_time,
    deadlineDay: r.deadline_day,
    deadlineTime: r.deadline_time,
    repeat: r.repeat,
    doneAt: r.done_at,
    dueDay: r.due_day,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    placeHlc: r.place_hlc,
    contentHlc: r.content_hlc,
    markerHlc: r.marker_hlc,
    priorityHlc: r.priority_hlc,
    collapsedHlc: r.collapsed_hlc,
    scheduledHlc: r.scheduled_hlc,
    deadlineHlc: r.deadline_hlc,
    repeatHlc: r.repeat_hlc,
    doneHlc: r.done_hlc,
    deletedHlc: r.deleted_hlc,
  };
}

export function getBlock(driver: SqlDriver, id: string): BlockRow | undefined {
  const r = driver.get<BlockSqlRow>("SELECT * FROM block WHERE id = ?", [id]);
  return r ? toBlockRow(r) : undefined;
}

export function listBlocks(driver: SqlDriver): BlockRow[] {
  return driver.all<BlockSqlRow>("SELECT * FROM block ORDER BY id").map(toBlockRow);
}

/**
 * A parent's children, live only, in sibling order: `order_key` then `id` (00-conventions.md:
 * "Order keys: ... ties broken by block id" — two concurrent inserts between the same pair of
 * siblings can legitimately produce the same `order_key`, since `fractional-indexing`'s
 * `generateKeyBetween` is a deterministic function of its two neighbor arguments).
 */
export function listChildren(
  driver: SqlDriver,
  pageId: string,
  parentId: string | null,
): BlockRow[] {
  const sql =
    parentId === null
      ? "SELECT * FROM block WHERE page_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY order_key, id"
      : "SELECT * FROM block WHERE page_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY order_key, id";
  const params = parentId === null ? [pageId] : [pageId, parentId];
  return driver.all<BlockSqlRow>(sql, params).map(toBlockRow);
}

interface PropSqlRow {
  key: string;
  value: string | null;
  hlc: string;
}

function toPropRow(r: PropSqlRow): PropRow {
  return { key: r.key, value: r.value, hlc: r.hlc };
}

/** Current (non-null) properties of a block, generic `block_prop` rows only (not reserved keys). */
export function listBlockProps(driver: SqlDriver, blockId: string): PropRow[] {
  return driver
    .all<PropSqlRow>("SELECT key, value, hlc FROM block_prop WHERE block_id = ? ORDER BY key", [
      blockId,
    ])
    .map(toPropRow);
}

export function listPageProps(driver: SqlDriver, pageId: string): PropRow[] {
  return driver
    .all<PropSqlRow>("SELECT key, value, hlc FROM page_prop WHERE page_id = ? ORDER BY key", [
      pageId,
    ])
    .map(toPropRow);
}
