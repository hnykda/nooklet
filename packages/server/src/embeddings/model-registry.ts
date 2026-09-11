/**
 * `embedding_model` registry: create/find a model row, create its `embedding_vec_<id>` vec0
 * table with the discovered dimension interpolated as a literal (sql-schema.md rule 18 — dims
 * comes from the model, never user input), and the model-switch flow (rule 19): new row
 * inactive -> backfill -> atomically flip `active`.
 */

import type { SqlDriver } from "@nooklet/core";
import { getEmbeddingSettings } from "./settings.js";
import { getVecStatus } from "./vec-loader.js";

export interface EmbeddingModelRow {
  id: number;
  provider: string;
  model: string;
  dims: number;
  tableName: string;
  active: boolean;
  createdAt: number;
  readyAt: number | null;
}

interface EmbeddingModelDbRow {
  id: number;
  provider: string;
  model: string;
  dims: number;
  table_name: string;
  active: number;
  created_at: number;
  ready_at: number | null;
}

function fromDb(r: EmbeddingModelDbRow): EmbeddingModelRow {
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    dims: r.dims,
    tableName: r.table_name,
    active: r.active === 1,
    createdAt: r.created_at,
    readyAt: r.ready_at,
  };
}

export function getActiveModel(driver: SqlDriver): EmbeddingModelRow | undefined {
  const r = driver.get<EmbeddingModelDbRow>("SELECT * FROM embedding_model WHERE active = 1");
  return r ? fromDb(r) : undefined;
}

export function findModel(
  driver: SqlDriver,
  provider: string,
  model: string,
): EmbeddingModelRow | undefined {
  const r = driver.get<EmbeddingModelDbRow>(
    "SELECT * FROM embedding_model WHERE provider = ? AND model = ?",
    [provider, model],
  );
  return r ? fromDb(r) : undefined;
}

export function getModel(driver: SqlDriver, id: number): EmbeddingModelRow | undefined {
  const r = driver.get<EmbeddingModelDbRow>("SELECT * FROM embedding_model WHERE id = ?", [id]);
  return r ? fromDb(r) : undefined;
}

/** Every tracked model (active or mid-backfill) — the indexer maintains embeddings for all of them. */
export function listModels(driver: SqlDriver): EmbeddingModelRow[] {
  return driver.all<EmbeddingModelDbRow>("SELECT * FROM embedding_model ORDER BY id").map(fromDb);
}

function assertSafeDims(dims: number): void {
  if (!Number.isInteger(dims) || dims <= 0 || dims > 65536) {
    throw new Error(`invalid embedding dims: ${dims}`);
  }
}

function vecTableNameFor(id: number): string {
  return `embedding_vec_${id}`;
}

/** Create the per-model vec0 table. `dims` is interpolated as a literal (rule 18): it must come
 * from a value the server itself read from the provider, never from user input — `assertSafeDims`
 * is defense in depth, not the trust boundary itself. */
