/**
 * `applyOps` / `rebuild`: the single write path for the `page`/`block`/`block_prop`/`page_prop`
 * state tables, per `docs/spec/sql-schema.md` rule 24 (per-op-kind semantics) and rule 26
 * (`rebuild`), and ADR 003 (per-field LWW by HLC, server-only tree-cycle rejection). Talks only
 * to the storage-agnostic `SqlDriver` (`driver.ts`) — no SQL client import, so this file runs in
 * Node and the browser alike.
 *
 * Canonical order and the tree-cycle check
 * -----------------------------------------
 * sql-schema.md's cycle check and corrective-op emission are explicitly a *server* concern: the
 * server processes pushes in arrival order and, on a rejected move, appends a corrective
 * `block.place` op with a server-assigned HLC so every client converges on the same decision.
 * `packages/core` has no server role and MUST NOT fabricate a server HLC (see the task scope).
 * Absent that arbiter, a structural check like "would this move create a cycle" is order
 * sensitive in a way plain per-field LWW is not: two concurrent moves that each look valid in
 * isolation (`A` under `B`, `B` under `A`) can only have *one* winner, and which one wins depends
 * on which is applied first.
 *
 * This implementation's answer: a batch passed to `applyOps` is always processed in HLC order
 * (sorted internally, ties broken by op id — which is redundant in practice since an op's `id`
 * *is* its `hlc`, ADR 004/ops.ts, but the fallback costs nothing and documents the intent). HLC
 * order is available to any device without coordination, so it stands in for the server's
 * arrival order as this package's canonical order. The consequence: to guarantee that two
 * devices which have seen the same *set* of ops converge on the same accept/reject decision for
 * every `block.place`, ops must eventually be (re-)applied together, in one `applyOps`/`rebuild`
 * call, in HLC order — not trickled in one at a time in arbitrary arrival order forever. A
 * device's own ops, applied as they are created, are trivially already in increasing HLC order
 * relative to each other, so pure incremental `applyOps` calls are fine there; merging in a
 * foreign batch is where a canonical-order replay (`rebuild`, or `applyOps` over the full
 * accumulated log) is what buys convergence. See `sync.property.test.ts` for a worked
 * demonstration of exactly this "concurrent cycle-creating move" case converging deterministically
 * under this rule, and `apply-ops.test.ts`'s cycle-rejection tests for the single-device case.
 */

import { compareHlc, parseHlc } from "../hlc.js";
import { isoJournalName, isValidJournalDay, type JournalDay } from "../journal.js";
import { TASK_MARKERS } from "../model.js";
import type { BlockPlace, Op, OpKind, OpPayload } from "../ops.js";
import { normalizePageName } from "../page-name.js";
import type { SqlDriver } from "./driver.js";
import type { AppliedOpResult, ApplyOpsResult, ApplyReason } from "./types.js";

const PRIORITIES = new Set(["A", "B", "C"]);
const SCHEDULED_RE = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/;
const DONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface OpOutcome {
  status: "applied" | "noop" | "rejected";
  reason?: ApplyReason;
  /** Payload to persist in `op.payload_json`, when it differs from the incoming op's (rule 24:
   * a corrected `place` is logged, not the raw incoming one). */
  loggedPayload?: OpPayload;
}

/**
 * Apply a batch of ops to `driver`'s `page`/`block`/`block_prop`/`page_prop` state, HLC-ordered
 * (see file header), each op's effect recorded into `op`. Idempotent: an op whose `id` is already
 * in the `op` table is skipped (its previously recorded status is reported back unchanged) rather
 * than reprocessed, matching the sync protocol's "idempotent, resumable" requirement (ADR 003).
 */
