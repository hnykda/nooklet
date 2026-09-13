/**
 * One page's live state tables -> the outline tree `serializeOutline` turns into markdown: the
 * markdown mirror's renderer (ADR 002), shared by the two places that need the same text.
 *
 *  - The server's mirror (`packages/server/src/mirror/export.ts`) writes it to `pages/…md`.
 *  - The web client's "Export page as markdown" / "Copy page as markdown" (B-220) produce it from
 *    the local replica, which has the same four tables (`CORE_SCHEMA_STATEMENTS`), so an export
 *    works offline and includes edits not yet pushed.
 *
 * Split into the SQL (`PAGE_OUTLINE_SQL`) and a pure row -> tree step (`buildPageOutline`) rather
 * than one function over a `SqlDriver`, because the client reaches its replica through an async
 * worker RPC (`apps/web/src/db/client.ts#queryAs`) and `SqlDriver` is synchronous. Both callers
 * run the same four statements and the same build, so the text cannot drift between them — two
 * hand-maintained copies of this is exactly how the three `formatDayTime` copies drifted
 * (`../task-dates.ts`).
 *
 * Reserved block columns (`scheduled_day`/`scheduled_time`, `deadline_day`/`deadline_time`,
 * `repeat`, `done_at` — sql-schema.md rule 10, ADR 011) were pulled OUT of ordinary `key:: value`
 * property lines and into dedicated columns by the reducer on write. The renderer reconstitutes
 * them as ordinary property lines to match the canonical grammar and `parseOutline` (which only
 * ever produces a plain `properties` bag); `formatDayTime`/`formatDoneIso` produce exactly the
 * strings the reducer's `SCHEDULED_RE`/`DONE_RE` accept on the way back in.
 */

import { journalDayToFileName } from "../journal.js";
import type { OutlineNode, ParsedPage, Priority, Properties, TaskMarker } from "../model.js";
import { pageNameToFileName } from "../page-name.js";
import { formatDayTime, formatDoneIso } from "../task-dates.js";
import type { SqlDriver } from "./driver.js";

/**
 * The four reads, each taking the page id as its only positional parameter.
 *
 * Siblings are ordered `order_key, id`, not `order_key` alone. Two devices inserting at the same
 * spot mint the same fractional key; on a tie SQLite falls back to rowid, i.e. insertion order —
 * which differs between the server and every replica, and differs from the editor, which breaks
 * ties by id (`apps/web/src/editor/tree.ts#sortSiblings`, `./queries.ts#listChildren`). Without the
 * tiebreak the mirror file and an export from the browser disagree on the same data (B-223).
 */
export const PAGE_OUTLINE_SQL = {
  page: "SELECT name, journal_day, deleted_at FROM page WHERE id = ?",
  pageProps:
    "SELECT key, value FROM page_prop WHERE page_id = ? AND value IS NOT NULL ORDER BY key",
  blocks: `SELECT id, parent_id, content, marker, priority, collapsed,
            scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at
     FROM block WHERE page_id = ? AND deleted_at IS NULL ORDER BY order_key, id`,
  blockProps: `SELECT bp.block_id AS block_id, bp.key AS key, bp.value AS value
     FROM block_prop bp
     JOIN block b ON b.id = bp.block_id
     WHERE b.page_id = ? AND b.deleted_at IS NULL AND bp.value IS NOT NULL
     ORDER BY bp.key`,
} as const;

export interface PageOutlinePageRow {
  name: string;
  journal_day: number | null;
  deleted_at: number | null;
}

export interface PageOutlinePropRow {
  key: string;
  value: string | null;
}

export interface PageOutlineBlockRow {
  id: string;
  parent_id: string | null;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  /** SQLite has no boolean: `0`/`1`. */
  collapsed: number;
  scheduled_day: number | null;
  scheduled_time: string | null;
  deadline_day: number | null;
  deadline_time: string | null;
  repeat: string | null;
  done_at: number | null;
}

export interface PageOutlineBlockPropRow {
  block_id: string;
  key: string;
  value: string | null;
}

