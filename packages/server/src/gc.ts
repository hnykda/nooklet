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
 */

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

export interface GcReport {
  dryRun: boolean;
  refused: boolean;
  reason?: string;
  blockingDevices: GcBlockingDevice[];
  floor: number | null;
  dropCount: number;
  retainCount: number;
  /** Set only on a real (non-dry-run) run that actually dropped rows and wasn't `--no-backup`. */
  backupPath?: string;
  /** Bytes reclaimed on disk (post-`VACUUM`), when the database is file-backed. */
  reclaimedBytes?: number;
}

export interface RunGcOptions {
  dataDir: string;
  dryRun?: boolean;
  /** Skip the automatic pre-GC backup. Only meaningful when `dryRun` is false. */
  noBackup?: boolean;
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
export function runGc(ctx: ServerContext, opts: RunGcOptions): GcReport {
  const dryRun = opts.dryRun ?? false;
  const { floor, drop, retain } = planGc(ctx.driver);

  const base: GcReport = {
    dryRun,
    refused: floor.floor === null,
    reason: floor.reason,
    blockingDevices: floor.blockingDevices,
    floor: floor.floor,
    dropCount: drop.length,
    retainCount: retain.length,
  };
  if (floor.floor === null || dryRun || drop.length === 0) return base;

  let backupPath: string | undefined;
  if (!opts.noBackup) {
    backupPath = createBackup(ctx.driver, { dataDir: opts.dataDir }).path;
  }

  const dbFile = graphDbPath(opts.dataDir);
  const sizeBefore = fileSizeOf(dbFile);

  ctx.driver.run("DELETE FROM op WHERE seq < ?", [floor.floor]);
  ctx.driver.exec("VACUUM");

  const sizeAfter = fileSizeOf(dbFile);
  const reclaimedBytes =
    sizeBefore !== undefined && sizeAfter !== undefined ? sizeBefore - sizeAfter : undefined;

  return { ...base, backupPath, reclaimedBytes };
}

/** Re-exported so callers/tests that already have `Op`/`LoggedOp` types in scope don't need a
 * separate import just for this module's return-type shapes. */
export type { LoggedOp, Op };