export function applyOps(driver: SqlDriver, ops: readonly Op[]): ApplyOpsResult {
  const sorted = [...ops].sort((a, b) => compareHlc(a.hlc, b.hlc) || compareHlc(a.id, b.id));
  const results: AppliedOpResult[] = [];

  driver.transaction(() => {
    for (const op of sorted) {
      const already = driver.get<{ status: AppliedOpResult["status"] }>(
        "SELECT status FROM op WHERE id = ?",
        [op.id],
      );
      if (already) {
        results.push({
          id: op.id,
          hlc: op.hlc,
          kind: op.payload.kind,
          entity: op.entity,
          status: already.status,
          reason: "already-recorded",
        });
        continue;
      }
      const outcome = applyOne(driver, op);
      const payloadToLog = outcome.loggedPayload ?? op.payload;
      driver.run(
        "INSERT INTO op(id, hlc, device_id, kind, entity, payload_json, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          op.id,
          op.hlc,
          op.device,
          op.payload.kind,
          op.entity,
          JSON.stringify(payloadToLog),
          outcome.status,
        ],
      );
      results.push({
        id: op.id,
        hlc: op.hlc,
        kind: op.payload.kind,
        entity: op.entity,
        status: outcome.status,
        reason: outcome.reason,
      });
    }
  });

  let applied = 0;
  let noop = 0;
  let rejected = 0;
  for (const r of results) {
    if (r.status === "applied") applied++;
    else if (r.status === "noop") noop++;
    else rejected++;
  }
  return { results, applied, noop, rejected };
}

/**
 * Wipe `page`/`block`/`block_prop`/`page_prop`/`op` and replay `ops` from empty, HLC-ordered
 * (rule 26, adapted: the spec replays in server `seq` order, but a plain `Op[]` — as opposed to
 * `LoggedOp[]` — carries no `seq`; HLC order is this package's substitute canonical order, see
 * the file header). Must reproduce state byte-identical to a device that received the same op
 * set through any sequence of `applyOps` calls that eventually merges everything via HLC-ordered
 * replay (see `sync.property.test.ts`).
 */
