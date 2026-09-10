/**
 * The server's actual single write path (ADR 003/008): wraps `@nooklet/core`'s `applyOps` (the
 * page/block/block_prop/page_prop state-mutation primitive, which has no server role) with
 * everything a real server must additionally do, per `docs/spec/sql-schema.md` rule 24:
 *
 *  - emit a **corrective op** with a server-owned HLC when a `block.place` is rejected for a
 *    cycle, so every client converges on the same decision (core deliberately does not do this);
 *  - maintain the derived `ref`/`path_ref` tables from `extractRefs`/`tokenizeContent`;
 *  - enqueue `embed_dirty` for anything whose text a future embeddings worker (M3) should re-index;
 *  - write one `changes` row per touched entity, for `changes_since`/audit/attribution.
 *
 * `block_fts`/`block_tri`/`page_fts`/`page_tri` update themselves via SQL triggers (schema.ts) and
 * need no code here.
 */

import type { AppliedOpResult, ApplyOpsResult, Op, OpPayload, SqlDriver } from "@nooklet/core";
import {
  applyOps as coreApplyOps,
  extractRefs,
  Hlc,
  makeOp,
  newId,
  tokenizeContent,
} from "@nooklet/core";
import { runBeforeWrite } from "./plugins/before-write.js";
import { notifyCommit } from "./sync/realtime.js";

/** Reserved device id for ops the server itself authors (corrective moves). Never a real device. */
export const SERVER_DEVICE_ID = "00000000";

export type Origin = "user" | "api" | "mcp" | "sync" | "plugin" | "import" | "mirror" | "system";

export interface ServerContext {
  driver: SqlDriver;
  /** The server's own HLC clock, used for corrective ops and any op the server authors itself. */
  hlc: Hlc;
}

export function createServerContext(driver: SqlDriver): ServerContext {
  return { driver, hlc: new Hlc(SERVER_DEVICE_ID) };
}

export interface ServerApplyOptions {
  origin: Origin;
  /** Human/agent/device label stored on every `changes` row this call produces. */
  actor: string;
  /** Shared by every `changes` row from one call, so a UI/undo can group them. */
  batchId?: string;
  /**
   * The device that authored this write, when the caller knows it (a sync push does). Used only
   * to skip poking that device about its own commit — it already has these ops. Server-authored
   * writes (API, MCP, importer, mirror) leave it unset, so every connection is poked.
   */
  deviceId?: string;
}

export interface ServerApplyResult extends ApplyOpsResult {
  batchId: string;
  /** Corrective ops the server generated in response to a rejected `block.place` (rule 24). */
  corrections: Op[];
}

/**
 * Apply `ops`, then do everything `@nooklet/core`'s `applyOps` cannot (see file header). Runs in
 * one transaction: either the whole batch's state + index + audit effects land, or none do.
 */
