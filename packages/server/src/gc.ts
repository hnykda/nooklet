/**
 * `nooklet gc`: wires `@nooklet/core`'s `planOpLogGc` (already built and tested there, pure
 * partitioning logic) into this package's actual `device`/`token` bookkeeping and `op` table
 * (M6, PLAN.md §15/§16: "op log kept forever" is the risk mitigation, but a home server running
 * for years needs a deliberate, safe way to trim it -- this is that "deliberate" part).
 *
 * Floor computation (research/03-sync.md §6.5, `../core/src/sync/gc.ts`'s own docstring):
 * `MIN(device.acked_seq)` over every *live* device (one whose token hasn't been revoked -- a
 * device tied to a revoked token will never pull again, so its stale `acked_seq` must not hold
 * the floor down forever), clamped to never exceed the op log's own current tip (`MAX(op.seq)`,
 * i.e. exactly what `GET /sync/snapshot` would report as `cursor` if called right now -- there is
 * nothing to GC beyond "everything", and `planOpLogGc` already degrades gracefully there, but
 * computing the clamp explicitly keeps the floor a meaningful, reportable number rather than an
 * arbitrary large one).
 *
 * Safety-first refusals:
 *   - No device has ever synced at all: refuse. There's no basis to compute a floor from, and a
 *     future first device bootstraps via `/sync/snapshot` (full state, not a log replay) so it
 *     never needs the log to go back further than "whenever it first connects" -- but until one
 *     actually has, "safe to delete" cannot be established, so we don't guess.
 *   - Any live device has `acked_seq = 0`: refuse. A freshly-registered device also starts at 0
 *     (`touchDeviceOnPush`), so 0 means either "never pulled" or "genuinely caught up to nothing
 *     yet" -- both cases make its true position unknown/zero, and either way GC must not proceed
 *     while *any* live device's floor can't be confirmed above zero.
 *
 * ORPHAN ASSETS (M7 item 10a, research/13 §3.1: Logseq's most-voted assets request is "view and
 * delete orphan assets"): the second thing this command collects. An asset is a file under
 * `<dataDir>/assets/<id>.<ext>` plus an `asset` row, referenced from block text (and, rarely, a
 * property value) as `assets/<id>.<ext>` -- the importer rewrites every Logseq link to that form
 * and `asset.upload` hands it out, so that string is the only way anything points at an asset.
 * Nothing ever removed one before this; a picture pasted and then deleted from the block stayed
 * on disk forever.
 *
 *   - **Referenced** by a live block/property: kept, obviously.
 *   - **Referenced only from the trash** (a tombstoned block, or a block on a deleted page):
 *     kept. The trash has no expiry (ADR 022), and a page restored from it must not come back
 *     with broken images.
 *   - **Referenced only from page history** (a page/block pre- or post-image in `changes`, e.g.
 *     the link was removed by an edit): kept, for the same reason one step further. "Restore this
 *     version" is `batch.undo` of the newer batches (ADR 022 §3), which rewrites block text from
 *     `changes.before_json`; collecting the file turned that restore into a broken image,
 *     recoverable only from the pre-GC backup archive (M7 server/sync review, F10). `changes` is
 *     never trimmed, so this keeps any asset a recorded write ever embedded; what the GC still
 *     collects is uploads no write ever pointed at (an agent's `asset_upload` never used, a paste
 *     whose block write never reached the server).
 *   - **Unreferenced but younger than the grace period**: left alone this run. The one legitimate
 *     way an asset is briefly unreferenced is between the upload and the write that embeds it --
 *     an agent's `asset_upload` followed by `block_update`, or the editor's paste, whose block op
 *     sits in the device's push queue until it next syncs. That queue can wait out a closed laptop,
 *     so the grace is DAYS, not seconds: 7 by default (`--asset-grace`), long enough for a week
 *     away, short enough that a monthly `nooklet gc` still collects. A `changes` row for the asset
 *     newer than the cutoff also counts as recent, so a future "touched on re-upload" audit row
 *     (docs/BUGS.md B-91: a deduplicated re-upload of an orphan currently records nothing) will
 *     extend the grace without this file changing.
 *   - **Otherwise**: an orphan. Reported by `--dry-run`; removed by a real run -- the row is
 *     tombstoned (`deleted_at`, so the same bytes can be uploaded again fresh) and the file
 *     unlinked, after the same automatic backup the op-log half takes (the backup archive
 *     includes `assets/`, so the file is recoverable from it).
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { LoggedOp, Op, OpPayload, SqlDriver } from "@nooklet/core";
import { planOpLogGc } from "@nooklet/core";
import type { ServerContext } from "./apply-ops.js";
import { createBackup, fileSizeOf, graphDbPath } from "./backup/index.js";

export interface GcBlockingDevice {
  id: string;
  name: string;
  ackedSeq: number;
}

export interface GcFloor {
  /** `null` when GC must be refused -- see `reason`. */
  floor: number | null;
  reason?: string;
  blockingDevices: GcBlockingDevice[];
  liveDeviceCount: number;
  /** `MAX(op.seq)`, i.e. what `/sync/snapshot` would currently report as `cursor`. */
  currentTip: number;
}

