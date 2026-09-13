/**
 * A page this replica created that the server has a different page for under the same name — the
 * two-device race ADR 024 makes common: this device, offline, clicked Create on "X" while another
 * device's `[[X]]` made the server create "X". The server refuses this device's `page.create`
 * (`page-key-collision`) and, with it, every block on the refused page (`no-such-page`); and the
 * server's page cannot land in this replica while the name is taken here. Left alone, the two never
 * converge and whatever was typed on the refused page exists only on this device.
 *
 * What converges: the replica drops its refused page and everything on it, takes the server's page,
 * and re-sends what was on the refused page as NEW ops — current local state, fresh HLCs — onto the
 * server's page. Fresh clocks are the point. Re-sending the original ops rewritten onto the server's
 * page would store blocks whose HLCs are older than their page's `page.create`, and the op log's
 * HLC-ordered replay (`nooklet verify`) would meet them before their page and reject them.
 *
 * Two ways to find out, handled by `SyncClient`: a push whose response names the page that holds
 * the name (`refused_pages`, server `sync/push.ts`), and a pull that brings the server's
 * `page.create` (or `page.rename`) for a name a local page holds.
 *
 * Known edge not covered: a block that already existed on the server, moved onto the refused page
 * and deleted there, keeps its old place on the server (its delete is dropped with the rest).
 */

import {
  formatDayTime,
  formatDoneIso,
  isoJournalName,
  isValidJournalDay,
  normalizePageName,
  type Op,
  type OpPayload,
  type Priority,
  type Properties,
  type SqlDriver,
  type TaskMarker,
} from "@nooklet/core";
import type { SnapshotPagePropRow, SnapshotPageRow } from "./types.js";

export interface RefusedPage {
  /** This replica's page id the server refused. */
  refused_id: string;
  /** The server's live page under that name, as a snapshot row. */
  page: SnapshotPageRow;
  page_props: SnapshotPagePropRow[];
}

interface CapturedBlock {
  id: string;
  pageId: string;
  parentId: string | null;
  order: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  collapsed: boolean;
  properties: Properties;
  createdAt: number;
}

/** What was on a refused page, read before the page is removed. */
export interface CapturedPage {
  refusedId: string;
  properties: Properties;
  blocks: CapturedBlock[];
}

interface BlockRowLite {
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
  deleted_at: number | null;
}

/** The key a `page.create` / `page.rename` payload stores its page under (core's `storedPageName`). */
export function payloadPageKey(payload: OpPayload): string | undefined {
  if (payload.kind === "page.rename") return normalizePageName(payload.name);
  if (payload.kind !== "page.create") return undefined;
  const { name, journalDay } = payload;
  const stored =
    journalDay !== null && isValidJournalDay(journalDay) ? isoJournalName(journalDay) : name;
  return normalizePageName(stored);
}

/**
 * Local pages a pulled batch cannot land beside: for each `page.create`/`page.rename` in `ops` whose
 * page still holds that name at the end of the batch, a different live local page holding it whose
 * own `page.create` the server has not taken yet (it is still in `pending_op`).
 *
 * Both conditions matter. A page the server already accepted is the server's, and plain replay is
 * right — this device may well be pulling an older page of that name followed by its deletion (a
 * link's short-lived page, ADR 024, is exactly that), and moving its content onto that tombstone
 * would be the bug, not the fix. And a name the batch itself gives up again frees the key for the
 * local page. (A page the server refused is handled from the push response, `refused_pages`.)
 */
export function pagesDisplacedByPull(
  driver: SqlDriver,
  ops: readonly Op[],
): Array<{ refusedId: string; winnerId: string }> {
  const touchedAway = new Set(
    ops
      .filter((o) => o.payload.kind === "page.rename" || o.payload.kind === "page.delete")
      .map((o) => o.entity),
  );
  const out: Array<{ refusedId: string; winnerId: string }> = [];
  const seen = new Set<string>();
  ops.forEach((op, index) => {
    const key = payloadPageKey(op.payload);
    if (key === undefined) return;
    // Pulled ops are in server order: a later delete or rename of the same page gives the name up.
    const givenUp = ops
      .slice(index + 1)
      .some(
        (later) =>
          later.entity === op.entity &&
          ((later.payload.kind === "page.delete" && later.payload.deletedAt !== null) ||
            (later.payload.kind === "page.rename" && payloadPageKey(later.payload) !== key)),
      );
    if (givenUp) return;
    const local = driver.get<{ id: string }>(
      "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL AND id != ?",
      [key, op.entity],
    );
    if (!local || touchedAway.has(local.id) || seen.has(local.id)) return;
    const unconfirmed = driver.get(
      "SELECT 1 AS x FROM pending_op WHERE entity = ? AND kind = 'page.create'",
      [local.id],
    );
    if (!unconfirmed) return;
    seen.add(local.id);
    out.push({ refusedId: local.id, winnerId: op.entity });
  });
  return out;
}

/**
 * Read what is on refused page `pageId` (its properties; its live blocks, parents before children,
 * plus any block whose pending `block.create` put it there and that has since moved), then remove
 * the page, its blocks and every pending op about them from this replica. Returns `undefined` when
 * the page is not here. Run inside the caller's transaction.
 */
