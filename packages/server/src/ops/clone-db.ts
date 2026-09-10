/**
 * A throwaway in-memory clone of the whole graph, used ONLY for `dry_run`/`batch` trial execution
 * (`./dry-run.ts`, `./batch.ts`).
 *
 * WHY THIS EXISTS (the alternative that does NOT work): SQLite forbids a bare `BEGIN` while a
 * transaction is already open — including one opened implicitly by a raw `SAVEPOINT` statement —
 * so a naive "open a SAVEPOINT, run the real (async) op handlers, roll back on failure" wrapper
 * breaks the moment a handler calls `ctx.applyOps` a second+ time: `serverApplyOps` (`../apply-
 * ops.ts`, fixed) always calls `SqlDriver.transaction()` internally, which — being reentrant only
 * for SYNCHRONOUSLY nested calls on the SAME connection — issues a fresh `BEGIN` and SQLite
 * rejects it with "cannot start a transaction within a transaction". Every write op's handler is
 * `async`/`await`s at least once, so it can never be the synchronous callback `transaction()`
 * requires, and there is no way to opt a nested `serverApplyOps` call out of its own `BEGIN`
 * without editing `apply-ops.ts` (out of scope here).
 *
 * The fix that DOES work: give a trial run its OWN, completely separate SQLite connection (a full
 * row-for-row copy of the current graph), run the normal — real, already-committing-per-call —
 * write path against THAT, and either discard it (`dry_run`, or a failed step: the real database
 * was never touched) or replay the same steps for real once the trial has proven they succeed
 * (`batch`, non-dry-run). No SAVEPOINT, no nested-transaction conflict, no change to `apply-
 * ops.ts`/`schema.ts`/`db.ts`.
 *
 * Cost: a full table copy per call (via `SqlDriver.all`/`run`, since the abstract `SqlDriver`
 * interface — deliberately, per driver.ts's own docs — exposes no `serialize()`/backup primitive
 * to clone a connection faster). Fine for v1's test-scale graphs; a production-scale
 * implementation would want a faster clone (e.g. `node:sqlite`'s `DatabaseSync.serialize()`, not
 * reachable through the portable `SqlDriver` abstraction `packages/core` deliberately exposes).
 */

import type { SqlDriver } from "@vrite/core";
import { createServerContext, type ServerContext } from "../apply-ops.js";
import { openDb } from "../db.js";

/** Every state/bookkeeping table `initFullSchema` creates, minus the virtual FTS tables (rebuilt
 * automatically by the schema's own triggers as `block`/`page` rows are copied in) and
 * `schema_migration` (already correctly seeded by `openDb`/`initFullSchema` on the fresh clone). */
const TABLES = [
  "token",
  "device",
  "page",
  "block",
  "block_prop",
  "page_prop",
  "op",
  "changes",
  "ref",
  "path_ref",
  "page_alias",
  "mirror_file",
  "asset",
  "embedding_model",
  "embedding",
  "embed_dirty",
  "setting",
  "keybinding",
  "plugin",
];

function copyTable(source: SqlDriver, dest: SqlDriver, table: string): void {
  // `block`/`page` rowids drive the FTS5 `content_rowid` linkage (schema.ts); copying in rowid
  // order into an empty table reproduces the same rowid assignment on the destination.
  const orderBy = table === "block" || table === "page" ? " ORDER BY rowid" : "";
  const rows = source.all<Record<string, unknown>>(`SELECT * FROM ${table}${orderBy}`);
  for (const row of rows) {
    const cols = Object.keys(row);
    if (cols.length === 0) continue;
    dest.run(`INSERT INTO ${table}(${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c]));
  }
}

/** A fresh `ServerContext` over an independent `:memory:` database, seeded with every row of
 * `source`'s current state. The clone's own HLC starts at least as far along as `source`'s, so ops
 * minted against it never collide with (or predate) ops already recorded there. */
export function cloneServerContext(source: ServerContext): ServerContext {
  const tempDriver = openDb({ path: ":memory:" });
  for (const table of TABLES) copyTable(source.driver, tempDriver, table);
  const clone = createServerContext(tempDriver);
  clone.hlc.receive(source.hlc.last);
  return clone;
}