interface DeviceRow {
  id: string;
  name: string;
  acked_seq: number;
}

/** `MIN(device.acked_seq)` over live (non-revoked-token) devices, clamped to the log's current
 * tip -- see file header for the full reasoning and the refusal conditions. Pure read, no
 * mutation: safe to call speculatively (this is exactly what `--dry-run` and `nooklet gc`'s
 * up-front report use). */
export function computeGcFloor(driver: SqlDriver): GcFloor {
  const currentTip = driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM op")?.n ?? 0;
  const devices = driver.all<DeviceRow>(
    `SELECT d.id, d.name, d.acked_seq
     FROM device d JOIN token t ON t.id = d.token_id
     WHERE t.revoked_at IS NULL`,
  );

  if (devices.length === 0) {
    return {
      floor: null,
      reason: "no device has ever synced yet; there is no basis to compute a safe GC floor from",
      blockingDevices: [],
      liveDeviceCount: 0,
      currentTip,
    };
  }

  const neverAcked = devices.filter((d) => d.acked_seq === 0);
  if (neverAcked.length > 0) {
    return {
      floor: null,
      reason:
        `${neverAcked.length} of ${devices.length} live device(s) have acked_seq = 0 (never ` +
        "pulled, or genuinely caught up to nothing) -- their floor is unknown, refusing to GC",
      blockingDevices: neverAcked.map((d) => ({ id: d.id, name: d.name, ackedSeq: d.acked_seq })),
      liveDeviceCount: devices.length,
      currentTip,
    };
  }

  const minAcked = Math.min(...devices.map((d) => d.acked_seq));
  return {
    floor: Math.min(minAcked, currentTip),
    blockingDevices: [],
    liveDeviceCount: devices.length,
    currentTip,
  };
}

interface OpRow {
  seq: number;
  id: string;
  hlc: string;
  device_id: string;
  entity: string;
  payload_json: string;
  status: LoggedOp["status"];
}

function loadFullLog(driver: SqlDriver): LoggedOp[] {
  const rows = driver.all<OpRow>(
    "SELECT seq, id, hlc, device_id, entity, payload_json, status FROM op ORDER BY seq",
  );
  return rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    hlc: r.hlc,
    device: r.device_id,
    entity: r.entity,
    payload: JSON.parse(r.payload_json) as OpPayload,
    status: r.status,
  }));
}

// ---------------------------------------------------------------------------------------------
// Orphan assets (see file header)
// ---------------------------------------------------------------------------------------------

export const DEFAULT_ASSET_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrphanAsset {
  id: string;
  ext: string;
  fileName: string;
  byteSize: number;
  createdAt: number;
}

export interface AssetGcPlan {
  graceDays: number;
  /** Live `asset` rows in total. */
  total: number;
  /** Unreferenced anywhere and older than the grace period: what a real run removes. */
  orphans: OrphanAsset[];
  /** Unreferenced but younger than the grace period (or touched by a recent audit row). */
  inGrace: number;
  /** Referenced only from tombstoned blocks or deleted pages: kept for the trash. */
  keptByTrashOnly: number;
  /** Referenced by no block or page, live or trashed, but by a page/block image in `changes`:
   * kept so restoring an older version (`batch.undo`) does not bring back a broken image. */
  keptByHistoryOnly: number;
}

/** `assets/<id>.<ext>` wherever it appears in text. Ids are `newId()` strings; the character
 * class is deliberately loose (the asset table, not this regex, decides what is an asset id). */
const ASSET_REF_RE = /assets\/([0-9a-z]{8,32})\.[a-z0-9]{1,8}/gi;

interface RefRow {
  text: string;
  live: number;
}

/** Every asset id mentioned anywhere, split by whether the mention is live, trashed, or only in
 * history. One pass over the few rows that contain `assets/` at all, rather than a full scan per
 * asset. */