export function serverApplyOps(
  ctx: ServerContext,
  inputOps: readonly Op[],
  opts: ServerApplyOptions,
): ServerApplyResult {
  const { driver } = ctx;
  const batchId = opts.batchId ?? newId();
  const corrections: Op[] = [];

  // PLUGIN HOOK (ADR 007, api-and-plugin-types.md rule 13): a plugin's `ctx.beforeWrite` handler
  // may transform the pending ops in place, or veto the whole write by throwing — BEFORE anything
  // below observes them (HLC absorption, the transaction, `changes` rows). Skipped entirely for
  // "sync" origin so an incoming write from another device always converges, never forked by a
  // plugin's opinion. `./plugins/before-write.ts` owns all the registration/handler bookkeeping;
  // this is the single call site plugins get into the write path.
  const ops = runBeforeWrite(ctx, batchId, opts.origin, opts.deviceId, [...inputOps]);

  // Absorb every incoming op's HLC before minting any server-authored timestamp (a corrective
  // op below, or a future server-originated op), so `ctx.hlc.next()` is always strictly greater
  // than anything the server has seen (ADR 003). A device whose clock is more than 60s ahead
  // throws HlcDriftError here, surfacing as "device clock is wrong" to the caller (intended).
  for (const op of ops) ctx.hlc.receive(op.hlc);

  const result = driver.transaction(() => {
    // `batch.undo` (ADR 013) needs a full pre-image of every entity this call is about to touch,
    // so it can generate compensating ops later without re-deriving state from op payloads (which
    // are per-field deltas, not full snapshots). Snapshot BEFORE applying — `corrections` (below)
    // never introduce a new entity beyond what `ops` already touches, so `ops`'s own entity set is
    // complete for this purpose.
    const beforeSnapshots = snapshotEntities(driver, ops);

    const r = coreApplyOps(driver, ops);

    // Rule 24: a rejected block.place gets a corrective op restoring the block's prior place,
    // authored by the server, applied immediately (in the same transaction) so state never
    // observably held the rejected move even transiently.
    for (const one of r.results) {
      if (one.status !== "rejected" || one.kind !== "block.place") continue;
      const row = driver.get<{ page_id: string; parent_id: string | null; order_key: string }>(
        "SELECT page_id, parent_id, order_key FROM block WHERE id = ?",
        [one.entity],
      );
      if (!row) continue; // block no longer exists; nothing to correct
      const correctionHlc = ctx.hlc.next();
      const correction = makeOp(correctionHlc, SERVER_DEVICE_ID, one.entity, {
        kind: "block.place",
        place: { pageId: row.page_id, parentId: row.parent_id, order: row.order_key },
      });
      corrections.push(correction);
      const cr = coreApplyOps(driver, [correction]);
      for (const cone of cr.results) r.results.push(cone);
    }

    const allOps = ops.concat(corrections);
    reindexTouchedEntities(driver, allOps);
    const afterSnapshots = snapshotEntities(driver, allOps);
    recordChanges(driver, allOps, r.results, opts, batchId, beforeSnapshots, afterSnapshots);

    let applied = 0;
    let noop = 0;
    let rejected = 0;
    for (const one of r.results) {
      if (one.status === "applied") applied++;
      else if (one.status === "noop") noop++;
      else rejected++;
    }
    return { results: r.results, applied, noop, rejected };
  });

  // Announce the commit so any transport that cares can react — today that is `./sync/live.ts`
  // poking connected clients so an open window reflects the write immediately (the live
  // collaboration ADR 015 is built on). This lives here, at the single chokepoint EVERY write
  // path goes through (sync push, the op registry, `data-api.ts`, the importer, the mirror),
  // rather than in any one caller: an earlier attempt to wire it into the op registry alone
  // missed every handler that writes via `data-api.ts`, which is most of them.
  // `./sync/realtime.ts` is an event bus, not transport, so this keeps `serverApplyOps` free of
  // any HTTP/WebSocket knowledge; `live.ts` is what actually subscribes and broadcasts.
  if (result.applied > 0) {
    const head =
      driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM changes")?.n ?? 0;
    notifyCommit(ctx, head, opts.deviceId);
  }

  return { ...result, batchId, corrections };
}

/** Rebuild `ref`/`path_ref` for exactly the blocks whose content or properties an op could have
 *  changed, and enqueue `embed_dirty`. Idempotent and cheap to call even for a noop/rejected op —
 *  it re-derives from current state rather than trusting the op's own before/after. */
function reindexTouchedEntities(driver: SqlDriver, ops: readonly Op[]): void {
  const touchedBlocks = new Set<string>();
  const touchedPages = new Set<string>();
  for (const op of ops) {
    if (op.payload.kind.startsWith("block.")) touchedBlocks.add(op.entity);
    else if (op.payload.kind.startsWith("page.")) touchedPages.add(op.entity);
  }
  for (const blockId of touchedBlocks) reindexBlockAndSubtree(driver, blockId);
  for (const pageId of touchedPages) {
    driver.run(
      "INSERT OR IGNORE INTO embed_dirty(unit_kind, unit_id, enqueued_at) VALUES ('page', ?, ?)",
      [pageId, Date.now()],
    );
  }
}

