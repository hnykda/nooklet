/**
 * DDL for the state-mutation core: `page`, `block`, `block_prop`, `page_prop`, `op`.
 *
 * Adapted from `docs/spec/sql-schema.md`'s "Consolidated DDL" (Interfaces section), keeping only
 * the five tables this milestone implements. `ref`, `path_ref`, `page_alias`, the FTS/trigram
 * tables, `embedding*`, `asset`, `token`, `changes`, `mirror_file`, `plugin`, `setting`,
 * `keybinding` are out of scope (server/indexer concerns, later milestones) and intentionally
 * absent. `graph_id` is kept on every table per that spec's rule 2 even though this package never
 * sets it to anything but the column default, so the DDL stays byte-identical to the spec's.
 *
 * Deviation from sql-schema.md: `PRAGMA user_version` and the `schema_migration` bookkeeping
 * table are omitted — migration tracking is a server concern, not something `applyOps`/`rebuild`
 * need. PRAGMAs in general (`foreign_keys`, `journal_mode`, ...) are connection-level, not part of
 * DDL (sql-schema.md rule 29 agrees), so they are the driver implementation's job, not this file's.
 */

export const CORE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE page (
    id           TEXT PRIMARY KEY,
    graph_id     TEXT NOT NULL DEFAULT 'default',
    name         TEXT NOT NULL,
    key          TEXT NOT NULL,
    journal_day  INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    name_hlc     TEXT NOT NULL,
    deleted_hlc  TEXT,
    CHECK (journal_day IS NULL OR journal_day BETWEEN 10000101 AND 99991231)
  )`,
  `CREATE UNIQUE INDEX page_key ON page(key) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX page_journal_day ON page(journal_day) WHERE journal_day IS NOT NULL AND deleted_at IS NULL`,
  `CREATE INDEX page_updated_at ON page(updated_at)`,

  `CREATE TABLE block (
    id             TEXT PRIMARY KEY,
    graph_id       TEXT NOT NULL DEFAULT 'default',
    page_id        TEXT NOT NULL REFERENCES page(id),
    parent_id      TEXT REFERENCES block(id),
    order_key      TEXT NOT NULL,
    content        TEXT NOT NULL DEFAULT '',
    marker         TEXT CHECK (marker IS NULL OR marker IN ('TODO','DOING','LATER','NOW','WAITING','DONE','CANCELED')),
    priority       TEXT CHECK (priority IS NULL OR priority IN ('A','B','C')),
    collapsed      INTEGER NOT NULL DEFAULT 0,
    scheduled_day  INTEGER,
    scheduled_time TEXT,
    deadline_day   INTEGER,
    deadline_time  TEXT,
    repeat         TEXT,
    done_at        INTEGER,
    due_day        INTEGER GENERATED ALWAYS AS (coalesce(scheduled_day, deadline_day)) STORED,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    deleted_at     INTEGER,
    place_hlc      TEXT NOT NULL,
    content_hlc    TEXT NOT NULL,
    marker_hlc     TEXT,
    priority_hlc   TEXT,
    collapsed_hlc  TEXT,
    scheduled_hlc  TEXT,
    deadline_hlc   TEXT,
    repeat_hlc     TEXT,
    done_hlc       TEXT,
    deleted_hlc    TEXT,
    CHECK (parent_id IS NULL OR parent_id <> id)
  )`,
  `CREATE INDEX block_children ON block(parent_id, order_key) WHERE deleted_at IS NULL`,
  `CREATE INDEX block_page ON block(page_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX block_open_tasks ON block(due_day, id)
    WHERE deleted_at IS NULL AND marker IN ('TODO','DOING','LATER','NOW','WAITING')`,
  `CREATE INDEX block_marker ON block(marker) WHERE deleted_at IS NULL AND marker IS NOT NULL`,

  `CREATE TABLE block_prop (
    block_id TEXT NOT NULL REFERENCES block(id),
    key      TEXT NOT NULL,
    value    TEXT,
    hlc      TEXT NOT NULL,
    PRIMARY KEY (block_id, key)
  ) WITHOUT ROWID`,
  `CREATE INDEX block_prop_key_value ON block_prop(key, value)`,

  `CREATE TABLE page_prop (
    page_id TEXT NOT NULL REFERENCES page(id),
    key     TEXT NOT NULL,
    value   TEXT,
    hlc     TEXT NOT NULL,
    PRIMARY KEY (page_id, key)
  ) WITHOUT ROWID`,
  `CREATE INDEX page_prop_key_value ON page_prop(key, value)`,

  `CREATE TABLE op (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT NOT NULL UNIQUE,
    hlc          TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    entity       TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','noop','rejected'))
  )`,
  `CREATE INDEX op_hlc ON op(hlc)`,
  `CREATE INDEX op_entity ON op(entity, seq)`,
];

/** All statements joined, for drivers whose `exec` accepts a multi-statement script. */
export const CORE_SCHEMA_SQL: string = `${CORE_SCHEMA_STATEMENTS.join(";\n")};`;

/** Create `page`/`block`/`block_prop`/`page_prop`/`op` on an empty database. */
export function initSchema(driver: { exec(sql: string): void }): void {
  for (const stmt of CORE_SCHEMA_STATEMENTS) driver.exec(stmt);
}