function referencedAssetIds(driver: SqlDriver): {
  live: Set<string>;
  any: Set<string>;
  history: Set<string>;
} {
  const rows: RefRow[] = [
    ...driver.all<RefRow>(
      `SELECT b.content AS text, (b.deleted_at IS NULL AND p.deleted_at IS NULL) AS live
       FROM block b JOIN page p ON p.id = b.page_id
       WHERE instr(b.content, 'assets/') > 0`,
    ),
    ...driver.all<RefRow>(
      `SELECT bp.value AS text, (b.deleted_at IS NULL AND p.deleted_at IS NULL) AS live
       FROM block_prop bp JOIN block b ON b.id = bp.block_id JOIN page p ON p.id = b.page_id
       WHERE bp.value IS NOT NULL AND instr(bp.value, 'assets/') > 0`,
    ),
    ...driver.all<RefRow>(
      `SELECT pp.value AS text, (p.deleted_at IS NULL) AS live
       FROM page_prop pp JOIN page p ON p.id = pp.page_id
       WHERE pp.value IS NOT NULL AND instr(pp.value, 'assets/') > 0`,
    ),
  ];
  const live = new Set<string>();
  const any = new Set<string>();
  for (const r of rows) {
    for (const m of r.text.matchAll(ASSET_REF_RE)) {
      const id = m[1] as string;
      any.add(id);
      if (r.live) live.add(id);
    }
  }
  // Page and block images only. An asset's own `changes` rows (its upload, a deduplicated
  // re-upload) describe it by file name today, not by path — filtered anyway, so a future shape
  // of those rows cannot make every asset look referenced.
  const history = new Set<string>();
  const historyRows = driver.all<{ before: string | null; after: string | null }>(
    `SELECT before_json AS before, after_json AS after FROM changes
      WHERE entity_type IN ('page', 'block')
        AND (instr(before_json, 'assets/') > 0 OR instr(after_json, 'assets/') > 0)`,
  );
  for (const r of historyRows) {
    for (const text of [r.before, r.after]) {
      if (text === null) continue;
      for (const m of text.matchAll(ASSET_REF_RE)) history.add(m[1] as string);
    }
  }
  return { live, any, history };
}

interface AssetRow {
  id: string;
  ext: string;
  file_name: string;
  byte_size: number;
  created_at: number;
}

/** Classify every live asset without touching anything -- what `--dry-run` reports. */
export function planAssetGc(
  driver: SqlDriver,
  opts: { graceDays?: number; now?: number } = {},
): AssetGcPlan {
  const graceDays = opts.graceDays ?? DEFAULT_ASSET_GRACE_DAYS;
  const now = opts.now ?? Date.now();
  const cutoff = now - graceDays * DAY_MS;
  const refs = referencedAssetIds(driver);
  const assets = driver.all<AssetRow>(
    "SELECT id, ext, file_name, byte_size, created_at FROM asset WHERE deleted_at IS NULL ORDER BY created_at, id",
  );
  const plan: AssetGcPlan = {
    graceDays,
    total: assets.length,
    orphans: [],
    inGrace: 0,
    keptByTrashOnly: 0,
    keptByHistoryOnly: 0,
  };
  for (const a of assets) {
    if (refs.live.has(a.id)) continue;
    if (refs.any.has(a.id)) {
      plan.keptByTrashOnly++;
      continue;
    }
    if (refs.history.has(a.id)) {
      plan.keptByHistoryOnly++;
      continue;
    }
    const touchedRecently =
      a.created_at > cutoff ||
      driver.get(
        "SELECT 1 FROM changes WHERE entity_type = 'asset' AND entity_id = ? AND created_at > ? LIMIT 1",
        [a.id, cutoff],
      ) !== undefined;
    if (touchedRecently) {
      plan.inGrace++;
      continue;
    }
    plan.orphans.push({
      id: a.id,
      ext: a.ext,
      fileName: a.file_name,
      byteSize: a.byte_size,
      createdAt: a.created_at,
    });
  }
  return plan;
}

/** Tombstone each orphan's row and unlink its file. A file already missing on disk is not an
 * error -- the row was the stale part, and it is gone now too. */
