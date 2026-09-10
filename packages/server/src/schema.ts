/**
 * Server-only tables that extend `@nooklet/core`'s state-mutation core (`page`, `block`,
 * `block_prop`, `page_prop`, `op`) into the full graph store: `docs/spec/sql-schema.md`'s
 * "Consolidated DDL", minus the five tables `@nooklet/core` already owns.
 *
 * Adds: `schema_migration` bookkeeping, `setting`/`keybinding`/`plugin` state, derived
 * `ref`/`path_ref`/`page_alias` and FTS5 (`block_fts`/`block_tri`/`page_fts`/`page_tri`) plus
 * their sync triggers, and the server-only bookkeeping tables (`changes`, `token`, `device`,
 * `mirror_file`, `asset`, `embedding_model`, `embedding`, `embed_dirty`). The dynamic
 * `embedding_vec_<id>` tables (rule 18) are created at runtime once a model is chosen (M3), not
 * part of this static DDL.
 */

import type { SqlDriver } from "@nooklet/core";
import { CORE_SCHEMA_STATEMENTS } from "@nooklet/core";

export const SERVER_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE schema_migration (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT NOT NULL
  )`,

  `CREATE TABLE setting (
    key        TEXT PRIMARY KEY,
    graph_id   TEXT NOT NULL DEFAULT 'default',
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    hlc        TEXT NOT NULL
  )`,

  `CREATE TABLE keybinding (
    id          TEXT PRIMARY KEY,
    graph_id    TEXT NOT NULL DEFAULT 'default',
    key         TEXT NOT NULL,
    command     TEXT NOT NULL,
    when_expr   TEXT,
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER,
    hlc         TEXT NOT NULL,
    deleted_hlc TEXT
  )`,
  `CREATE INDEX keybinding_command ON keybinding(command) WHERE deleted_at IS NULL`,
  `CREATE INDEX keybinding_key ON keybinding(key) WHERE deleted_at IS NULL`,

  `CREATE TABLE plugin (
    id            TEXT PRIMARY KEY,
    graph_id      TEXT NOT NULL DEFAULT 'default',
    version       TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    settings_json TEXT NOT NULL DEFAULT '{}',
    installed_at  INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    hlc           TEXT NOT NULL
  )`,

  // -------------------------------------------------------------- derived: refs
  `CREATE TABLE ref (
    id           INTEGER PRIMARY KEY,
    src_block_id TEXT NOT NULL REFERENCES block(id),
    src_page_id  TEXT NOT NULL REFERENCES page(id),
    kind         TEXT NOT NULL CHECK (kind IN ('page','tag','block','embed')),
    dst_page_key TEXT,
    dst_page_id  TEXT,
    dst_block_id TEXT
  )`,
  `CREATE INDEX ref_src ON ref(src_block_id)`,
  `CREATE INDEX ref_dst_page_key ON ref(dst_page_key) WHERE dst_page_key IS NOT NULL`,
  `CREATE INDEX ref_dst_block ON ref(dst_block_id) WHERE dst_block_id IS NOT NULL`,

  `CREATE TABLE path_ref (
    block_id TEXT NOT NULL REFERENCES block(id),
    page_key TEXT NOT NULL,
    page_id  TEXT,
    PRIMARY KEY (block_id, page_key)
  ) WITHOUT ROWID`,
  `CREATE INDEX path_ref_page_key ON path_ref(page_key)`,

  `CREATE TABLE page_alias (
    page_id   TEXT NOT NULL REFERENCES page(id),
    alias_key TEXT NOT NULL,
    PRIMARY KEY (page_id, alias_key)
  ) WITHOUT ROWID`,
  `CREATE INDEX page_alias_key ON page_alias(alias_key)`,

  // -------------------------------------------------------------- derived: full-text search
  `CREATE VIRTUAL TABLE block_fts USING fts5(
    content, content='block', content_rowid='rowid',
    tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
  )`,
  `CREATE VIRTUAL TABLE block_tri USING fts5(
    content, content='block', content_rowid='rowid', tokenize='trigram'
  )`,
  `CREATE TRIGGER block_fts_ai AFTER INSERT ON block BEGIN
    INSERT INTO block_fts(rowid, content) VALUES (new.rowid, new.content);
    INSERT INTO block_tri(rowid, content) VALUES (new.rowid, new.content);
  END`,
  `CREATE TRIGGER block_fts_ad AFTER DELETE ON block BEGIN
    INSERT INTO block_fts(block_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO block_tri(block_tri, rowid, content) VALUES('delete', old.rowid, old.content);
  END`,
  `CREATE TRIGGER block_fts_au AFTER UPDATE OF content ON block BEGIN
    INSERT INTO block_fts(block_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO block_fts(rowid, content) VALUES (new.rowid, new.content);
    INSERT INTO block_tri(block_tri, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO block_tri(rowid, content) VALUES (new.rowid, new.content);
  END`,

  `CREATE VIRTUAL TABLE page_fts USING fts5(
    name, content='page', content_rowid='rowid',
    tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
  )`,
  `CREATE VIRTUAL TABLE page_tri USING fts5(
    name, content='page', content_rowid='rowid', tokenize='trigram'
  )`,
  `CREATE TRIGGER page_fts_ai AFTER INSERT ON page BEGIN
    INSERT INTO page_fts(rowid, name) VALUES (new.rowid, new.name);
    INSERT INTO page_tri(rowid, name) VALUES (new.rowid, new.name);
  END`,
  `CREATE TRIGGER page_fts_ad AFTER DELETE ON page BEGIN
    INSERT INTO page_fts(page_fts, rowid, name) VALUES('delete', old.rowid, old.name);
    INSERT INTO page_tri(page_tri, rowid, name) VALUES('delete', old.rowid, old.name);
  END`,
  `CREATE TRIGGER page_fts_au AFTER UPDATE OF name ON page BEGIN
    INSERT INTO page_fts(page_fts, rowid, name) VALUES('delete', old.rowid, old.name);
    INSERT INTO page_fts(rowid, name) VALUES (new.rowid, new.name);
    INSERT INTO page_tri(page_tri, rowid, name) VALUES('delete', old.rowid, old.name);
    INSERT INTO page_tri(rowid, name) VALUES (new.rowid, new.name);
  END`,

  // -------------------------------------------------------------- server-only bookkeeping
  `CREATE TABLE changes (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    graph_id    TEXT NOT NULL DEFAULT 'default',
    batch_id    TEXT NOT NULL,
    origin      TEXT NOT NULL CHECK (origin IN ('user','api','mcp','sync','plugin','import','mirror','system')),
    actor       TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('page','block','setting','keybinding','plugin','asset')),
    entity_id   TEXT NOT NULL,
    op_ids_json TEXT NOT NULL DEFAULT '[]',
    before_json TEXT,
    after_json  TEXT,
    created_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX changes_batch ON changes(batch_id)`,
  `CREATE INDEX changes_entity ON changes(entity_type, entity_id, seq)`,

  `CREATE TABLE token (
    id           TEXT PRIMARY KEY,
    graph_id     TEXT NOT NULL DEFAULT 'default',
    label        TEXT NOT NULL,
    scope        TEXT NOT NULL CHECK (scope IN ('read','write','admin')),
    can_sync     INTEGER NOT NULL DEFAULT 0,
    ui_control   INTEGER NOT NULL DEFAULT 0,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at   INTEGER
  )`,

  `CREATE TABLE device (
    id           TEXT PRIMARY KEY,
    graph_id     TEXT NOT NULL DEFAULT 'default',
    name         TEXT NOT NULL,
    token_id     TEXT REFERENCES token(id),
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    acked_seq    INTEGER NOT NULL DEFAULT 0
  )`,

  `CREATE TABLE mirror_file (
    path         TEXT PRIMARY KEY,
    graph_id     TEXT NOT NULL DEFAULT 'default',
    page_id      TEXT NOT NULL REFERENCES page(id),
    content_hash TEXT NOT NULL,
    written_at   INTEGER NOT NULL
  )`,
  `CREATE INDEX mirror_file_page ON mirror_file(page_id)`,

  `CREATE TABLE asset (
    id         TEXT PRIMARY KEY,
    graph_id   TEXT NOT NULL DEFAULT 'default',
    file_name  TEXT NOT NULL,
    ext        TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    byte_size  INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    width      INTEGER,
    height     INTEGER,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE UNIQUE INDEX asset_sha256 ON asset(sha256) WHERE deleted_at IS NULL`,

  // -------------------------------------------------------------- server-only: embeddings (M3 populates)
  `CREATE TABLE embedding_model (
    id         INTEGER PRIMARY KEY,
    graph_id   TEXT NOT NULL DEFAULT 'default',
    provider   TEXT NOT NULL,
    model      TEXT NOT NULL,
    dims       INTEGER NOT NULL,
    table_name TEXT NOT NULL UNIQUE,
    active     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    ready_at   INTEGER
  )`,
  `CREATE UNIQUE INDEX embedding_model_active ON embedding_model(active) WHERE active = 1`,

  `CREATE TABLE embedding (
    id            INTEGER PRIMARY KEY,
    model_id      INTEGER NOT NULL REFERENCES embedding_model(id),
    unit_kind     TEXT NOT NULL CHECK (unit_kind IN ('block','page')),
    block_id      TEXT REFERENCES block(id),
    page_id       TEXT NOT NULL REFERENCES page(id),
    text_hash     TEXT NOT NULL,
    embedded_hash TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
    error         TEXT,
    updated_at    INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX embedding_model_block ON embedding(model_id, block_id) WHERE block_id IS NOT NULL`,
  `CREATE UNIQUE INDEX embedding_model_page ON embedding(model_id, page_id) WHERE unit_kind = 'page'`,
  `CREATE INDEX embedding_pending ON embedding(model_id) WHERE status <> 'done'`,

  `CREATE TABLE embed_dirty (
    unit_kind   TEXT NOT NULL CHECK (unit_kind IN ('block','page')),
    unit_id     TEXT NOT NULL,
    enqueued_at INTEGER NOT NULL,
    PRIMARY KEY (unit_kind, unit_id)
  ) WITHOUT ROWID`,

  // -------------------------------------------------------------- M4/ADR 007: plugin kv store
  // `ctx.kv` (api-and-plugin-types.md §4): a tiny per-plugin key-value table, namespaced by
  // `plugin_id` so one plugin can never read/write another's keys. Added in SCHEMA_VERSION 2 —
  // see MIGRATIONS below for how an existing (v1) database picks this up without a full rebuild.
  `CREATE TABLE plugin_kv (
    plugin_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, key)
  ) WITHOUT ROWID`,
];

/**
 * One additive migration per schema bump, applied in order to bring an EXISTING database from
 * `version` up to `version + 1` (`db.ts`'s `openDbWithStatus`). Kept separate from
 * `SERVER_SCHEMA_STATEMENTS` (which is only ever run once, on a brand-new database via
 * `initFullSchema`) so the two never drift: a fresh database gets `plugin_kv` from
 * `SERVER_SCHEMA_STATEMENTS` directly, an upgraded one gets the identical table from the matching
 * migration entry below. `CREATE TABLE IF NOT EXISTS` makes re-running a migration (should never
 * happen in practice — `db.ts` tracks `schema_migration` — but costs nothing) harmless.
 */
export interface Migration {
  version: number;
  description: string;
  up: (driver: SqlDriver) => void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    description: "add plugin_kv (M4 plugins: ctx.kv)",
    up: (driver) => {
      driver.exec(`CREATE TABLE IF NOT EXISTS plugin_kv (
        plugin_id  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, key)
      ) WITHOUT ROWID`);
    },
  },
  {
    version: 3,
    description: "add token.ui_control (ADR 015: live-UI-control capability)",
    up: (driver) => {
      // SQLite has no "ADD COLUMN IF NOT EXISTS"; guard defensively anyway (matches this file's
      // own `CREATE TABLE IF NOT EXISTS` guard on the migration above) in case a database was
      // somehow rebuilt from a schema.ts already carrying the column.
      const hasColumn = driver
        .all<{ name: string }>("PRAGMA table_info(token)")
        .some((c) => c.name === "ui_control");
      if (!hasColumn) {
        driver.exec("ALTER TABLE token ADD COLUMN ui_control INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
];

export const SCHEMA_VERSION = 3;

/** Create the full server schema (core tables + this file's) on an empty database. */
export function initFullSchema(driver: SqlDriver): void {
  driver.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  for (const stmt of CORE_SCHEMA_STATEMENTS) driver.exec(stmt);
  for (const stmt of SERVER_SCHEMA_STATEMENTS) driver.exec(stmt);
  driver.run("INSERT INTO schema_migration(version, applied_at, description) VALUES (?, ?, ?)", [
    SCHEMA_VERSION,
    Date.now(),
    "initial schema",
  ]);
}
