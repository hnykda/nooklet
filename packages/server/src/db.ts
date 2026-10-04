/**
 * Opens and initializes the server's SQLite database: `@nooklet/core`'s node:sqlite driver plus
 * this package's full schema (core state tables + server-only tables, `schema.ts`).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlDriver } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import { loadSqliteVec, setVecStatus, type VecStatus } from "./embeddings/vec-loader.js";
import { initFullSchema, MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

export interface OpenDbOptions {
  /** File path, or ":memory:" for tests. Parent directory is created if missing. */
  path: string;
}

/** The raw connection behind each driver this module opened, so `closeDb` can close it. `SqlDriver`
 * itself has no `close()` (core's interface is shared with the browser drivers, and a one-shot
 * command simply exits); only retiring a graph from a running server needs one (B-713). */
const rawConnections = new WeakMap<SqlDriver, ReturnType<typeof openNodeSqlite>>();

/** Close the SQLite connection behind `driver` (opened by `openDb`). Idempotent. Any later call on
 * the driver throws, which is the point: a retired graph's handle must not keep writing to a file
 * that has been moved aside. */
export function closeDb(driver: SqlDriver): void {
  const raw = rawConnections.get(driver);
  if (!raw) return;
  rawConnections.delete(driver);
  try {
    raw.close();
  } catch {
    // Already closed.
  }
}

export interface OpenedDb {
  driver: SqlDriver;
  vecStatus: VecStatus;
}

/**
 * Opens the driver and also loads `sqlite-vec` (M3, ADR 010), returning whether it worked. Most
 * callers just want `openDb()` below (a bare `SqlDriver`, unchanged signature) — this is for
 * anything (the CLI's `embed status`) that wants to report the vec-load outcome directly instead
 * of going back through `getVecStatus(driver)`.
 */
export function openDbWithStatus(opts: OpenDbOptions): OpenedDb {
  if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
  const raw = openNodeSqlite(opts.path, { allowExtension: true });
  const vecStatus = loadSqliteVec(raw);
  const driver = createNodeSqliteDriver(raw);
  rawConnections.set(driver, raw);
  setVecStatus(driver, vecStatus);
  const isNew = driver.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'page'",
  );
  if (!isNew || isNew.n === 0) {
    initFullSchema(driver);
    return { driver, vecStatus };
  }
  const version = driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} is newer than this build supports (${SCHEMA_VERSION}); upgrade nooklet`,
    );
  }
  if (version < SCHEMA_VERSION) runMigrations(driver, version);
  return { driver, vecStatus };
}

/**
 * Bring an existing database from `fromVersion` up to `SCHEMA_VERSION` by running every
 * `schema.ts#MIGRATIONS` entry in between, each in its own transaction, recording a
 * `schema_migration` row and bumping `PRAGMA user_version` as it goes so a crash mid-upgrade
 * resumes from the last completed step next time `openDb` runs rather than re-applying (or
 * skipping) a migration. M4/plugins introduced the first of these (`plugin_kv`, SCHEMA_VERSION
 * 1 -> 2); before that, a version mismatch was a hard error (no migration path existed yet).
 */
function runMigrations(driver: SqlDriver, fromVersion: number): void {
  const pending = MIGRATIONS.filter(
    (m) => m.version > fromVersion && m.version <= SCHEMA_VERSION,
  ).sort((a, b) => a.version - b.version);
  const covered = fromVersion + pending.length;
  if (covered !== SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${fromVersion} has no migration path to ${SCHEMA_VERSION} ` +
        `(missing migration(s) after version ${covered}); upgrade nooklet in order, or restore a backup`,
    );
  }
  for (const migration of pending) {
    driver.transaction(() => {
      migration.up(driver);
      driver.exec(`PRAGMA user_version = ${migration.version}`);
      driver.run(
        "INSERT INTO schema_migration(version, applied_at, description) VALUES (?, ?, ?)",
        [migration.version, Date.now(), migration.description],
      );
    });
  }
}

/** Bare `SqlDriver`, unchanged signature — the vec-load outcome is still recorded and readable
 * via `getVecStatus(driver)` (`./embeddings/vec-loader.ts`); use `openDbWithStatus` when you want
 * it inline instead. */
export function openDb(opts: OpenDbOptions): SqlDriver {
  return openDbWithStatus(opts).driver;
}