function removeOrphanAssets(
  driver: SqlDriver,
  dataDir: string,
  orphans: readonly OrphanAsset[],
  now: number,
): { removed: number; reclaimedBytes: number } {
  let reclaimedBytes = 0;
  for (const a of orphans) {
    const path = join(dataDir, "assets", `${a.id}.${a.ext}`);
    const size = fileSizeOf(path);
    driver.run("UPDATE asset SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", [now, a.id]);
    try {
      unlinkSync(path);
      reclaimedBytes += size ?? a.byteSize;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return { removed: orphans.length, reclaimedBytes };
}

export interface AssetGcReport extends AssetGcPlan {
  /** Orphans actually removed (0 on a dry run). */
  removed: number;
  /** Bytes of asset files unlinked. */
  reclaimedBytes: number;
}

export interface GcReport {
  dryRun: boolean;
  /** The op-log half was refused (`reason` says why). Asset GC does not depend on devices and
   * runs regardless. */
  refused: boolean;
  reason?: string;
  blockingDevices: GcBlockingDevice[];
  floor: number | null;
  dropCount: number;
  retainCount: number;
  /** Set only on a real (non-dry-run) run that removed something and wasn't `--no-backup`. */
  backupPath?: string;
  /** Bytes reclaimed in the database file (post-`VACUUM`), when it is file-backed. */
  reclaimedBytes?: number;
  assets: AssetGcReport;
}

export interface RunGcOptions {
  dataDir: string;
  dryRun?: boolean;
  /** Skip the automatic pre-GC backup. Only meaningful when `dryRun` is false. */
  noBackup?: boolean;
  /** Days an unreferenced asset must have existed before it counts as an orphan (default 7). */
  assetGraceDays?: number;
}

/** Compute the GC plan without mutating anything -- used by both `runGc` (dry or real) and
 * `nooklet gc --dry-run` reporting. */
export function planGc(driver: SqlDriver): {
  floor: GcFloor;
  drop: readonly LoggedOp[];
  retain: readonly LoggedOp[];
} {
  const floor = computeGcFloor(driver);
  if (floor.floor === null) return { floor, drop: [], retain: [] };
  const log = loadFullLog(driver);
  const plan = planOpLogGc(log, floor.floor);
  return { floor, drop: plan.drop, retain: plan.retain };
}

/**
 * Run GC for real (or report what it would do, with `dryRun: true`): compute the floor and plan,
 * refuse per `computeGcFloor`'s rules, otherwise (unless dry-run) take an automatic backup (unless
 * `noBackup`) and then delete every `op` row the plan covers, followed by a `VACUUM` to actually
 * reclaim the freed pages on disk (a bare `DELETE` leaves SQLite's file size unchanged until
 * something vacuums it -- `docs/spec/sql-schema.md` rule 28 calls the op log the single largest
 * contributor to file size at scale, so this is the whole point of running GC at all).
 */
export async function runGc(ctx: ServerContext, opts: RunGcOptions): Promise<GcReport> {
  const dryRun = opts.dryRun ?? false;
  const now = Date.now();
  const { floor, drop, retain } = planGc(ctx.driver);
  const assetPlan = planAssetGc(ctx.driver, { graceDays: opts.assetGraceDays, now });

  const base: GcReport = {
    dryRun,
    refused: floor.floor === null,
    reason: floor.reason,
    blockingDevices: floor.blockingDevices,
    floor: floor.floor,
    dropCount: drop.length,
    retainCount: retain.length,
    assets: { ...assetPlan, removed: 0, reclaimedBytes: 0 },
  };
  const willDropOps = floor.floor !== null && drop.length > 0;
  const willRemoveAssets = assetPlan.orphans.length > 0;
  if (dryRun || (!willDropOps && !willRemoveAssets)) return base;

  // One backup covers both halves: the archive holds the database (with the ops about to be
  // dropped) AND `assets/` (with the files about to be unlinked).
  let backupPath: string | undefined;
  if (!opts.noBackup) {
    backupPath = (await createBackup(ctx.driver, { dataDir: opts.dataDir })).path;
  }

  let reclaimedBytes: number | undefined;
  if (willDropOps) {
    const dbFile = graphDbPath(opts.dataDir);
    const sizeBefore = fileSizeOf(dbFile);
    ctx.driver.run("DELETE FROM op WHERE seq < ?", [floor.floor]);
    ctx.driver.exec("VACUUM");
    const sizeAfter = fileSizeOf(dbFile);
    reclaimedBytes =
      sizeBefore !== undefined && sizeAfter !== undefined ? sizeBefore - sizeAfter : undefined;
  }

  const assets = willRemoveAssets
    ? { ...assetPlan, ...removeOrphanAssets(ctx.driver, opts.dataDir, assetPlan.orphans, now) }
    : base.assets;

  return { ...base, backupPath, reclaimedBytes, assets };
}

/** Re-exported so callers/tests that already have `Op`/`LoggedOp` types in scope don't need a
 * separate import just for this module's return-type shapes. */
export type { LoggedOp, Op };
