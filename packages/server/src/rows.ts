/**
 * Row shapes for the `page`/`block` state tables and the mappers from them to `@nooklet/core`'s
 * `Page`/`Block` — plus the pre/post-image snapshots the change audit stores (ADR 013).
 *
 * This module exists so that `data-api.ts` (which needs the mappers) and `apply-ops.ts` (which
 * needs the snapshots) can share one implementation: `data-api.ts` imports `apply-ops.ts` for
 * `serverApplyOps`, so `apply-ops.ts` could not import the mappers back without a cycle, and the
 * property-flattening logic had been copied instead. Nothing here imports either of them.
 */

import {
  type Block,
  formatDayTime,
  formatDoneIso,
  isoJournalName,
  type Page,
  type Properties,
  type SqlDriver,
} from "@nooklet/core";

export interface PageRow {
  id: string;
  name: string;
  key: string;
  journal_day: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface BlockRow {
  id: string;
  page_id: string;
  parent_id: string | null;
  order_key: string;
  content: string;
  marker: Block["marker"];
  priority: Block["priority"];
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export const BLOCK_COLUMNS =
  "id, page_id, parent_id, order_key, content, marker, priority, collapsed, " +
  "scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at, " +
  "created_at, updated_at, deleted_at";

/** `key -> value` for one entity's non-null generic property rows. */
function propertiesOf(
  driver: SqlDriver,
  table: "page_prop" | "block_prop",
  idColumn: "page_id" | "block_id",
  id: string,
): Properties {
  const rows = driver.all<{ key: string; value: string | null }>(
    `SELECT key, value FROM ${table} WHERE ${idColumn} = ? AND value IS NOT NULL`,
    [id],
  );
  const properties: Properties = {};
  for (const r of rows) if (r.value !== null) properties[r.key] = r.value;
  return properties;
}

/**
 * A block's properties as the wire sees them: the generic `block_prop` rows plus the reserved
 * scheduling keys reconstituted from their dedicated columns (ADR 011). The reducer pulled them
 * out on write; readers must put them back so the wire never learns the storage layout.
 */
export function blockPropertiesOf(driver: SqlDriver, row: BlockRow): Properties {
  const properties = propertiesOf(driver, "block_prop", "block_id", row.id);
  if (row.scheduled_day !== null)
    properties.scheduled = formatDayTime(row.scheduled_day, row.scheduled_time);
  if (row.deadline_day !== null)
    properties.deadline = formatDayTime(row.deadline_day, row.deadline_time);
  if (row.repeat !== null) properties.repeat = row.repeat;
  if (row.done_at !== null) properties.done = formatDoneIso(row.done_at);
  return properties;
}

export function rowToPage(driver: SqlDriver, row: PageRow): Page {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    journalDay: row.journal_day,
    properties: propertiesOf(driver, "page_prop", "page_id", row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToBlock(driver: SqlDriver, row: BlockRow): Block {
  return {
    id: row.id,
    pageId: row.page_id,
    parentId: row.parent_id,
    order: row.order_key,
    content: row.content,
    marker: row.marker,
    priority: row.priority,
    properties: blockPropertiesOf(driver, row),
    collapsed: row.collapsed !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A live (non-deleted) block row. */
export function getBlockRow(driver: SqlDriver, id: string): BlockRow | undefined {
  return driver.get<BlockRow>(
    `SELECT ${BLOCK_COLUMNS} FROM block WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

/** A block row whether or not it is deleted — for callers that need to see tombstones. */
export function getBlockRowAny(driver: SqlDriver, id: string): BlockRow | undefined {
  return driver.get<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM block WHERE id = ?`, [id]);
}

/** A live (non-deleted) page row. */
export function getPageRow(driver: SqlDriver, id: string): PageRow | undefined {
  return driver.get<PageRow>("SELECT * FROM page WHERE id = ? AND deleted_at IS NULL", [id]);
}

/**
 * The name a page goes by on the wire (mcp-tools.md rule 18): its ISO date for a journal day, its
 * name otherwise. Since ADR 018 a journal's stored name IS its ISO date, so the two branches agree
 * for every page the migration reached; the day column stays authoritative for the ones it had to
 * leave alone (`journal-names.ts`'s `collided`).
 */
export function wirePageNameOf(row: { name: string; journal_day: number | null }): string {
  return row.journal_day !== null ? isoJournalName(row.journal_day) : row.name;
}

/**
 * `wirePageNameOf` by page id, for the many ops that hold a block and need to say which page it is
 * on. Falls back to the id itself when the page row is gone, which only a hard delete (or corrupt
 * data) can cause; better a recognisable id than a thrown error in a read path.
 */
export function pageWireNameById(driver: SqlDriver, pageId: string): string {
  const row = driver.get<{ name: string; journal_day: number | null }>(
    "SELECT name, journal_day FROM page WHERE id = ?",
    [pageId],
  );
  return row ? wirePageNameOf(row) : pageId;
}

// ---------------------------------------------------------------------------------------------
// Change-audit snapshots (ADR 013): a full pre/post image per touched page/block, written by
// `apply-ops.ts#recordChanges` and read back by `ops/batch-undo.ts` to mint compensating ops.
// ---------------------------------------------------------------------------------------------

export interface PageChangeSnapshot {
  name: string;
  journal_day: number | null;
  properties: Record<string, string>;
  deleted_at: number | null;
}

export interface BlockChangeSnapshot {
  place: { pageId: string; parentId: string | null; order: string };
  content: string;
  marker: string | null;
  priority: string | null;
  collapsed: boolean;
  properties: Record<string, string>;
  deleted_at: number | null;
}

/** Snapshot a page whether or not it is deleted; `null` only when the row does not exist. */
export function snapshotPage(driver: SqlDriver, id: string): PageChangeSnapshot | null {
  const row = driver.get<PageRow>("SELECT * FROM page WHERE id = ?", [id]);
  if (!row) return null;
  return {
    name: row.name,
    journal_day: row.journal_day,
    properties: propertiesOf(driver, "page_prop", "page_id", id),
    deleted_at: row.deleted_at,
  };
}

/** Snapshot a block whether or not it is deleted; `null` only when the row does not exist. */
export function snapshotBlock(driver: SqlDriver, id: string): BlockChangeSnapshot | null {
  const row = getBlockRowAny(driver, id);
  if (!row) return null;
  return {
    place: { pageId: row.page_id, parentId: row.parent_id, order: row.order_key },
    content: row.content,
    marker: row.marker,
    priority: row.priority,
    collapsed: row.collapsed !== 0,
    properties: blockPropertiesOf(driver, row),
    deleted_at: row.deleted_at,
  };
}
