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

/** Create `pending_op`/`sync_state` on an already-core-schema'd database. Safe to call twice. */
export function initClientSchema(driver: { exec(sql: string): void }): void {
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) driver.exec(stmt);
}