export function rebuild(driver: SqlDriver, ops: readonly Op[]): ApplyOpsResult {
  driver.transaction(() => {
    driver.run("DELETE FROM block_prop");
    driver.run("DELETE FROM page_prop");
    driver.run("DELETE FROM block");
    driver.run("DELETE FROM page");
    driver.run("DELETE FROM op");
  });
  return applyOps(driver, ops);
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

function applyOne(driver: SqlDriver, op: Op): OpOutcome {
  const payload = op.payload;
  switch (payload.kind) {
    case "page.create":
      return applyPageCreate(driver, op.hlc, op.entity, payload);
    case "page.rename":
      return applyPageRename(driver, op.hlc, op.entity, payload);
    case "page.prop":
      return applyPageProp(driver, op.hlc, op.entity, payload);
    case "page.delete":
      return applyPageDelete(driver, op.hlc, op.entity, payload);
    case "block.create":
      return applyBlockCreate(driver, op.hlc, op.entity, payload);
    case "block.place":
      return applyBlockPlace(driver, op.hlc, op.entity, payload);
    case "block.text":
      return applyBlockText(driver, op.hlc, op.entity, payload);
    case "block.prop":
      return applyBlockProp(driver, op.hlc, op.entity, payload);
    case "block.delete":
      return applyBlockDelete(driver, op.hlc, op.entity, payload);
    default: {
      const exhaustive: never = payload;
      throw new Error(`unknown op kind: ${(exhaustive as { kind: OpKind }).kind}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// page.*
// ---------------------------------------------------------------------------------------------

/**
 * A journal page's name is DERIVED from its day, never carried (ADR 018): whatever name an op
 * proposes, a page with a journal day is stored as `2026-09-07`.
 *
 * Done here, in the shared reducer, rather than at each of the half-dozen call sites that create
 * journal pages, because this is the one place every device and every replay funnels through — so
 * client, server and a `rebuild()` from the op log all reach the same name. The coercion is pure
 * (day in, string out) and so does not disturb replay determinism: `verify` rebuilds live state
 * through this same function and gets the same answer.
 *
 * `isValidJournalDay` guards the arithmetic — an op carrying a nonsense day is stored under its
 * proposed name rather than crashing a whole sync batch on a `date-fns` range error.
 */
function storedPageName(name: string, journalDay: JournalDay | null): string {
  if (journalDay === null || !isValidJournalDay(journalDay)) return name;
  return isoJournalName(journalDay);
}

function pageKeyCollision(driver: SqlDriver, key: string, excludeId: string): boolean {
  return (
    driver.get("SELECT id FROM page WHERE key = ? AND deleted_at IS NULL AND id != ?", [
      key,
      excludeId,
    ]) !== undefined
  );
}

function applyPageCreate(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "page.create" }>,
): OpOutcome {
  const name = storedPageName(payload.name, payload.journalDay);
  const key = normalizePageName(name);
  if (pageKeyCollision(driver, key, entity))
    return { status: "rejected", reason: "page-key-collision" };

  let changed = false;
  const ins = driver.run(
    `INSERT OR IGNORE INTO page(id, name, key, journal_day, created_at, updated_at, name_hlc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entity, name, key, payload.journalDay, payload.createdAt, payload.createdAt, hlc],
  );
  if (ins.changes > 0) changed = true;

  if (payload.properties) {
    for (const [k, v] of Object.entries(payload.properties)) {
      if (lwwUpsertGeneric(driver, "page_prop", "page_id", entity, k, v, hlc)) changed = true;
    }
  }
  return { status: changed ? "applied" : "noop" };
}

function applyPageRename(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "page.rename" }>,
): OpOutcome {
  const row = driver.get<{ name_hlc: string; journal_day: JournalDay | null }>(
    "SELECT name_hlc, journal_day FROM page WHERE id = ?",
    [entity],
  );
  if (!row) return { status: "noop", reason: "no-such-page" };
  if (compareHlc(hlc, row.name_hlc) <= 0) return { status: "noop", reason: "stale" };

  // Same derivation as on create, so renaming a journal page is not a way around it — the rename
  // lands, it just lands on the ISO name. That is also what lets the one-time migration in
  // `packages/server/src/journal-names.ts` do its work through ordinary `page.rename` ops.
  const name = storedPageName(payload.name, row.journal_day);
  const key = normalizePageName(name);
  if (pageKeyCollision(driver, key, entity))
    return { status: "rejected", reason: "page-key-collision" };

  driver.run("UPDATE page SET name = ?, key = ?, name_hlc = ? WHERE id = ?", [
    name,
    key,
    hlc,
    entity,
  ]);
  return { status: "applied" };
}

function applyPageProp(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "page.prop" }>,
): OpOutcome {
  if (!driver.get("SELECT id FROM page WHERE id = ?", [entity]))
    return { status: "noop", reason: "no-such-page" };
  const changed = lwwUpsertGeneric(
    driver,
    "page_prop",
    "page_id",
    entity,
    payload.key,
    payload.value,
    hlc,
  );
  return { status: changed ? "applied" : "noop" };
}

function applyPageDelete(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "page.delete" }>,
): OpOutcome {
  const row = driver.get<{ deleted_hlc: string | null }>(
    "SELECT deleted_hlc FROM page WHERE id = ?",
    [entity],
  );
  if (!row) return { status: "noop", reason: "no-such-page" };
  if (row.deleted_hlc !== null && compareHlc(hlc, row.deleted_hlc) <= 0)
    return { status: "noop", reason: "stale" };
  driver.run("UPDATE page SET deleted_at = ?, deleted_hlc = ? WHERE id = ?", [
    payload.deletedAt,
    hlc,
    entity,
  ]);
  return { status: "applied" };
}

// ---------------------------------------------------------------------------------------------
// block.* placement helpers (shared by block.create and block.place)
// ---------------------------------------------------------------------------------------------

