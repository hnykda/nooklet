/**
 * `nooklet verify`: the `rebuild()` parity check ADR 003 asks for ("state tables are a pure
 * function of the op log; `rebuild()` replays the log and must reproduce the state") and
 * `docs/spec/sql-schema.md` rule 26 spells out for dev mode ("A dev-mode server SHOULD run
 * `rebuild()` into a scratch database on every start and diff it against the live state tables").
 *
 * PLAN.md §16 calls this "the single best regression detector this system can have" for hand-
 * rolled sync bugs, so the bar here is a genuinely diagnostic report, not a bare boolean: every
 * divergence names its table, primary key, and column, live value vs. rebuilt value.
 *
 * Scope: exactly the four tables `@nooklet/core`'s `rebuild()` actually reproduces from the op log
 * -- `page`, `block`, `block_prop`, `page_prop`. `setting`/`keybinding`/`plugin` are NOT included:
 * despite rule 26's prose listing them, they are not currently op-log-backed (`../plugins/settings.ts`
 * writes `plugin.settings_json` directly via SQL, not through `applyOps`) -- there is no op kind
 * for them yet (`packages/core/src/ops.ts`'s `OpPayload` union has none), so replaying the op log
 * cannot reproduce them and diffing them here would only ever report false divergence. `ref`/
 * `path_ref`/FTS (rule 26's "phase 2 reindex") are derived-from-state, not part of state itself,
 * and are intentionally out of scope too (same reason `rebuild()` itself skips them during replay).
 *
 * Interaction with `nooklet gc`: GC (`./gc.ts`) only ever deletes rows from the `op` audit table,
 * never from the state tables it derives from -- so once GC has trimmed the log's head, replaying
 * "the whole op log" from empty can no longer reconstruct entities whose formative ops (their
 * `page.create`/`block.create`) were GC'd, even though live state still reflects them correctly.
 * This is a known, inherent tension between "GC the log" and "full rebuild-from-log parity" (see
 * `gc.ts`'s file header) -- `verifyRebuildParity` detects this case (`op`'s `MIN(seq) > 1`) and
 * reports it explicitly as a caveat rather than presenting resulting divergence as a false
 * regression alarm.
 */

import { rmSync } from "node:fs";
import { applyOps, initSchema, type Op, type OpPayload, type SqlDriver } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";

const STATE_TABLES = [
  { table: "page", pk: ["id"] },
  { table: "block", pk: ["id"] },
  { table: "block_prop", pk: ["block_id", "key"] },
  { table: "page_prop", pk: ["page_id", "key"] },
] as const;

export interface Divergence {
  table: string;
  /** The primary-key column(s) and their value(s), e.g. `{ id: "abc123" }` or
   * `{ block_id: "abc", key: "priority" }`. */
  key: Record<string, unknown>;
  kind: "missing-in-rebuild" | "extra-in-rebuild" | "column-mismatch";
  /** Set only for `kind: "column-mismatch"`. */
  column?: string;
  live?: unknown;
  rebuilt?: unknown;
}

export interface VerifyReport {
  ok: boolean;
  opCount: number;
  minSeq: number | null;
  maxSeq: number | null;
  /** True when `minSeq > 1`: the op log's head has been GC'd, so full-log rebuild is expected to
   * diverge for older entities -- see file header. Divergences are still reported in full; this
   * just flags that they may be GC artifacts rather than real bugs. */
  logTrimmed: boolean;
  /** Ops in the log the server rejected, left out of the replay (see `loadOpBatch`). */
  rejectedSkipped: number;
  divergences: Divergence[];
  /** Wall-clock time the replay + diff took, for the startup log line. */
  durationMs: number;
}

interface OpRow {
  id: string;
  hlc: string;
  device_id: string;
  entity: string;
  payload_json: string;
}

/**
 * Every op the server let take effect, in `seq` order — NOT the rejected ones (B-123).
 *
 * Whether a `page.create`, `page.rename` or page un-delete is rejected depends on the state it met
 * (`page-key-collision`, sql-schema.md rule 24), and core's replay used to re-sort by HLC. A late push
 * carrying an OLDER HLC than the write that beat it — a laptop offline since before today's
 * journal existed, pushing its own `page.create` for the day after an agent's `page_append` —
 * would win the name on replay although the server rejected it, and `verify` reported the
 * difference as divergence. The rejection is already decided: pull never ships rejected ops to any
 * device, and a cycle rejection's effect lives in its own logged corrective op. Replaying them
 * could only ever disagree with the server, never catch a real bug. (Since ADR 026 the replay
 * keeps `seq` order, which alone would also re-reject them; skipping them stays the cheaper and
 * more obviously-right of the two.)
 */
