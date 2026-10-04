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
import { applyOps as coreApplyOps, Hlc, makeOp, newId, reindexRefs } from "@nooklet/core";
import { runBeforeWrite } from "./plugins/before-write.js";
import { planReferencedPages, REFERENCE_DEVICE_ID, referenceKeysBefore } from "./ref-pages.js";
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
  /**
   * `"skip"` leaves references to missing pages dangling instead of creating the pages (ADR 024,
   * `./ref-pages.ts`). Only for a writer that creates the referenced pages itself later — the
   * importer, whose page B would otherwise already exist, minted from page A's `[[B]]`, when B's
   * own file arrives — and that runs `mintDanglingReferencedPages` once it is done.
   */
  referencedPages?: "mint" | "skip";
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

    let allOps = ops.concat(corrections);
    const mintPages = opts.referencedPages !== "skip";
    // Read before re-indexing: `ref`/`page_tag` still describe the pre-batch state here.
    const keysBefore = mintPages ? referenceKeysBefore(driver, allOps, beforeSnapshots) : undefined;
    reindexTouchedEntities(driver, allOps);
    // ADR 024: a reference makes its page exist, and an unclaimed page it made goes with its last
    // reference — decided here, in the same transaction, as logged server ops (`./ref-pages.ts`).
    if (keysBefore) {
      const pageOps = planReferencedPages(driver, allOps, keysBefore, beforeSnapshots, (e, p) =>
        makeOp(ctx.hlc.next(), REFERENCE_DEVICE_ID, e, p),
      );
      if (pageOps.length > 0) {
        for (const op of pageOps) {
          if (!beforeSnapshots.has(op.entity))
            beforeSnapshots.set(op.entity, snapshotPage(driver, op.entity));
        }
        corrections.push(...pageOps);
        for (const one of coreApplyOps(driver, pageOps).results) r.results.push(one);
        reindexTouchedEntities(driver, pageOps);
        allOps = ops.concat(corrections);
      }
    }
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

/** Rebuild `ref`/`path_ref`/`page_tag`/`page_alias` for exactly the blocks and pages an op could
 *  have changed (`@nooklet/core`'s `reindexRefs`, the same code a client replica keeps its copy
 *  with, B-641), and enqueue `embed_dirty`. Idempotent and cheap to call even for a noop/rejected
 *  op — it re-derives from current state rather than trusting the op's own before/after. */
function reindexTouchedEntities(driver: SqlDriver, ops: readonly Op[]): void {
  const touchedBlocks = new Set<string>();
  const touchedPages = new Set<string>();
  for (const op of ops) {
    if (op.payload.kind.startsWith("block.")) touchedBlocks.add(op.entity);
    else if (op.payload.kind.startsWith("page.")) touchedPages.add(op.entity);
  }
  const now = Date.now();
  for (const blockId of reindexRefs(driver, touchedBlocks, touchedPages)) {
    driver.run(
      "INSERT OR IGNORE INTO embed_dirty(unit_kind, unit_id, enqueued_at) VALUES ('block', ?, ?)",
      [blockId, now],
    );
  }
  for (const pageId of touchedPages) {
    driver.run(
      "INSERT OR IGNORE INTO embed_dirty(unit_kind, unit_id, enqueued_at) VALUES ('page', ?, ?)",
      [pageId, now],
    );
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
  // One Map, not `results.find` per op: that was quadratic in the batch, and `graph.replace` sends
  // up to 20,000 blocks through one call (16k ops: 1.3 s of lookups alone, F8 in
  // docs/review/2026-09-13-m7-rv-server-sync.md, tools/probes/apply-ops-batch-scaling.ts).
  const resultById = new Map(results.map((r) => [r.id, r]));
  for (const op of ops) {
    const result = resultById.get(op.id);
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