interface ParentCandidate {
  id: string;
  page_id: string;
  deleted_at: number | null;
}

/** Rule 24: if `place.parentId` does not resolve to a live block on `place.pageId`, use `null`. */
function resolvePlace(driver: SqlDriver, place: BlockPlace): BlockPlace {
  if (place.parentId === null) return place;
  const parent = driver.get<ParentCandidate>(
    "SELECT id, page_id, deleted_at FROM block WHERE id = ?",
    [place.parentId],
  );
  if (!parent || parent.deleted_at !== null || parent.page_id !== place.pageId) {
    return { ...place, parentId: null };
  }
  return place;
}

/** Server-only cycle check (sql-schema.md rule 24), applied uniformly here (see file header). */
function wouldCycle(driver: SqlDriver, movedBlockId: string, newParentId: string): boolean {
  const found = driver.get(
    `WITH RECURSIVE ancestors(id, parent_id) AS (
       SELECT id, parent_id FROM block WHERE id = ?
       UNION ALL
       SELECT b.id, b.parent_id FROM block b JOIN ancestors a ON b.id = a.parent_id
     )
     SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
    [newParentId, movedBlockId],
  );
  return found !== undefined;
}

// ---------------------------------------------------------------------------------------------
// block.*
// ---------------------------------------------------------------------------------------------

function applyBlockCreate(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "block.create" }>,
): OpOutcome {
  if (!driver.get("SELECT id FROM page WHERE id = ?", [payload.place.pageId])) {
    return { status: "rejected", reason: "no-such-page" };
  }

  const marker = payload.marker ?? null;
  if (marker !== null && !(TASK_MARKERS as readonly string[]).includes(marker)) {
    return { status: "rejected", reason: "invalid-marker" };
  }
  const priority = payload.priority ?? null;
  if (priority !== null && !PRIORITIES.has(priority)) {
    return { status: "rejected", reason: "invalid-priority" };
  }

  // A brand-new id can never be its own ancestor (rule 24), so block.create needs no cycle check
  // — only the same missing/invalid-parent fallback block.place uses.
  const place = resolvePlace(driver, payload.place);
  const collapsed = payload.collapsed ? 1 : 0;

  let changed = false;
  const ins = driver.run(
    `INSERT OR IGNORE INTO block(
       id, page_id, parent_id, order_key, content, marker, priority, collapsed,
       created_at, updated_at, place_hlc, content_hlc, marker_hlc, priority_hlc, collapsed_hlc
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entity,
      place.pageId,
      place.parentId,
      place.order,
      payload.content,
      marker,
      priority,
      collapsed,
      payload.createdAt,
      payload.createdAt,
      hlc,
      hlc,
      hlc,
      hlc,
      hlc,
    ],
  );
  if (ins.changes > 0) changed = true;

  if (payload.properties) {
    for (const [k, v] of Object.entries(payload.properties)) {
      // Invalid inline properties don't fail the whole creation (the block itself is still
      // structurally valid); they're simply not written. Only a dedicated `block.prop` op for
      // that one key rejects outright (see applyBlockProp / rule 10).
      const r = writeBlockField(driver, entity, k, v, hlc);
      if (r.ok && r.changed) changed = true;
    }
  }

  const samePlace =
    place.pageId === payload.place.pageId && place.parentId === payload.place.parentId;
  const loggedPayload: OpPayload = samePlace ? payload : { ...payload, place };
  return { status: changed ? "applied" : "noop", loggedPayload };
}