export function createVecTable(driver: SqlDriver, id: number, dims: number): void {
  assertSafeDims(dims);
  const table = vecTableNameFor(id);
  if (!/^embedding_vec_\d+$/.test(table))
    throw new Error(`unreachable: bad vec table name ${table}`);
  driver.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
      id INTEGER PRIMARY KEY,
      kind TEXT,
      page_key TEXT,
      embedding FLOAT[${dims}] distance_metric=cosine
    )`,
  );
}

export interface RegisterModelOptions {
  provider: string;
  model: string;
  dims: number;
}

/**
 * Rule 19 switch-over, step 1: create (or find) an `embedding_model` row + its vec0 table for
 * `provider`+`model`. New rows start `active = 0` — call `enqueueBackfill` then, once
 * `pendingCountForModel` reaches 0, `activateModel`. Idempotent: an existing provider+model row
 * is returned unchanged (re-selecting an already-known model is a no-op, not a fresh backfill).
 */
export function registerModel(driver: SqlDriver, opts: RegisterModelOptions): EmbeddingModelRow {
  const vec = getVecStatus(driver);
  if (!vec.loaded) {
    throw new Error(
      `sqlite-vec extension is not loaded (${vec.error ?? "unknown reason"}); cannot register an embedding model`,
    );
  }
  const existing = findModel(driver, opts.provider, opts.model);
  if (existing) return existing;
  assertSafeDims(opts.dims);
  return driver.transaction(() => {
    const now = Date.now();
    // Placeholder table_name until we know the autoincrement id; UNIQUE-safe within one call
    // since the driver is synchronous and single-connection (no interleaving inserts).
    const placeholder = `embedding_vec_pending_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const result = driver.run(
      "INSERT INTO embedding_model(provider, model, dims, table_name, active, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      [opts.provider, opts.model, opts.dims, placeholder, now],
    );
    const id = Number(result.lastInsertRowid);
    const tableName = vecTableNameFor(id);
    driver.run("UPDATE embedding_model SET table_name = ? WHERE id = ?", [tableName, id]);
    createVecTable(driver, id, opts.dims);
    return {
      id,
      provider: opts.provider,
      model: opts.model,
      dims: opts.dims,
      tableName,
      active: false,
      createdAt: now,
      readyAt: null,
    };
  });
}

/**
 * Rule 19/20: enqueue every current block/page as a dirty signal so the worker (re)computes an
 * `embedding` row for it under every currently-tracked model, including a freshly registered one.
 * `embed_dirty` is model-agnostic by design (rule 20: "the worker is what turns a dirty signal
 * into embedding rows across every currently-tracked model") — reusing it for a full backfill,
 * rather than writing `embedding` rows for just the new model directly, means the *exact same*
 * drain code path (`indexer.ts`) handles live edits, startup reconciliation, and a model switch's
 * backfill; already-up-to-date models simply no-op (their `embedded_hash` already matches).
 */
export function enqueueBackfill(driver: SqlDriver): number {
  const now = Date.now();
  return driver.transaction(() => {
    const blocks = driver.all<{ id: string }>("SELECT id FROM block WHERE deleted_at IS NULL");
    const pages = driver.all<{ id: string }>("SELECT id FROM page WHERE deleted_at IS NULL");
    for (const b of blocks) {
      driver.run(
        "INSERT OR IGNORE INTO embed_dirty(unit_kind, unit_id, enqueued_at) VALUES ('block', ?, ?)",
        [b.id, now],
      );
    }
    for (const p of pages) {
      driver.run(
        "INSERT OR IGNORE INTO embed_dirty(unit_kind, unit_id, enqueued_at) VALUES ('page', ?, ?)",
        [p.id, now],
      );
    }
    return blocks.length + pages.length;
  });
}

export function pendingCountForModel(driver: SqlDriver, modelId: number): number {
  return (
    driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM embedding WHERE model_id = ? AND status = 'pending'",
      [modelId],
    )?.n ?? 0
  );
}

export interface ModelCounts {
  /** Vectors actually stored in this model's `vec0` table. */
  indexed: number;
  pending: number;
  errors: number;
}

/** The vec0 table is created with its model row, but a database that has never been indexed (or
 * one opened without `sqlite-vec`) may not have it at all — probe rather than assume. */
function tableExists(driver: SqlDriver, name: string): boolean {
  return (
    (driver.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?", [name])
      ?.n ?? 0) > 0
  );
}

/**
 * How far along one model is. The single implementation of these three counts: `system.diagnostics`
 * and `embeddings.status` both report them, and two copies of "how many vectors does this model
 * have" would drift the moment the vec table's name or the `embedding` status vocabulary changed.
 */
