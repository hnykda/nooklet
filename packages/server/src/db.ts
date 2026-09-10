/**
 * Opens and initializes the server's SQLite database: `@nooklet/core`'s node:sqlite driver plus
 * this package's full schema (core state tables + server-only tables, `schema.ts`).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlDriver } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import { initFullSchema, SCHEMA_VERSION } from "./schema.js";

export interface OpenDbOptions {
  /** File path, or ":memory:" for tests. Parent directory is created if missing. */
  path: string;
}

export function openDb(opts: OpenDbOptions): SqlDriver {
  if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
  const raw = openNodeSqlite(opts.path);
  const driver = createNodeSqliteDriver(raw);
  const isNew = driver.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'page'",
  );
  if (!isNew || isNew.n === 0) {
    initFullSchema(driver);
    return driver;
  }
  const version = driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${version} does not match expected ${SCHEMA_VERSION}; migrations are not implemented yet`,
    );
  }
  return driver;
}
