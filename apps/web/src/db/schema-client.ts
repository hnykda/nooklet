/**
 * Client-only DDL (docs/spec/sql-schema.md rule 1: "Client-only: `pending_op`, `sync_state`").
 * Applied after `@nooklet/core`'s `CORE_SCHEMA_STATEMENTS` on first open of a replica (see
 * `worker-core.ts#initSchema`).
 *
 *  - `pending_op` is the crash-safe outbox: `SyncClient.applyLocal` (`../sync/sync-client.ts`)
 *    inserts one row per op in the SAME transaction as the local state change (ADR 003), so a
 *    crash between "applied locally" and "pushed" cannot lose an op.
 *  - `sync_state` is a flat key/value table holding `server_cursor`, `device_id`, `hlc_last`
 *    (research/03-sync.md §6.2).
 */
import type { SqlDriver } from "@nooklet/core";

export const CLIENT_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS pending_op (
    id      TEXT PRIMARY KEY,
    hlc     TEXT NOT NULL,
    kind    TEXT NOT NULL,
    entity  TEXT NOT NULL,
    payload TEXT NOT NULL,
    /**
     * For an unpushed \`block.text\` op: the block's content as of the last server-confirmed
     * version, i.e. the common ancestor of this pending edit and whatever another device may
     * have written concurrently. \`@nooklet/core\`'s \`resolvePendingTextConflict\` needs it as
     * the \`base\` of a three-way merge (ADR 003's v1.1 upgrade); without it a collision falls
     * back to last-writer-wins and one side's edit is silently lost. NULL for every other op
     * kind, and for a text op on a block that had no confirmed content yet.
     */
    base    TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS pending_op_hlc ON pending_op(hlc)`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

/**
 * Indexes only this replica's own reads need, run on EVERY open (not just a fresh database's),
 * each `IF NOT EXISTS`: a replica has no migration table, so this is how one created before an
 * index existed gets it.
 *
 *  - `block_dated`: every live block with a scheduled or deadline date (`due_day` is `coalesce` of
 *    the two), task or not — what the journal's "Scheduled and deadline" section reads
 *    (`../data/agenda.ts`) after every write to `block`. Without it that read scans the whole
 *    block table (`tools/probes/agenda-sql-cost.mjs`: 2.3 ms vs 0.006 ms per read, native, on the
 *    owner's 18.6k blocks). Client-only on purpose: the server never runs that read, and a server
 *    index would mean a schema version bump, which an installed app on the previous version then
 *    refuses to open.
 */
export const CLIENT_INDEX_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS block_dated ON block(due_day)
    WHERE deleted_at IS NULL AND due_day IS NOT NULL`,
];

/**
 * The replica's own full-text index (server-search): the same FTS5 tables and triggers the server
 * has (`packages/server/src/schema.ts`, "derived: full-text search"), minus the trigram twins,
 * which only the server's substring paths read. Before this the replica had no text index at all,
 * so search answered only through the server — and not at all offline or in local-only mode.
 *
 * External-content tables (`content='block'`), so the index stores tokens, not a second copy of
 * the text, and the triggers keep it in step with every write `applyOps` makes, local or pulled.
 * Measured with `tools/probes/client-fts-cost.mjs` on sqlite-wasm and the owner's graph (18.6k
 * blocks): the one-time rebuild takes 57 ms, a query about 1 ms.
 *
 * Same tokenizer as the server (diacritics removed, `-`/`_` inside words): a Czech word typed
 * without its háčky finds the same blocks on the device as on the server.
 */
const CLIENT_FTS_STATEMENTS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS block_fts USING fts5(
    content, content='block', content_rowid='rowid',
    tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
  )`,
  `CREATE TRIGGER IF NOT EXISTS block_fts_ai AFTER INSERT ON block BEGIN
    INSERT INTO block_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS block_fts_ad AFTER DELETE ON block BEGIN
    INSERT INTO block_fts(block_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS block_fts_au AFTER UPDATE OF content ON block BEGIN
    INSERT INTO block_fts(block_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO block_fts(rowid, content) VALUES (new.rowid, new.content);
  END`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
    name, content='page', content_rowid='rowid',
    tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
  )`,
  `CREATE TRIGGER IF NOT EXISTS page_fts_ai AFTER INSERT ON page BEGIN
    INSERT INTO page_fts(rowid, name) VALUES (new.rowid, new.name);
  END`,
  `CREATE TRIGGER IF NOT EXISTS page_fts_ad AFTER DELETE ON page BEGIN
    INSERT INTO page_fts(page_fts, rowid, name) VALUES('delete', old.rowid, old.name);
  END`,
  `CREATE TRIGGER IF NOT EXISTS page_fts_au AFTER UPDATE OF name ON page BEGIN
    INSERT INTO page_fts(page_fts, rowid, name) VALUES('delete', old.rowid, old.name);
    INSERT INTO page_fts(rowid, name) VALUES (new.rowid, new.name);
  END`,
];

/**
 * `CLIENT_FTS_STATEMENTS` on every open; a replica that did not have the index yet (created before
 * it existed) gets it rebuilt from the rows already there, once — the triggers only see writes
 * made after they exist.
 *
 * Never fatal: a build of SQLite without FTS5 would leave the replica unopenable over a feature
 * that only search needs. Local search reports itself unavailable instead
 * (`../data/local-search.ts`).
 */
export function ensureClientSearchIndex(driver: SqlDriver): boolean {
  // One savepoint: a half-made index (table there, triggers or rebuild not) would read as "had it"
  // on the next open and never be rebuilt.
  driver.exec("SAVEPOINT client_fts");
  try {
    const had = driver.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'block_fts'",
    );
    for (const stmt of CLIENT_FTS_STATEMENTS) driver.exec(stmt);
    if (!had) {
      driver.exec("INSERT INTO block_fts(block_fts) VALUES('rebuild')");
      driver.exec("INSERT INTO page_fts(page_fts) VALUES('rebuild')");
    }
    driver.exec("RELEASE client_fts");
    return true;
  } catch {
    driver.exec("ROLLBACK TO client_fts");
    driver.exec("RELEASE client_fts");
    return false;
  }
}

/** Create `pending_op`/`sync_state` on an already-core-schema'd database. Safe to call twice. */
export function initClientSchema(driver: { exec(sql: string): void }): void {
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) driver.exec(stmt);
}

/** `CLIENT_INDEX_STATEMENTS`, on a database that has the core tables. Safe on every open. */
export function ensureClientIndexes(driver: { exec(sql: string): void }): void {
  for (const stmt of CLIENT_INDEX_STATEMENTS) driver.exec(stmt);
}
