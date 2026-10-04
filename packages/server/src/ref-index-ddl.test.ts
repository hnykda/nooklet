/**
 * B-641: a client replica creates the reference index from `@nooklet/core`'s
 * `REF_INDEX_STATEMENTS`; the server from its own `schema.ts` (and migrations). They must declare
 * the same tables, columns and indexes, or the shared derivation and reads would work on one side
 * and fail on the other.
 */
import { DatabaseSync } from "node:sqlite";
import { initSchema, REF_INDEX_STATEMENTS } from "@nooklet/core";
import { createNodeSqliteDriver } from "@nooklet/core/node-sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";

const TABLES = ["ref", "path_ref", "page_tag", "page_alias"];

function shape(driver: {
  all<T>(sql: string, params?: readonly unknown[]): T[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    out[t] = {
      columns: driver.all(`PRAGMA table_info(${t})`),
      indexes: driver
        .all<{ name: string; sql: string | null }>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
          [t],
        )
        // `IF NOT EXISTS` is how the replica runs them on every open; the index is the same.
        .map((r) => ({ name: r.name, sql: r.sql?.replace(/ IF NOT EXISTS/, "") ?? null })),
      withoutRowid:
        driver
          .all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [
            t,
          ])[0]
          ?.sql.includes("WITHOUT ROWID") ?? false,
    };
  }
  return out;
}

describe("REF_INDEX_STATEMENTS (B-641)", () => {
  it("declares the reference index exactly as the server's schema does", () => {
    const server = openDb({ path: ":memory:" });
    const client = createNodeSqliteDriver(new DatabaseSync(":memory:"));
    initSchema(client);
    for (const stmt of REF_INDEX_STATEMENTS) client.exec(stmt);
    expect(shape(client)).toEqual(shape(server));
  });
});
