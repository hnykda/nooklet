/**
 * Drains `embed_dirty`: for each dirty unit, builds its text (chunker.ts/units.ts), hashes it,
 * skips units already up to date for a given model, otherwise embeds in batches of 64 and upserts
 * both the `embedding` bookkeeping row and the vector (research/06 §4.4).
 *
 * Runs on an interval (`start`/`stop`) and on demand (`runOnce`/`drainUntilEmpty`); every network
 * call takes the current `AbortSignal`, so a caller can cancel a run in flight. `providerFor` is
 * injected so tests can supply a `FakeEmbeddingProvider` and this file never has to know about
 * `factory.ts`/network at all.
 */

import type { SqlDriver } from "@nooklet/core";
import { hashText } from "./chunker.js";
import type { EmbeddingModelRow } from "./model-registry.js";
import { listModels, promoteConfiguredModelIfReady } from "./model-registry.js";
import type { EmbeddingProvider } from "./provider.js";
import { buildBlockUnit, buildPageUnit } from "./units.js";

export const EMBED_BATCH_SIZE = 64;

export interface IndexerDeps {
  driver: SqlDriver;
  providerFor: (model: EmbeddingModelRow) => Promise<EmbeddingProvider> | EmbeddingProvider;
  log?: (message: string) => void;
}

export interface DrainStats {
  /** Dirty units looked at this run. */
  processedUnits: number;
  /** (unit, model) pairs actually sent to a provider and written. */
  embeddedPairs: number;
  /** Units found deleted/no-longer-embeddable; their embedding rows/vectors were removed. */
  deletedUnits: number;
  errors: number;
}

const EMPTY_STATS: DrainStats = { processedUnits: 0, embeddedPairs: 0, deletedUnits: 0, errors: 0 };

interface PendingItem {
  embeddingRowId: number;
  text: string;
  kind: "block" | "page";
  pageKey: string;
}

