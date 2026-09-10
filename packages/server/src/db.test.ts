/**
 * `openDb`/`openDbWithStatus` (`./db.ts`): fresh-database bootstrap plus the additive-migration
 * path introduced for M4/plugins (`plugin_kv`, `SCHEMA_VERSION` 1 -> 2, `./schema.ts#MIGRATIONS`).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_SCHEMA_STATEMENTS } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { SCHEMA_VERSION, SERVER_SCHEMA_STATEMENTS } from "./schema.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "nooklet-db-test-")), "graph.sqlite");
}

describe("openDb", () => {
  it("stamps a fresh database at the current SCHEMA_VERSION and creates plugin_kv", () => {
    const driver = openDb({ path: tmpDbPath() });
    const version = driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version;
    expect(version).toBe(SCHEMA_VERSION);
    const table = driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'plugin_kv'",
    );
    expect(table?.n).toBe(1);
  });

  it("migrates an existing SCHEMA_VERSION-1 database up, adding plugin_kv without touching existing data", () => {
    const path = tmpDbPath();

    // Fabricate a pre-M4 (version 1) database by hand: every statement schema.ts had BEFORE
    // plugin_kv was added, i.e. every current SERVER_SCHEMA_STATEMENTS entry except plugin_kv.
    const v1ServerStatements = SERVER_SCHEMA_STATEMENTS.filter(
      (stmt) => !stmt.includes("CREATE TABLE plugin_kv"),
    );
    {
      const raw = openNodeSqlite(path, { allowExtension: true });
      const driver = createNodeSqliteDriver(raw);
      driver.exec("PRAGMA user_version = 1");
      for (const stmt of CORE_SCHEMA_STATEMENTS) driver.exec(stmt);
      for (const stmt of v1ServerStatements) driver.exec(stmt);
      driver.run(
        "INSERT INTO schema_migration(version, applied_at, description) VALUES (1, ?, 'initial schema')",
        [Date.now()],
      );
      // A pre-existing row, to confirm the migration doesn't disturb existing state.
      driver.run(
        "INSERT INTO page(id, name, key, journal_day, created_at, updated_at, name_hlc) " +
          "VALUES ('p1', 'Existing Page', 'existing page', NULL, 1, 1, '0000000000001-0000000001-00000000')",
      );
    }

    // Re-opening through the real db.ts path should now run the v1 -> v2 migration.
    const driver = openDb({ path });
    const version = driver.get<{ user_version: number }>("PRAGMA user_version")?.user_version;
    expect(version).toBe(SCHEMA_VERSION);

    const kvTable = driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'plugin_kv'",
    );
    expect(kvTable?.n).toBe(1);

    // plugin_kv is immediately usable.
    driver.run(
      "INSERT INTO plugin_kv(plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
      ["word-count", "hello", JSON.stringify(42), Date.now()],
    );
    const row = driver.get<{ value_json: string }>(
      "SELECT value_json FROM plugin_kv WHERE plugin_id = ? AND key = ?",
      ["word-count", "hello"],
    );
    expect(row && JSON.parse(row.value_json)).toBe(42);

    // Pre-existing data survived the migration untouched.
    const page = driver.get<{ name: string }>("SELECT name FROM page WHERE id = 'p1'");
    expect(page?.name).toBe("Existing Page");

    const migrations = driver.all<{ version: number }>(
      "SELECT version FROM schema_migration ORDER BY version",
    );
    // [1, 2, 3, ...]: every migration from the fabricated v1 database up to the current
    // SCHEMA_VERSION (3 added ADR 015's token.ui_control column) should have run in order.
    expect(migrations.map((m) => m.version)).toEqual(
      Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1),
    );
  });

  it("refuses a database from a newer, unsupported schema version", () => {
    const path = tmpDbPath();
    {
      const raw = openNodeSqlite(path, { allowExtension: true });
      const driver = createNodeSqliteDriver(raw);
      driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      for (const stmt of CORE_SCHEMA_STATEMENTS) driver.exec(stmt);
      for (const stmt of SERVER_SCHEMA_STATEMENTS) driver.exec(stmt);
    }
    expect(() => openDb({ path })).toThrow(/newer than this build supports/);
  });
});