/** Recompute `ref` for one block and `path_ref` for it and every descendant (sql-schema.md rule 12). */
function reindexBlockAndSubtree(driver: SqlDriver, blockId: string): void {
  const block = driver.get<{
    id: string;
    page_id: string;
    content: string;
    deleted_at: number | null;
  }>("SELECT id, page_id, content, deleted_at FROM block WHERE id = ?", [blockId]);
  if (!block) {
    // Block never existed (a rejected create) or was hard-deleted: nothing to index.
    driver.run("DELETE FROM ref WHERE src_block_id = ?", [blockId]);
    driver.run("DELETE FROM path_ref WHERE block_id = ?", [blockId]);
    return;
  }
  rebuildRefRows(driver, block.id, block.page_id, block.content);
  for (const id of subtreeIds(driver, blockId)) rebuildPathRef(driver, id);
  driver.run(
    "INSERT OR IGNORE INTO embed_dirty(unit_kind, unit_id, enqueued_at) VALUES ('block', ?, ?)",
    [blockId, Date.now()],
  );
}

function rebuildRefRows(driver: SqlDriver, blockId: string, pageId: string, content: string): void {
  driver.run("DELETE FROM ref WHERE src_block_id = ?", [blockId]);
  const props = driver.all<{ key: string; value: string | null }>(
    "SELECT key, value FROM block_prop WHERE block_id = ? AND value IS NOT NULL",
    [blockId],
  );
  const properties: Record<string, string> = {};
  for (const p of props) if (p.value !== null) properties[p.key] = p.value;
  const extracted = extractRefs(content, properties);

  const insert = (kind: "page" | "tag", key: string): void => {
    const pageKey = normalizeKey(key);
    const target = driver.get<{ id: string }>(
      "SELECT id FROM page WHERE key = ? AND deleted_at IS NULL",
      [pageKey],
    );
    driver.run(
      "INSERT INTO ref(src_block_id, src_page_id, kind, dst_page_key, dst_page_id, dst_block_id) VALUES (?, ?, ?, ?, ?, NULL)",
      [blockId, pageId, kind, pageKey, target?.id ?? null],
    );
  };
  for (const p of extracted.pageRefs) insert("page", p);
  for (const t of extracted.tags) insert("tag", t);
  for (const blockRefId of extracted.blockRefs) {
    const target = driver.get<{ id: string; page_id: string }>(
      "SELECT id, page_id FROM block WHERE id = ?",
      [blockRefId],
    );
    const dstPage = target
      ? driver.get<{ key: string }>("SELECT key FROM page WHERE id = ?", [target.page_id])
      : undefined;
    driver.run(
      "INSERT INTO ref(src_block_id, src_page_id, kind, dst_page_key, dst_page_id, dst_block_id) VALUES (?, ?, 'block', ?, ?, ?)",
      [blockId, pageId, dstPage?.key ?? null, target?.page_id ?? null, blockRefId],
    );
  }
  // tokenizeContent also surfaces embed targets that extractRefs's simpler scan may not fully
  // resolve to a block id (e.g. {{embed ((id))}}); reuse the same targets already collected above
  // via extractRefs's blockRefs/pageRefs (per REF-1, an embed's ((id))/[[page]] argument already
  // matches the ((...))/[[...]] token rules, so no separate embed-specific extraction is needed).
  void tokenizeContent; // reserved for a future richer embed/kind distinction; not needed for v1 refs.
}

function normalizeKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function subtreeIds(driver: SqlDriver, rootId: string): string[] {
  const ids: string[] = [rootId];
  const queue = [rootId];
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    const children = driver.all<{ id: string }>("SELECT id FROM block WHERE parent_id = ?", [
      parent,
    ]);
    for (const c of children) {
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  return ids;
}

function rebuildPathRef(driver: SqlDriver, blockId: string): void {
  driver.run("DELETE FROM path_ref WHERE block_id = ?", [blockId]);
  const keys = new Map<string, string | null>();
  let cur = driver.get<{ id: string; page_id: string; parent_id: string | null }>(
    "SELECT id, page_id, parent_id FROM block WHERE id = ?",
    [blockId],
  );
  if (!cur) return;
  const page = driver.get<{ key: string; id: string }>("SELECT key, id FROM page WHERE id = ?", [
    cur.page_id,
  ]);
  if (page) keys.set(page.key, page.id);

  let guard = 0;
  while (cur && guard++ < 1000) {
    const selfRefs = driver.all<{ dst_page_key: string | null; dst_page_id: string | null }>(
      "SELECT DISTINCT dst_page_key, dst_page_id FROM ref WHERE src_block_id = ? AND dst_page_key IS NOT NULL",
      [cur.id],
    );
    for (const r of selfRefs) if (r.dst_page_key) keys.set(r.dst_page_key, r.dst_page_id);
    cur = cur.parent_id
      ? driver.get<{ id: string; page_id: string; parent_id: string | null }>(
          "SELECT id, page_id, parent_id FROM block WHERE id = ?",
          [cur.parent_id],
        )
      : undefined;
  }
  for (const [key, pageId] of keys) {
    driver.run("INSERT OR IGNORE INTO path_ref(block_id, page_key, page_id) VALUES (?, ?, ?)", [
      blockId,
      key,
      pageId,
    ]);
  }
}

/**
 * One `changes` row per entity touched by `ops`, sharing `batchId` (sql-schema.md rule 21),
 * now also carrying a full pre/post snapshot in `before_json`/`after_json` (ADR 013): `batch_undo`
 * reconstructs compensating ops from these rather than from the ops' own per-field payloads. A page
 * or block absent from `before`/`after` (should not happen — every touched entity was snapshotted
 * on both sides of `coreApplyOps` above) falls back to `null`, matching "entity did not exist".
 */
function recordChanges(
  driver: SqlDriver,
  ops: readonly Op[],
  results: readonly AppliedOpResult[],
  opts: ServerApplyOptions,
  batchId: string,
  before: ReadonlyMap<string, PageChangeSnapshot | BlockChangeSnapshot | null>,
  after: ReadonlyMap<string, PageChangeSnapshot | BlockChangeSnapshot | null>,
): void {
  const byEntity = new Map<string, { opIds: string[]; kind: string }>();
  for (const op of ops) {
    const result = results.find((r) => r.id === op.id);
    if (!result || result.status === "rejected") continue;
    const entry = byEntity.get(op.entity) ?? { opIds: [], kind: op.payload.kind };
    entry.opIds.push(op.id);
    byEntity.set(op.entity, entry);
  }
  const now = Date.now();
  for (const [entityId, { opIds, kind }] of byEntity) {
    const entityType = kind.startsWith("page.") ? "page" : "block";
    const beforeSnap = before.get(entityId) ?? null;
    const afterSnap = after.get(entityId) ?? null;
    driver.run(
      `INSERT INTO changes(graph_id, batch_id, origin, actor, entity_type, entity_id, op_ids_json, before_json, after_json, created_at)
       VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        batchId,
        opts.origin,
        opts.actor,
        entityType,
        entityId,
        JSON.stringify(opIds),
        beforeSnap === null ? null : JSON.stringify(beforeSnap),
        afterSnap === null ? null : JSON.stringify(afterSnap),
        now,
      ],
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Change-audit snapshots (ADR 013): a full pre/post image per touched page/block, cheap (one row
// query + one small property-rows query per entity), used only by `recordChanges` above and by
// `batch.undo` (`./ops/batch-undo.ts`) to reconstruct compensating ops. Kept local to this file
// (small duplication of `data-api.ts`'s `formatDayTime`/`formatDoneIso`/property-flattening logic)
// rather than imported, since `data-api.ts` itself imports from this file — importing back would
// be circular.
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

/** `YYYYMMDD` + optional `HH:MM` -> `YYYY-MM-DD` / `YYYY-MM-DD HH:MM` (ADR 011 wire format) —
 *  duplicated from `data-api.ts`'s `formatDayTime` to avoid a circular import (see header above). */
function snapshotFormatDayTime(day: number, time: string | null): string {
  const s = String(day);
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return time ? `${iso} ${time}` : iso;
}

/** Epoch ms -> `YYYY-MM-DDTHH:MM:SSZ`, duplicated from `data-api.ts`'s `formatDoneIso` (same
 *  circular-import reason as `snapshotFormatDayTime` above). */
function snapshotFormatDoneIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function snapshotPage(driver: SqlDriver, id: string): PageChangeSnapshot | null {
  const row = driver.get<{ name: string; journal_day: number | null; deleted_at: number | null }>(
    "SELECT name, journal_day, deleted_at FROM page WHERE id = ?",
    [id],
  );
  if (!row) return null;
  const propRows = driver.all<{ key: string; value: string | null }>(
    "SELECT key, value FROM page_prop WHERE page_id = ? AND value IS NOT NULL",
    [id],
  );
  const properties: Record<string, string> = {};
  for (const p of propRows) if (p.value !== null) properties[p.key] = p.value;
  return { name: row.name, journal_day: row.journal_day, properties, deleted_at: row.deleted_at };
}

export function snapshotBlock(driver: SqlDriver, id: string): BlockChangeSnapshot | null {
  const row = driver.get<{
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
    deleted_at: number | null;
  }>(
    `SELECT page_id, parent_id, order_key, content, marker, priority, collapsed,
            scheduled_day, scheduled_time, deadline_day, deadline_time, repeat, done_at, deleted_at
     FROM block WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  const propRows = driver.all<{ key: string; value: string | null }>(
    "SELECT key, value FROM block_prop WHERE block_id = ? AND value IS NOT NULL",
    [id],
  );
  const properties: Record<string, string> = {};
  for (const p of propRows) if (p.value !== null) properties[p.key] = p.value;
  if (row.scheduled_day !== null) {
    properties.scheduled = snapshotFormatDayTime(row.scheduled_day, row.scheduled_time);
  }
  if (row.deadline_day !== null) {
    properties.deadline = snapshotFormatDayTime(row.deadline_day, row.deadline_time);
  }
  if (row.repeat !== null) properties.repeat = row.repeat;
  if (row.done_at !== null) properties.done = snapshotFormatDoneIso(row.done_at);
  return {
    place: { pageId: row.page_id, parentId: row.parent_id, order: row.order_key },
    content: row.content,
    marker: row.marker,
    priority: row.priority,
    collapsed: row.collapsed !== 0,
    properties,
    deleted_at: row.deleted_at,
  };
}

/** Snapshot every entity `ops` targets (page.* -> page id, block.* -> block id), deduped. Called
 *  once before and once after `coreApplyOps` runs (see `serverApplyOps` above). */
function snapshotEntities(
  driver: SqlDriver,
  ops: readonly Op[],
): Map<string, PageChangeSnapshot | BlockChangeSnapshot | null> {
  const kinds = new Map<string, "page" | "block">();
  for (const op of ops) {
    if (op.payload.kind.startsWith("page.")) kinds.set(op.entity, "page");
    else if (op.payload.kind.startsWith("block.")) kinds.set(op.entity, "block");
  }
  const snapshots = new Map<string, PageChangeSnapshot | BlockChangeSnapshot | null>();
  for (const [entityId, kind] of kinds) {
    snapshots.set(
      entityId,
      kind === "page" ? snapshotPage(driver, entityId) : snapshotBlock(driver, entityId),
    );
  }
  return snapshots;
}

export type { OpPayload };
