/** Shared test scaffolding for `./*.test.ts` (not itself a `*.test.ts` file, so vitest ignores
 * it) — mirrors `../test-helpers.ts`'s pattern but adds sync-capable (`can_sync`) tokens and the
 * bits needed to exercise the sync protocol end to end: a second in-memory `@nooklet/core` replica
 * ("device B's own DB"), a raw state dump/compare helper, and a `GET` request helper (the base
 * `post` helper already covers POST). */

import type { SqlDriver } from "@nooklet/core";
import { initSchema } from "@nooklet/core";
import { createNodeSqliteDriver, openNodeSqlite } from "@nooklet/core/node-sqlite";
import type { Hono } from "hono";
import { createToken } from "../auth/tokens.js";
import { makeTestServer, type TestServer } from "../test-helpers.js";

export interface SyncTestServer extends TestServer {
  /** A sync-capable (write scope, can_sync) token, standing in for "device A"'s credential. */
  syncToken: string;
  /** A second sync-capable token, standing in for "device B"'s credential — a distinct token so
   * `changes`/`op` attribution differs, though nothing stops one token being shared by devices. */
  syncToken2: string;
}

export function makeSyncTestServer(): SyncTestServer {
  const base = makeTestServer();
  const syncToken = createToken(base.serverCtx.driver, {
    label: "device-a",
    scope: "write",
    canSync: true,
  }).token;
  const syncToken2 = createToken(base.serverCtx.driver, {
    label: "device-b",
    scope: "write",
    canSync: true,
  }).token;
  return { ...base, syncToken, syncToken2 };
}

// biome-ignore lint/suspicious/noExplicitAny: test-only escape hatch, see ../test-helpers.ts
export type JsonAny = any;

export async function getJson(
  app: Hono,
  path: string,
  token: string,
): Promise<{ status: number; json: JsonAny }> {
  const res = await app.request(path, {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

/** A brand-new `@nooklet/core` in-memory replica, standing in for a client device's local DB. */
export function makeClientDriver(): SqlDriver {
  const driver = createNodeSqliteDriver(openNodeSqlite(":memory:"));
  initSchema(driver);
  return driver;
}

/** The full sync state, in a form that two replicas can be `.toEqual()`-compared with (same
 * approach as `packages/core/src/sync/sync.property.test.ts`'s `dumpState`). */
export function dumpState(driver: SqlDriver): {
  pages: unknown[];
  blocks: unknown[];
  blockProps: unknown[];
  pageProps: unknown[];
} {
  return {
    pages: driver.all("SELECT * FROM page ORDER BY id"),
    blocks: driver.all("SELECT * FROM block ORDER BY id"),
    blockProps: driver.all("SELECT * FROM block_prop ORDER BY block_id, key"),
    pageProps: driver.all("SELECT * FROM page_prop ORDER BY page_id, key"),
  };
}

/** Load a `GET /sync/snapshot` response's rows straight into a fresh client driver's state
 * tables — bypassing `applyOps` entirely, exactly like a real client bootstrap would (the
 * snapshot IS the state, not a log to replay). Foreign keys are relaxed for the load since block
 * parent/child rows may not arrive in topological order; restored immediately after. */
export function loadSnapshot(
  driver: SqlDriver,
  snapshot: {
    pages: JsonAny[];
    blocks: JsonAny[];
    block_props: JsonAny[];
    page_props: JsonAny[];
  },
): void {
  driver.exec("PRAGMA foreign_keys = OFF");
  insertRows(driver, "page", snapshot.pages);
  insertRows(driver, "block", snapshot.blocks);
  insertRows(driver, "block_prop", snapshot.block_props);
  insertRows(driver, "page_prop", snapshot.page_props);
  driver.exec("PRAGMA foreign_keys = ON");
}

/** Columns that exist in `SELECT *` but are `GENERATED ALWAYS AS (...) STORED` and therefore
 * cannot appear in an `INSERT` column list (`block.due_day`, `docs/spec/sql-schema.md` rule 9). */
const GENERATED_COLUMNS = new Set(["due_day"]);

function insertRows(driver: SqlDriver, table: string, rows: JsonAny[]): void {
  for (const row of rows) {
    const cols = Object.keys(row).filter((c) => !GENERATED_COLUMNS.has(c));
    if (cols.length === 0) continue;
    const placeholders = cols.map(() => "?").join(", ");
    driver.run(
      `INSERT INTO ${table}(${cols.join(", ")}) VALUES (${placeholders})`,
      cols.map((col) => row[col]),
    );
  }
}