function loadOpBatch(
  driver: SqlDriver,
  afterSeq: number,
  batch: number,
): { ops: Op[]; lastSeq: number } {
  const rows = driver.all<OpRow & { seq: number }>(
    "SELECT seq, id, hlc, device_id, entity, payload_json FROM op " +
      "WHERE status != 'rejected' AND seq > ? ORDER BY seq LIMIT ?",
    [afterSeq, batch],
  );
  return {
    ops: rows.map((r) => ({
      id: r.id,
      hlc: r.hlc,
      device: r.device_id,
      entity: r.entity,
      payload: JSON.parse(r.payload_json) as OpPayload,
    })),
    lastSeq: rows.at(-1)?.seq ?? afterSeq,
  };
}

/**
 * Rows per query, for both the op replay and the table diff. Memory is O(batch), not O(graph):
 * the first version loaded every op and every row of both databases at once, and peaked at
 * 582 MiB RSS on a 61,500-op graph (docs/progress/streaming-backup.md). Replaying in `seq`-ordered
 * batches is the same replay — `applyOps` with `order: "seq"` applies its input one op at a time,
 * in the given order; only the transaction boundaries differ, and the scratch database is private.
 */
const DEFAULT_BATCH = 2000;

function keyOf(row: Record<string, unknown>, pk: readonly string[]): string {
  return pk.map((c) => JSON.stringify(row[c])).join("\u0000");
}

