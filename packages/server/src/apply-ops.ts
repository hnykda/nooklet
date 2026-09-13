/**
 * The server's actual single write path (ADR 003/008): wraps `@nooklet/core`'s `applyOps` (the
 * page/block/block_prop/page_prop state-mutation primitive, which has no server role) with
 * everything a real server must additionally do, per `docs/spec/sql-schema.md` rule 24:
 *
 *  - emit a **corrective op** with a server-owned HLC when a `block.place` is rejected for a
 *    cycle, so every client converges on the same decision (core deliberately does not do this);
 *  - emit server-HLC `block.place` ops that bring a page-changing block's descendants onto its
 *    new page, whoever authored the move (B-120, `./subtree-page-repair.ts`);
 *  - maintain the derived `ref`/`path_ref` tables from `extractRefs`/`tokenizeContent`;
 *  - enqueue `embed_dirty` for anything whose text a future embeddings worker (M3) should re-index;
 *  - write one `changes` row per touched entity, for `changes_since`/audit/attribution.
 *
 * `block_fts`/`block_tri`/`page_fts`/`page_tri` update themselves via SQL triggers (schema.ts) and
 * need no code here.
 */

import type { AppliedOpResult, ApplyOpsResult, Op, OpPayload, SqlDriver } from "@nooklet/core";
import {
  canonicalRefName,
  applyOps as coreApplyOps,
  extractRefs,
  Hlc,
  makeOp,
  newId,
  normalizePageName,
} from "@nooklet/core";
import { reindexPageIdentity, resolvePageIdForKey } from "./page-aliases.js";
import { rebuildPageTags } from "./page-tags.js";
import { runBeforeWrite } from "./plugins/before-write.js";
import {
  type BlockChangeSnapshot,
  type PageChangeSnapshot,
  snapshotBlock,
  snapshotPage,
} from "./rows.js";
import { planSubtreePageRepair } from "./subtree-page-repair.js";
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
  /** Ops the server authored and applied in the same transaction: the correction for a rejected
   * `block.place` (rule 24), and the moves that bring a page-changing block's descendants along
   * (B-120, `./subtree-page-repair.ts`). */
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
    // are per-field deltas, not full snapshots). Snapshot BEFORE applying. A cycle correction
    // (below) only touches an entity `ops` already names; the subtree repair can touch
    // descendants `ops` never named, and snapshots those itself just before it applies.
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

    // B-120: a block that changed page takes its descendants with it, whoever moved it — see
    // `./subtree-page-repair.ts`. A repaired descendant `ops` never named has not changed yet, so
    // its snapshot taken now is its pre-batch image.
    const repairs = planSubtreePageRepair(
      driver,
      ops.concat(corrections),
      r.results,
      beforeSnapshots,
      (entity, place) =>
        makeOp(ctx.hlc.next(), SERVER_DEVICE_ID, entity, { kind: "block.place", place }),
    );
    if (repairs.length > 0) {
      for (const op of repairs) {
        if (!beforeSnapshots.has(op.entity))
          beforeSnapshots.set(op.entity, snapshotBlock(driver, op.entity));
      }
      corrections.push(...repairs);
      for (const one of coreApplyOps(driver, repairs).results) r.results.push(one);
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
    // Page-level tags are derived from the page's `tags` property and its journal day, so any
    // page write can change them (ADR 017) — the page equivalent of `rebuildRefRows` above.
    rebuildPageTags(driver, pageId);
    // Likewise its aliases (`alias::`), and — because a page write can change what its name
    // resolves to (create, rename, delete) — every reference addressed by any name this page
    // answered to before or answers to now. Runs AFTER the block loop above so a batch that
    // creates a page and a block referencing it in one go ends up resolved either way.
    reindexPageIdentity(driver, pageId);
    driver.run(
      "INSERT OR IGNORE INTO embed_dirty(unit_kind, unit_id, enqueued_at) VALUES ('page', ?, ?)",
      [pageId, Date.now()],
    );
  }
}

/** Recompute `ref` for one block and `path_ref` for it and every descendant (sql-schema.md rule 12).
 * Exported for the one-time re-index in `./ref-reindex.ts`, which must rebuild both. */
export function reindexBlockAndSubtree(driver: SqlDriver, blockId: string): void {
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

/** The page every task block references. Capitalised because it is a page name people will see
 * and link to by hand; lookups normalise case anyway (`normalizeKey`). */
const TASK_TAG = "Task";

export function rebuildRefRows(
  driver: SqlDriver,
  blockId: string,
  pageId: string,
  content: string,
): void {
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
    driver.run(
      "INSERT INTO ref(src_block_id, src_page_id, kind, dst_page_key, dst_page_id, dst_block_id) VALUES (?, ?, ?, ?, ?, NULL)",
      [blockId, pageId, kind, pageKey, resolvePageIdForKey(driver, pageKey)],
    );
  };
  for (const p of extracted.pageRefs) insert("page", p);
  for (const t of extracted.tags) insert("tag", t);

  // A block with a task marker also refs the `Task` page, so tasks live in the same reference
  // machinery as everything else: `[[Task]]` lists them all, a tag query finds them, and nothing
  // has to special-case "tasks" as a separate concept.
  //
  // DERIVED from `block.marker` rather than written into the block's text as a literal `#Task`.
  // Writing it would put the same fact in two places that can disagree — delete the tag and you
  // have a task that is not a Task; change the marker by hand in the markdown mirror and the tag
  // is stale. Here the marker stays the single source of truth and the tag is a projection of it,
  // rebuilt on every write. Note the block is re-read from the database above, so the marker is
  // already current by the time this runs.
  const marked = driver.get<{ marker: string | null }>("SELECT marker FROM block WHERE id = ?", [
    blockId,
  ]);
  if (marked?.marker) insert("tag", TASK_TAG);
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
}

/**
 * The key a reference is indexed under. Case and whitespace are folded as ever; on top of that a
 * journal day written in any recognised title format collapses to its ISO name (ADR 018), so
 * `[[Mon, 07.09.2026]]`, `[[Sep 7th, 2026]]` and `[[2026-09-07]]` are one reference and land in
 * one backlinks list — and all three resolve to the page, which is stored under the ISO name.
 */
function normalizeKey(name: string): string {
  return normalizePageName(canonicalRefName(name));
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
