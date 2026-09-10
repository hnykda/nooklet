/**
 * KNN queries over an `embedding_vec_<id>` table. `tableName` is always interpolated (never
 * bound — SQLite cannot bind identifiers) and MUST come from the trusted `embedding_model`
 * registry, never from user input (sql-schema.md rule 19).
 *
 * Driver gotchas from `docs/research/06-embeddings.md` §2.3, applied here:
 *  - bind vectors as the `ArrayBuffer` (`Float32Array.buffer`), not the typed array itself;
 *  - `id`/other INTEGER vec0 columns bind fine as plain numbers for *reads* (this file only
 *    reads); only *inserts* need BigInt/cast (handled in `indexer.ts`).
 */

import type { SqlDriver } from "@nooklet/core";

export interface KnnHit {
  id: number;
  distance: number;
}

export interface KnnOptions {
  k: number;
  kind?: "block" | "page";
  /** Exclude everything on this page (vec0 `page_key` metadata column) — used by `related.find`
   * to hide a block's own siblings / a page hitting itself. Never partitioned by page (rule 2.3
   * gotcha 2 — chunk-size blowup); this is a plain filterable metadata column. */
  excludePageKey?: string;
  excludeId?: number;
}

const VEC_TABLE_RE = /^embedding_vec_\d+$/;

/** `Float32Array.buffer` is only correct when the array spans the whole underlying buffer; slice
 * defensively in case a caller ever hands us a view (e.g. `vec_slice` truncation later). */
function vecParam(vec: Float32Array): ArrayBufferLike {
  if (vec.byteOffset === 0 && vec.byteLength === vec.buffer.byteLength) return vec.buffer;
  return vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength);
}

export function knnQuery(
  driver: SqlDriver,
  tableName: string,
  queryVec: Float32Array,
  opts: KnnOptions,
): KnnHit[] {
  if (!VEC_TABLE_RE.test(tableName)) throw new Error(`unsafe vec table name: ${tableName}`);
  const conditions = ["embedding MATCH ?", "k = ?"];
  const params: unknown[] = [vecParam(queryVec), opts.k];
  if (opts.kind) {
    conditions.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.excludePageKey !== undefined) {
    conditions.push("page_key != ?");
    params.push(opts.excludePageKey);
  }
  if (opts.excludeId !== undefined) {
    conditions.push("id != ?");
    params.push(opts.excludeId);
  }
  const sql = `SELECT id, distance FROM ${tableName} WHERE ${conditions.join(" AND ")} ORDER BY distance`;
  return driver
    .all<{ id: number | bigint; distance: number }>(sql, params)
    .map((r) => ({ id: Number(r.id), distance: r.distance }));
}

/** Point lookup of an already-stored vector by its `embedding.id` (vec0 rowid) — used by
 * `related.find` to reuse the target's own vector instead of re-embedding it (research §5.3). */
export function knnPointLookup(
  driver: SqlDriver,
  tableName: string,
  id: number,
): ArrayBufferLike | undefined {
  if (!VEC_TABLE_RE.test(tableName)) throw new Error(`unsafe vec table name: ${tableName}`);
  const row = driver.get<{ embedding: Uint8Array }>(
    `SELECT embedding FROM ${tableName} WHERE id = ?`,
    [id],
  );
  if (!row) return undefined;
  const buf = row.embedding;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