function diffTable(
  table: string,
  pk: readonly string[],
  liveRows: Record<string, unknown>[],
  rebuiltRows: Record<string, unknown>[],
): Divergence[] {
  const divergences: Divergence[] = [];
  const liveByKey = new Map(liveRows.map((r) => [keyOf(r, pk), r]));
  const rebuiltByKey = new Map(rebuiltRows.map((r) => [keyOf(r, pk), r]));
  const keyValue = (row: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(pk.map((c) => [c, row[c]]));

  for (const [key, liveRow] of liveByKey) {
    const rebuiltRow = rebuiltByKey.get(key);
    if (!rebuiltRow) {
      divergences.push({ table, key: keyValue(liveRow), kind: "missing-in-rebuild" });
      continue;
    }
    const columns = new Set([...Object.keys(liveRow), ...Object.keys(rebuiltRow)]);
    for (const column of columns) {
      if (pk.includes(column)) continue;
      const liveVal = liveRow[column];
      const rebuiltVal = rebuiltRow[column];
      if (liveVal !== rebuiltVal) {
        divergences.push({
          table,
          key: keyValue(liveRow),
          kind: "column-mismatch",
          column,
          live: liveVal,
          rebuilt: rebuiltVal,
        });
      }
    }
  }
  for (const [key, rebuiltRow] of rebuiltByKey) {
    if (!liveByKey.has(key)) {
      divergences.push({ table, key: keyValue(rebuiltRow), kind: "extra-in-rebuild" });
    }
  }
  return divergences;
}

/**
 * Diff one state table in primary-key order, `batch` live rows at a time. Each step takes the next
 * live rows after `prev`, then exactly the rebuilt rows in the same key range `(prev, last]`;
 * a final pass collects rebuilt rows past the last live key. The ranges are compared by SQLite on
 * both sides (row values, BINARY collation), never by JavaScript string order, which differs from
 * SQLite's for characters outside the BMP — so no row can fall between two batches unseen.
 */
function diffTableBatched(
  live: SqlDriver,
  rebuilt: SqlDriver,
  table: string,
  pk: readonly string[],
  batch: number,
): Divergence[] {
  const cols = pk.join(", ");
  const tuple = `(${cols})`;
  const marks = `(${pk.map(() => "?").join(", ")})`;
  const divergences: Divergence[] = [];
  let prev: unknown[] | null = null;
  for (;;) {
    const after: string = prev ? `WHERE ${tuple} > ${marks}` : "";
    const liveRows: Record<string, unknown>[] = live.all<Record<string, unknown>>(
      `SELECT * FROM ${table} ${after} ORDER BY ${cols} LIMIT ?`,
      [...(prev ?? []), batch],
    );
    if (liveRows.length === 0) break;
    const last: unknown[] = pk.map((c): unknown => (liveRows.at(-1) as Record<string, unknown>)[c]);
    const rebuiltRows = rebuilt.all<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE ${prev ? `${tuple} > ${marks} AND ` : ""}${tuple} <= ${marks}`,
      [...(prev ?? []), ...last],
    );
    divergences.push(...diffTable(table, pk, liveRows, rebuiltRows));
    prev = last;
  }
  // Rebuilt rows beyond the last live key (all of them, if the live table is empty).
  for (;;) {
    const after = prev ? `WHERE ${tuple} > ${marks}` : "";
    const extra = rebuilt.all<Record<string, unknown>>(
      `SELECT * FROM ${table} ${after} ORDER BY ${cols} LIMIT ?`,
      [...(prev ?? []), batch],
    );
    if (extra.length === 0) break;
    divergences.push(...diffTable(table, pk, [], extra));
    prev = pk.map((c) => (extra.at(-1) as Record<string, unknown>)[c]);
  }
  return divergences;
}

export interface VerifyOptions {
  /** Put the scratch replica in this file instead of in memory (the CLI does, beside the graph):
   * an in-memory replica holds the whole op log plus every state table and index. The file is
   * created fresh and deleted afterwards. */
  scratchPath?: string;
  /** Rows per query (default 2000). Tests shrink it to put batch boundaries everywhere. */
  batchSize?: number;
}

/**
 * Replay the live database's `op` log (minus the ops it rejected, see `loadOpBatch`) into a fresh
 * scratch database via `@nooklet/core`'s `applyOps`, then diff every state table row-for-row (and
 * column-for-column) against the live driver. Read-only on `driver` -- the scratch database is a
 * brand-new one (in memory, or `opts.scratchPath`), never the live database itself.
 */
export function verifyRebuildParity(driver: SqlDriver, opts: VerifyOptions = {}): VerifyReport {
  const start = Date.now();
  const seqRow = driver.get<{ n: number | null; min: number | null }>(
    "SELECT MAX(seq) AS n, MIN(seq) AS min FROM op",
  );
  const maxSeq = seqRow?.n ?? null;
  const minSeq = seqRow?.min ?? null;
  const opCount = driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM op")?.n ?? 0;

  const batch = opts.batchSize ?? DEFAULT_BATCH;
  const scratchFile = opts.scratchPath;
  if (scratchFile) removeSqliteFiles(scratchFile);
  const scratchDb = openNodeSqlite(scratchFile ?? ":memory:");
  try {
    // A throwaway file: durability is worthless, and fsyncs nearly doubled the run time.
    if (scratchFile) scratchDb.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF");
    const scratch = createNodeSqliteDriver(scratchDb);
    initSchema(scratch);
    // In `seq` order, as the server applied them (rule 26, ADR 026) — not re-sorted by HLC: an op
    // minted before its device heard of an older-seq op has the smaller HLC, and replaying it
    // first can re-decide a name collision the server decided the other way (B-587).
    let replayed = 0;
    for (let after = 0; ; ) {
      const { ops, lastSeq } = loadOpBatch(driver, after, batch);
      if (ops.length === 0) break;
      applyOps(scratch, ops, { order: "seq" });
      replayed += ops.length;
      after = lastSeq;
    }
    const rejectedSkipped = opCount - replayed;

    const divergences: Divergence[] = [];
    for (const { table, pk } of STATE_TABLES) {
      divergences.push(...diffTableBatched(driver, scratch, table, pk, batch));
    }
    return {
      ok: divergences.length === 0,
      opCount,
      minSeq,
      maxSeq,
      logTrimmed: minSeq !== null && minSeq > 1,
      rejectedSkipped,
      divergences,
      durationMs: Date.now() - start,
    };
  } finally {
    scratchDb.close();
    if (scratchFile) removeSqliteFiles(scratchFile);
  }
}

function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    rmSync(`${path}${suffix}`, { force: true });
}

const MAX_REPORTED_DIVERGENCES = 20;

/** Human-readable rendering for the CLI and the dev-mode startup log line. */
export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push(
    `verify: replayed ${report.opCount - report.rejectedSkipped} op(s) ` +
      `(seq ${report.minSeq ?? "-"}..${report.maxSeq ?? "-"}` +
      `${report.rejectedSkipped > 0 ? `; ${report.rejectedSkipped} rejected, not replayed` : ""}) ` +
      `in ${report.durationMs}ms`,
  );
  if (report.logTrimmed) {
    lines.push(
      `verify: NOTE - op log starts at seq ${report.minSeq} (op-log GC has run); divergence ` +
        "below for entities predating that point is an expected GC artifact, not a regression.",
    );
  }
  if (report.ok) {
    lines.push("verify: OK - rebuild() from the op log matches live state exactly.");
    return lines.join("\n");
  }
  lines.push(
    `verify: DIVERGENCE - ${report.divergences.length} difference(s) between live state and ` +
      "rebuild() from the op log:",
  );
  for (const d of report.divergences.slice(0, MAX_REPORTED_DIVERGENCES)) {
    const keyStr = Object.entries(d.key)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    if (d.kind === "missing-in-rebuild") {
      lines.push(`  - ${d.table}[${keyStr}]: present live, MISSING from rebuild`);
    } else if (d.kind === "extra-in-rebuild") {
      lines.push(`  - ${d.table}[${keyStr}]: absent live, EXTRA in rebuild`);
    } else {
      lines.push(
        `  - ${d.table}[${keyStr}].${d.column}: live=${JSON.stringify(d.live)} ` +
          `rebuilt=${JSON.stringify(d.rebuilt)}`,
      );
    }
  }
  if (report.divergences.length > MAX_REPORTED_DIVERGENCES) {
    lines.push(`  ... and ${report.divergences.length - MAX_REPORTED_DIVERGENCES} more`);
  }
  return lines.join("\n");
}