function applyBlockPlace(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "block.place" }>,
): OpOutcome {
  const row = driver.get<{ place_hlc: string }>("SELECT place_hlc FROM block WHERE id = ?", [
    entity,
  ]);
  if (!row) return { status: "noop", reason: "no-such-block" };
  if (compareHlc(hlc, row.place_hlc) <= 0) return { status: "noop", reason: "stale" };

  if (!driver.get("SELECT id FROM page WHERE id = ?", [payload.place.pageId])) {
    return { status: "rejected", reason: "no-such-page" };
  }

  const place = resolvePlace(driver, payload.place);
  const samePlace =
    place.pageId === payload.place.pageId && place.parentId === payload.place.parentId;
  const loggedPayload: OpPayload = samePlace ? payload : { ...payload, place };

  if (place.parentId !== null && wouldCycle(driver, entity, place.parentId)) {
    return { status: "rejected", reason: "cycle", loggedPayload };
  }

  driver.run(
    "UPDATE block SET page_id = ?, parent_id = ?, order_key = ?, place_hlc = ? WHERE id = ?",
    [place.pageId, place.parentId, place.order, hlc, entity],
  );
  return { status: "applied", loggedPayload };
}

function applyBlockText(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "block.text" }>,
): OpOutcome {
  const row = driver.get<{ content_hlc: string }>("SELECT content_hlc FROM block WHERE id = ?", [
    entity,
  ]);
  if (!row) return { status: "noop", reason: "no-such-block" };
  if (compareHlc(hlc, row.content_hlc) <= 0) return { status: "noop", reason: "stale" };
  driver.run("UPDATE block SET content = ?, content_hlc = ?, updated_at = ? WHERE id = ?", [
    payload.content,
    hlc,
    parseHlc(hlc).wall,
    entity,
  ]);
  return { status: "applied" };
}

function applyBlockProp(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "block.prop" }>,
): OpOutcome {
  if (!driver.get("SELECT id FROM block WHERE id = ?", [entity]))
    return { status: "noop", reason: "no-such-block" };
  const r = writeBlockField(driver, entity, payload.key, payload.value, hlc);
  if (!r.ok) return { status: "rejected", reason: r.reason };
  return { status: r.changed ? "applied" : "noop" };
}

function applyBlockDelete(
  driver: SqlDriver,
  hlc: string,
  entity: string,
  payload: Extract<OpPayload, { kind: "block.delete" }>,
): OpOutcome {
  const row = driver.get<{ deleted_hlc: string | null }>(
    "SELECT deleted_hlc FROM block WHERE id = ?",
    [entity],
  );
  if (!row) return { status: "noop", reason: "no-such-block" };
  if (row.deleted_hlc !== null && compareHlc(hlc, row.deleted_hlc) <= 0)
    return { status: "noop", reason: "stale" };
  driver.run("UPDATE block SET deleted_at = ?, deleted_hlc = ? WHERE id = ?", [
    payload.deletedAt,
    hlc,
    entity,
  ]);
  return { status: "applied" };
}

// ---------------------------------------------------------------------------------------------
// block.prop field routing: reserved keys -> dedicated columns, everything else -> block_prop
// (rule 4/5/10). Shared by applyBlockProp and block.create's inline `properties` bag.
// ---------------------------------------------------------------------------------------------

type FieldWriteResult = { ok: true; changed: boolean } | { ok: false; reason: ApplyReason };