export function captureAndRemoveRefusedPage(
  driver: SqlDriver,
  pageId: string,
): CapturedPage | undefined {
  if (!driver.get("SELECT 1 AS x FROM page WHERE id = ?", [pageId])) return undefined;

  const createdHere = new Set<string>();
  for (const row of driver.all<{ entity: string; payload: string }>(
    "SELECT entity, payload FROM pending_op WHERE kind = 'block.create'",
  )) {
    const payload = JSON.parse(row.payload) as { place?: { pageId?: string } };
    if (payload.place?.pageId === pageId) createdHere.add(row.entity);
  }
  const onPage = driver.all<BlockRowLite>("SELECT * FROM block WHERE page_id = ?", [pageId]);
  const ids = new Set([...onPage.map((b) => b.id), ...createdHere]);
  const rows = [...ids]
    .map((id) => driver.get<BlockRowLite>("SELECT * FROM block WHERE id = ?", [id]))
    .filter((b): b is BlockRowLite => b !== undefined);

  // Parents before children, so each re-created block finds its parent already there.
  const byId = new Map(rows.map((b) => [b.id, b]));
  const ordered: BlockRowLite[] = [];
  const placed = new Set<string>();
  const visit = (b: BlockRowLite, guard = 0): void => {
    if (placed.has(b.id) || guard > 1000) return;
    const parent = b.parent_id ? byId.get(b.parent_id) : undefined;
    if (parent) visit(parent, guard + 1);
    placed.add(b.id);
    ordered.push(b);
  };
  for (const b of [...rows].sort((a, c) => (a.order_key < c.order_key ? -1 : 1))) visit(b);

  const blocks: CapturedBlock[] = ordered
    .filter((b) => b.deleted_at === null)
    .map((b) => ({
      id: b.id,
      pageId: b.page_id,
      parentId: b.parent_id,
      order: b.order_key,
      content: b.content,
      marker: b.marker,
      priority: b.priority,
      collapsed: b.collapsed !== 0,
      properties: blockProperties(driver, b),
      createdAt: b.created_at,
    }));

  const properties: Properties = {};
  for (const p of driver.all<{ key: string; value: string }>(
    "SELECT key, value FROM page_prop WHERE page_id = ? AND value IS NOT NULL",
    [pageId],
  )) {
    properties[p.key] = p.value;
  }

  const idList = JSON.stringify([...ids]);
  driver.run(
    "DELETE FROM pending_op WHERE entity = ? OR entity IN (SELECT value FROM json_each(?))",
    [pageId, idList],
  );
  // A block kept elsewhere may still hang under one being removed; the re-sent place puts it back.
  driver.run(
    `UPDATE block SET parent_id = NULL
     WHERE parent_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))`,
    [idList, idList],
  );
  driver.run("DELETE FROM block_prop WHERE block_id IN (SELECT value FROM json_each(?))", [idList]);
  driver.run("DELETE FROM block WHERE id IN (SELECT value FROM json_each(?))", [idList]);
  driver.run("DELETE FROM page_prop WHERE page_id = ?", [pageId]);
  driver.run("DELETE FROM page WHERE id = ?", [pageId]);
  return { refusedId: pageId, properties, blocks };
}

/** The server's page, as the snapshot row a push response carried, if this replica lacks it. */
export function insertPageSnapshot(driver: SqlDriver, refusal: RefusedPage): void {
  const p = refusal.page;
  driver.run(
    `INSERT OR IGNORE INTO page(id, name, key, journal_day, created_at, updated_at, deleted_at, name_hlc, deleted_hlc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.id,
      p.name,
      p.key,
      p.journal_day,
      p.created_at,
      p.updated_at,
      p.deleted_at,
      p.name_hlc,
      p.deleted_hlc,
    ],
  );
  for (const pp of refusal.page_props) {
    driver.run("INSERT OR IGNORE INTO page_prop(page_id, key, value, hlc) VALUES (?, ?, ?, ?)", [
      pp.page_id,
      pp.key,
      pp.value,
      pp.hlc,
    ]);
  }
}

/**
 * Ops that put a captured page's content onto `targetPageId`: its properties, then each live block
 * as a `block.create` carrying its current state plus a `block.place` (a block the server already
 * had, moved here, is not re-inserted by a create — the place is what moves it). `mint` must hand
 * out fresh, increasing HLCs.
 */
export function reapplyCapturedPage(
  captured: CapturedPage,
  targetPageId: string,
  mint: (entity: string, payload: OpPayload) => Op,
): Op[] {
  const ops: Op[] = [];
  for (const [key, value] of Object.entries(captured.properties)) {
    ops.push(mint(targetPageId, { kind: "page.prop", key, value }));
  }
  for (const b of captured.blocks) {
    const pageId = b.pageId === captured.refusedId ? targetPageId : b.pageId;
    const place = { pageId, parentId: b.parentId, order: b.order };
    ops.push(
      mint(b.id, {
        kind: "block.create",
        place,
        content: b.content,
        marker: b.marker,
        priority: b.priority,
        collapsed: b.collapsed,
        properties: Object.keys(b.properties).length > 0 ? b.properties : undefined,
        createdAt: b.createdAt,
      }),
    );
    ops.push(mint(b.id, { kind: "block.place", place }));
  }
  return ops;
}

function blockProperties(driver: SqlDriver, row: BlockRowLite): Properties {
  const properties: Properties = {};
  for (const p of driver.all<{ key: string; value: string }>(
    "SELECT key, value FROM block_prop WHERE block_id = ? AND value IS NOT NULL",
    [row.id],
  )) {
    properties[p.key] = p.value;
  }
  if (row.scheduled_day !== null)
    properties.scheduled = formatDayTime(row.scheduled_day, row.scheduled_time);
  if (row.deadline_day !== null)
    properties.deadline = formatDayTime(row.deadline_day, row.deadline_time);
  if (row.repeat !== null) properties.repeat = row.repeat;
  if (row.done_at !== null) properties.done = formatDoneIso(row.done_at);
  return properties;
}
