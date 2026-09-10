/**
 * Opens and initializes the server's SQLite database: `@nooklet/core`'s node:sqlite driver plus
 * this package's full schema (core state tables + server-only tables, `schema.ts`).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlDriver } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import { loadSqliteVec, setVecStatus, type VecStatus } from "./embeddings/vec-loader.js";
import { initFullSchema, SCHEMA_VERSION } from "./schema.js";

export interface OpenDbOptions {
  /** File path, or ":memory:" for tests. Parent directory is created if missing. */
  path: string;
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
  setVecStatus(driver, vecStatus);
  const isNew = driver.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'page'",
  );
  if (!isNew || isNew.n === 0) {
    initFullSchema(driver);
    return { driver, vecStatus };
  }
  const version = driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} does not match expected ${SCHEMA_VERSION}; migrations are not implemented yet`,
    );
  }
  return { driver, vecStatus };
}

/** Bare `SqlDriver`, unchanged signature — the vec-load outcome is still recorded and readable
 * via `getVecStatus(driver)` (`./embeddings/vec-loader.ts`); use `openDbWithStatus` when you want
 * it inline instead. */
export function openDb(opts: OpenDbOptions): SqlDriver {
  return openDbWithStatus(opts).driver;
}