export function modelCounts(driver: SqlDriver, model: EmbeddingModelRow): ModelCounts {
  const count = (sql: string, params: unknown[] = []): number =>
    driver.get<{ n: number }>(sql, params)?.n ?? 0;
  const vecReady = getVecStatus(driver).loaded && tableExists(driver, model.tableName);
  return {
    // `model.tableName` is registry-controlled (`vecTableNameFor`), never user input.
    indexed: vecReady ? count(`SELECT COUNT(*) AS n FROM ${model.tableName}`) : 0,
    pending: pendingCountForModel(driver, model.id),
    errors: count("SELECT COUNT(*) AS n FROM embedding WHERE model_id = ? AND status = 'error'", [
      model.id,
    ]),
  };
}

/** Units waiting to be turned into embeddings, across every tracked model (`embed_dirty` is
 * model-agnostic — rule 20). Non-zero means the indexer still has work queued. */
export function embedQueueLength(driver: SqlDriver): number {
  return driver.get<{ n: number }>("SELECT count(*) AS n FROM embed_dirty")?.n ?? 0;
}

/**
 * Rule 19's flip, automated: the *configured* model (`embedding.provider`/`embedding.model`
 * settings) becomes the active one as soon as its backfill has actually finished.
 *
 * Why this exists: the CLI's `embed model` performs rule 19's three steps — register, backfill,
 * flip — in one blocking foreground run, which a request handler cannot do (a real graph takes
 * minutes). Without something to finish the job, a model configured over HTTP would register,
 * enqueue its backfill, and then sit inactive forever, which is exactly the "semantic search is
 * configured but silently does nothing" failure this whole path exists to remove. Flipping early
 * instead — the other obvious option — is what rule 19 forbids, and for a good reason: switching
 * models would swap a complete index for an empty one mid-query.
 *
 * "Finished" means the shared queue is empty AND this model has no pending and no errored rows.
 * Errors count: a model that failed to embed half the graph has not been backfilled, and
 * activating it would present a half-empty index as the real thing. `embeddings.status` surfaces
 * that error count so the fix (repair the provider, then reindex) is visible.
 *
 * Called after every indexer drain and once by `embeddings.configure`, so a reconfigure of an
 * already-complete model activates immediately.
 */
export function promoteConfiguredModelIfReady(driver: SqlDriver): EmbeddingModelRow | undefined {
  const settings = getEmbeddingSettings(driver);
  const row = findModel(driver, settings.provider, settings.model);
  if (!row || row.active) return undefined;
  if (embedQueueLength(driver) > 0) return undefined;
  const counts = modelCounts(driver, row);
  if (counts.pending > 0 || counts.errors > 0) return undefined;
  activateModel(driver, row.id);
  return { ...row, active: true, readyAt: Date.now() };
}

/** Rule 19's atomic flip: two single-row UPDATEs in one transaction, so no query ever observes
 * zero or two active rows (the first statement always clears the only `active=1` row before the
 * second sets a new one, so the partial-unique index on `active` never collides). */
export function activateModel(driver: SqlDriver, modelId: number): void {
  driver.transaction(() => {
    driver.run("UPDATE embedding_model SET active = 0 WHERE active = 1");
    driver.run("UPDATE embedding_model SET active = 1, ready_at = ? WHERE id = ?", [
      Date.now(),
      modelId,
    ]);
  });
}

/** Reclaim disk for a model that is no longer active (rule 19: "SHOULD be dropped immediately
 * after the flip"). Refuses to drop the active model. */
export function dropModel(driver: SqlDriver, modelId: number): void {
  const row = driver.get<{ table_name: string; active: number }>(
    "SELECT table_name, active FROM embedding_model WHERE id = ?",
    [modelId],
  );
  if (!row || row.active === 1) return;
  driver.transaction(() => {
    driver.exec(`DROP TABLE IF EXISTS ${row.table_name}`); // table_name: registry-controlled, never user input
    driver.run("DELETE FROM embedding WHERE model_id = ?", [modelId]);
    driver.run("DELETE FROM embedding_model WHERE id = ?", [modelId]);
  });
}