/** What the four `PAGE_OUTLINE_SQL` statements return, `page` being `get`'s single row. */
export interface PageOutlineRows {
  page: PageOutlinePageRow | undefined;
  pageProps: readonly PageOutlinePropRow[];
  blocks: readonly PageOutlineBlockRow[];
  blockProps: readonly PageOutlineBlockPropRow[];
}

export interface RenderedPage {
  pageId: string;
  name: string;
  journalDay: number | null;
  parsed: ParsedPage;
}

/**
 * Build the `ParsedPage` tree from the rows `PAGE_OUTLINE_SQL` returned. Soft-deleted blocks were
 * already excluded by the query; a live block under a deleted parent is unreachable from the roots
 * and so drops out with it ("hiding a block hides its descendants for free"). Returns `undefined`
 * when `page` is missing or soft-deleted.
 */
export function buildPageOutline(pageId: string, rows: PageOutlineRows): RenderedPage | undefined {
  const page = rows.page;
  if (!page || page.deleted_at !== null) return undefined;

  const properties: Properties = {};
  for (const p of rows.pageProps) if (p.value !== null) properties[p.key] = p.value;

  const propsByBlock = new Map<string, Array<[string, string]>>();
  for (const row of rows.blockProps) {
    if (row.value === null) continue;
    const list = propsByBlock.get(row.block_id) ?? [];
    list.push([row.key, row.value]);
    propsByBlock.set(row.block_id, list);
  }

  // Group by parent while preserving each group's relative order: filtering a globally sorted
  // array preserves the relative order within any subset.
  const childrenByParent = new Map<string | null, PageOutlineBlockRow[]>();
  for (const row of rows.blocks) {
    const list = childrenByParent.get(row.parent_id) ?? [];
    list.push(row);
    childrenByParent.set(row.parent_id, list);
  }

  const buildNode = (row: PageOutlineBlockRow): OutlineNode => {
    const nodeProps: Properties = {};
    for (const [k, v] of propsByBlock.get(row.id) ?? []) nodeProps[k] = v;
    if (row.scheduled_day !== null) {
      nodeProps.scheduled = formatDayTime(row.scheduled_day, row.scheduled_time);
    }
    if (row.deadline_day !== null) {
      nodeProps.deadline = formatDayTime(row.deadline_day, row.deadline_time);
    }
    if (row.repeat !== null) nodeProps.repeat = row.repeat;
    if (row.done_at !== null) nodeProps.done = formatDoneIso(row.done_at);

    return {
      id: row.id,
      content: row.content,
      marker: row.marker,
      priority: row.priority,
      collapsed: row.collapsed !== 0,
      properties: nodeProps,
      children: (childrenByParent.get(row.id) ?? []).map(buildNode),
    };
  };

  return {
    pageId,
    name: page.name,
    journalDay: page.journal_day,
    parsed: { properties, blocks: (childrenByParent.get(null) ?? []).map(buildNode) },
  };
}

/** `PAGE_OUTLINE_SQL` + `buildPageOutline` over a synchronous driver (the server's, a test's). */
export function readPageOutline(driver: SqlDriver, pageId: string): RenderedPage | undefined {
  return buildPageOutline(pageId, {
    page: driver.get<PageOutlinePageRow>(PAGE_OUTLINE_SQL.page, [pageId]),
    pageProps: driver.all<PageOutlinePropRow>(PAGE_OUTLINE_SQL.pageProps, [pageId]),
    blocks: driver.all<PageOutlineBlockRow>(PAGE_OUTLINE_SQL.blocks, [pageId]),
    blockProps: driver.all<PageOutlineBlockPropRow>(PAGE_OUTLINE_SQL.blockProps, [pageId]),
  });
}

/** Mirror-relative file path for a page (PLAN.md §5): forward-slash, relative to the data dir.
 * The client names an exported download after its last segment, so a downloaded file and the
 * mirror's copy of the same page carry the same name. */
export function pageMirrorPath(page: { name: string; journalDay: number | null }): string {
  if (page.journalDay !== null) return `journals/${journalDayToFileName(page.journalDay)}.md`;
  return `pages/${pageNameToFileName(page.name)}.md`;
}