export class EmbeddingIndexer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;
  private abort: AbortController | undefined;

  constructor(private readonly deps: IndexerDeps) {}

  /** Start draining on a timer. Overlapping ticks are skipped (a slow run just delays the next
   * tick's work, never runs two drains against the same connection at once). */
  start(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce({ limit: EMBED_BATCH_SIZE * 4 }).catch((err: unknown) => {
        this.deps.log?.(`embedding indexer: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
  }

  /** Drain up to `limit` dirty units once. Never runs concurrently with itself. */
  async runOnce(opts: { limit?: number; signal?: AbortSignal } = {}): Promise<DrainStats> {
    if (this.draining) return EMPTY_STATS;
    this.draining = true;
    this.abort = new AbortController();
    const signal = opts.signal ?? this.abort.signal;
    try {
      const stats = await drainOnce(this.deps, { limit: opts.limit ?? 256, signal });
      // Rule 19's flip, once the backfill it was waiting on is actually done. This is the only
      // thing that finishes a model switch started over HTTP (`embeddings.configure`), which
      // cannot block for the minutes a real backfill takes — see `promoteConfiguredModelIfReady`.
      const promoted = promoteConfiguredModelIfReady(this.deps.driver);
      if (promoted) {
        this.deps.log?.(
          `activated ${promoted.provider}:${promoted.model} (id ${promoted.id}) — backfill complete`,
        );
      }
      return stats;
    } finally {
      this.draining = false;
    }
  }

  /** Drain until the queue is empty (or cancelled) — used by `nooklet embed run` and a model
   * switch's backfill. */
  async drainUntilEmpty(
    opts: { signal?: AbortSignal; onProgress?: (s: DrainStats) => void } = {},
  ): Promise<DrainStats> {
    const total: DrainStats = { processedUnits: 0, embeddedPairs: 0, deletedUnits: 0, errors: 0 };
    for (;;) {
      const stats = await this.runOnce({ limit: 256, signal: opts.signal });
      total.processedUnits += stats.processedUnits;
      total.embeddedPairs += stats.embeddedPairs;
      total.deletedUnits += stats.deletedUnits;
      total.errors += stats.errors;
      opts.onProgress?.(stats);
      if (stats.processedUnits === 0 || opts.signal?.aborted) break;
    }
    return total;
  }
}

function getEmbeddingRow(
  driver: SqlDriver,
  modelId: number,
  kind: "block" | "page",
  unitId: string,
): { id: number; embeddedHash: string | null } | undefined {
  const row =
    kind === "block"
      ? driver.get<{ id: number; embedded_hash: string | null }>(
          "SELECT id, embedded_hash FROM embedding WHERE model_id = ? AND block_id = ?",
          [modelId, unitId],
        )
      : driver.get<{ id: number; embedded_hash: string | null }>(
          "SELECT id, embedded_hash FROM embedding WHERE model_id = ? AND unit_kind = 'page' AND page_id = ?",
          [modelId, unitId],
        );
  return row ? { id: row.id, embeddedHash: row.embedded_hash } : undefined;
}

function upsertEmbeddingBookkeeping(
  driver: SqlDriver,
  modelId: number,
  kind: "block" | "page",
  unitId: string,
  pageId: string,
  textHash: string,
): number {
  const existing = getEmbeddingRow(driver, modelId, kind, unitId);
  const now = Date.now();
  if (existing) {
    driver.run(
      "UPDATE embedding SET text_hash = ?, status = 'pending', error = NULL, updated_at = ? WHERE id = ?",
      [textHash, now, existing.id],
    );
    return existing.id;
  }
  const blockId = kind === "block" ? unitId : null;
  const result = driver.run(
    "INSERT INTO embedding(model_id, unit_kind, block_id, page_id, text_hash, status, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    [modelId, kind, blockId, pageId, textHash, now],
  );
  return Number(result.lastInsertRowid);
}

function markEmbeddingError(driver: SqlDriver, embeddingRowId: number, message: string): void {
  driver.run("UPDATE embedding SET status = 'error', error = ?, updated_at = ? WHERE id = ?", [
    message.slice(0, 2000),
    Date.now(),
    embeddingRowId,
  ]);
}

/** Write the vector row (UPDATE-then-INSERT: vec0 in this sqlite-vec version rejects
 * `INSERT OR REPLACE`, verified locally — see research/06 §2.3) and mark the bookkeeping row
 * done. Ids bind as BigInt for vec0's typed INTEGER primary key (gotcha 1). */
function finalizeEmbedding(
  driver: SqlDriver,
  model: EmbeddingModelRow,
  item: PendingItem,
  vec: Float32Array,
): void {
  const buf = vec.buffer;
  const id = BigInt(item.embeddingRowId);
  const upd = driver.run(
    `UPDATE ${model.tableName} SET kind = ?, page_key = ?, embedding = ? WHERE id = ?`,
    [item.kind, item.pageKey, buf, id],
  );
  if (upd.changes === 0) {
    driver.run(
      `INSERT INTO ${model.tableName}(id, kind, page_key, embedding) VALUES (?, ?, ?, ?)`,
      [id, item.kind, item.pageKey, buf],
    );
  }
  driver.run(
    "UPDATE embedding SET embedded_hash = text_hash, status = 'done', error = NULL, updated_at = ? WHERE id = ?",
    [Date.now(), item.embeddingRowId],
  );
}

function deleteUnitEmbedding(
  driver: SqlDriver,
  model: EmbeddingModelRow,
  kind: "block" | "page",
  unitId: string,
): void {
  const row = getEmbeddingRow(driver, model.id, kind, unitId);
  if (!row) return;
  driver.run(`DELETE FROM ${model.tableName} WHERE id = ?`, [BigInt(row.id)]);
  driver.run("DELETE FROM embedding WHERE id = ?", [row.id]);
}

async function drainOnce(
  deps: IndexerDeps,
  opts: { limit: number; signal: AbortSignal },
): Promise<DrainStats> {
  const { driver } = deps;
  const dirtyRows = driver.all<{ unit_kind: "block" | "page"; unit_id: string }>(
    "SELECT unit_kind, unit_id FROM embed_dirty ORDER BY enqueued_at LIMIT ?",
    [opts.limit],
  );
  const stats: DrainStats = { processedUnits: 0, embeddedPairs: 0, deletedUnits: 0, errors: 0 };
  if (dirtyRows.length === 0) return stats;

  const models = listModels(driver);
  const pendingByModel = new Map<number, PendingItem[]>();

  for (const row of dirtyRows) {
    if (opts.signal.aborted) break;
    stats.processedUnits++;
    const built =
      row.unit_kind === "block"
        ? buildBlockUnit(driver, row.unit_id)
        : buildPageUnit(driver, row.unit_id);
    if (!built) {
      for (const model of models) deleteUnitEmbedding(driver, model, row.unit_kind, row.unit_id);
      driver.run("DELETE FROM embed_dirty WHERE unit_kind = ? AND unit_id = ?", [
        row.unit_kind,
        row.unit_id,
      ]);
      stats.deletedUnits++;
      continue;
    }
    const textHash = hashText(built.text);
    for (const model of models) {
      const existing = getEmbeddingRow(driver, model.id, row.unit_kind, row.unit_id);
      if (existing && existing.embeddedHash === textHash) continue; // already up to date
      const embeddingRowId = upsertEmbeddingBookkeeping(
        driver,
        model.id,
        row.unit_kind,
        row.unit_id,
        built.pageId,
        textHash,
      );
      const list = pendingByModel.get(model.id) ?? [];
      list.push({ embeddingRowId, text: built.text, kind: row.unit_kind, pageKey: built.pageKey });
      pendingByModel.set(model.id, list);
    }
    driver.run("DELETE FROM embed_dirty WHERE unit_kind = ? AND unit_id = ?", [
      row.unit_kind,
      row.unit_id,
    ]);
  }

  for (const model of models) {
    const items = pendingByModel.get(model.id);
    if (!items || items.length === 0 || opts.signal.aborted) continue;
    let provider: EmbeddingProvider;
    try {
      provider = await deps.providerFor(model);
    } catch (err) {
      stats.errors += items.length;
      const message = err instanceof Error ? err.message : String(err);
      for (const it of items) markEmbeddingError(driver, it.embeddingRowId, message);
      continue;
    }
    for (let i = 0; i < items.length; i += EMBED_BATCH_SIZE) {
      if (opts.signal.aborted) break;
      const batch = items.slice(i, i + EMBED_BATCH_SIZE);
      try {
        const vectors = await provider.embed(
          batch.map((b) => b.text),
          "document",
          opts.signal,
        );
        driver.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            const item = batch[j];
            const vec = vectors[j];
            if (!item || !vec) continue;
            finalizeEmbedding(driver, model, item, vec);
            stats.embeddedPairs++;
          }
        });
      } catch (err) {
        stats.errors += batch.length;
        const message = err instanceof Error ? err.message : String(err);
        for (const it of batch) markEmbeddingError(driver, it.embeddingRowId, message);
      }
    }
  }
  return stats;
}