function writeBlockField(
  driver: SqlDriver,
  blockId: string,
  key: string,
  value: string | null,
  hlc: string,
): FieldWriteResult {
  switch (key) {
    case "marker": {
      if (value !== null && !(TASK_MARKERS as readonly string[]).includes(value)) {
        return { ok: false, reason: "invalid-marker" };
      }
      return {
        ok: true,
        changed: lwwSetColumns(driver, "block", blockId, [["marker", value]], "marker_hlc", hlc),
      };
    }
    case "priority": {
      if (value !== null && !PRIORITIES.has(value))
        return { ok: false, reason: "invalid-priority" };
      return {
        ok: true,
        changed: lwwSetColumns(
          driver,
          "block",
          blockId,
          [["priority", value]],
          "priority_hlc",
          hlc,
        ),
      };
    }
    case "collapsed": {
      // Wire convention (outline.ts): "true" -> true, anything else -> false.
      const boolVal = value === "true" ? 1 : 0;
      return {
        ok: true,
        changed: lwwSetColumns(
          driver,
          "block",
          blockId,
          [["collapsed", boolVal]],
          "collapsed_hlc",
          hlc,
        ),
      };
    }
    case "scheduled":
    case "deadline": {
      const dayCol = `${key}_day`;
      const timeCol = `${key}_time`;
      const hlcCol = `${key}_hlc`;
      if (value === null) {
        return {
          ok: true,
          changed: lwwSetColumns(
            driver,
            "block",
            blockId,
            [
              [dayCol, null],
              [timeCol, null],
            ],
            hlcCol,
            hlc,
          ),
        };
      }
      const m = SCHEDULED_RE.exec(value);
      if (!m)
        return {
          ok: false,
          reason: key === "scheduled" ? "invalid-scheduled" : "invalid-deadline",
        };
      const day = Number((m[1] as string).replaceAll("-", ""));
      const time = m[2] ?? null;
      return {
        ok: true,
        changed: lwwSetColumns(
          driver,
          "block",
          blockId,
          [
            [dayCol, day],
            [timeCol, time],
          ],
          hlcCol,
          hlc,
        ),
      };
    }
    case "repeat": {
      // Opaque text, no grammar validation owned by this schema (sql-schema.md rule 10/Open issue 4).
      return {
        ok: true,
        changed: lwwSetColumns(driver, "block", blockId, [["repeat", value]], "repeat_hlc", hlc),
      };
    }
    case "done": {
      if (value === null) {
        return {
          ok: true,
          changed: lwwSetColumns(driver, "block", blockId, [["done_at", null]], "done_hlc", hlc),
        };
      }
      if (!DONE_RE.test(value) || Number.isNaN(Date.parse(value))) {
        return { ok: false, reason: "invalid-done" };
      }
      return {
        ok: true,
        changed: lwwSetColumns(
          driver,
          "block",
          blockId,
          [["done_at", Date.parse(value)]],
          "done_hlc",
          hlc,
        ),
      };
    }
    case "id":
      // Rule 5: "id" never appears in a block.prop op; it's consumed by the outline parser
      // before an op is even constructed.
      return { ok: false, reason: "id-not-writable" };
    default:
      return {
        ok: true,
        changed: lwwUpsertGeneric(driver, "block_prop", "block_id", blockId, key, value, hlc),
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Low-level guarded LWW writers
// ---------------------------------------------------------------------------------------------

/** UPDATE one or more dedicated columns on `table` (`page`/`block`) iff `hlc` beats `hlcCol`. */
function lwwSetColumns(
  driver: SqlDriver,
  table: "page" | "block",
  id: string,
  columns: ReadonlyArray<readonly [string, unknown]>,
  hlcCol: string,
  hlc: string,
): boolean {
  const setClause = columns.map(([c]) => `${c} = ?`).join(", ");
  const sql = `UPDATE ${table} SET ${setClause}, ${hlcCol} = ? WHERE id = ? AND (${hlcCol} IS NULL OR ${hlcCol} < ?)`;
  const values = columns.map(([, v]) => v);
  const r = driver.run(sql, [...values, hlc, id, hlc]);
  return r.changes > 0;
}

/** Upsert one row of `block_prop`/`page_prop` iff `hlc` beats the existing row's `hlc`. */
function lwwUpsertGeneric(
  driver: SqlDriver,
  table: "block_prop" | "page_prop",
  idCol: "block_id" | "page_id",
  id: string,
  key: string,
  value: string | null,
  hlc: string,
): boolean {
  const sql = `INSERT INTO ${table}(${idCol}, key, value, hlc) VALUES (?, ?, ?, ?)
    ON CONFLICT(${idCol}, key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc
    WHERE excluded.hlc > ${table}.hlc`;
  const r = driver.run(sql, [id, key, value, hlc]);
  return r.changes > 0;
}
