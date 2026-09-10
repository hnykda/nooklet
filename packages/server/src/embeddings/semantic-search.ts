/**
 * Glue between the model registry / KNN and `ops/search.ts` + `ops/related.ts`: is semantic
 * search available right now, embed a query, and turn raw vec0 hits (rowids into `embedding_vec_
 * <id>`) back into block/page ids ordered by similarity.
 */

import type { SqlDriver } from "@nooklet/core";
import { buildProviderForModel } from "./factory.js";
import { knnQuery } from "./knn.js";
import { type EmbeddingModelRow, getActiveModel } from "./model-registry.js";
import { getVecStatus } from "./vec-loader.js";

export interface SemanticAvailability {
  available: boolean;
  model?: EmbeddingModelRow;
  reason?: string;
}

export function checkSemanticAvailability(driver: SqlDriver): SemanticAvailability {
  const vec = getVecStatus(driver);
  if (!vec.loaded) return { available: false, reason: vec.error ?? "sqlite-vec not loaded" };
  const model = getActiveModel(driver);
  if (!model) return { available: false, reason: "no active embedding model configured" };
  return { available: true, model };
}

/** Embed the query text with the active model's provider. Fails soft (`undefined`, never throws)
 * so callers can fall back to keyword search on a network error / Ollama being down. */
export async function embedQueryVector(
  driver: SqlDriver,
  model: EmbeddingModelRow,
  query: string,
  signal?: AbortSignal,
): Promise<Float32Array | undefined> {
  try {
    const provider = buildProviderForModel(driver, model);
    const [vec] = await provider.embed([query], "query", signal);
    return vec;
  } catch {
    return undefined;
  }
}

export interface SemanticCandidate {
  unitId: string;
  distance: number;
}

/** KNN over the model's vec0 table, mapped back to block/page ids via the `embedding` bookkeeping
 * table, best match first. */
export function semanticCandidates(
  driver: SqlDriver,
  model: EmbeddingModelRow,
  queryVec: Float32Array,
  kind: "block" | "page",
  k = 50,
): SemanticCandidate[] {
  const hits = knnQuery(driver, model.tableName, queryVec, { k, kind });
  if (hits.length === 0) return [];
  const ids = hits.map((h) => h.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = driver.all<{ id: number; block_id: string | null; page_id: string }>(
    `SELECT id, block_id, page_id FROM embedding WHERE model_id = ? AND id IN (${placeholders})`,
    [model.id, ...ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: SemanticCandidate[] = [];
  for (const h of hits) {
    const row = byId.get(h.id);
    if (!row) continue;
    const unitId = kind === "block" ? row.block_id : row.page_id;
    if (!unitId) continue;
    out.push({ unitId, distance: h.distance });
  }
  return out;
}

/** Cosine distance (0 = identical, ~1 orthogonal, up to 2 opposite) -> a 0..1 similarity score,
 * consistent with the keyword path's `1 / (1 + rank)` shape. */
export function distanceToScore(distance: number): number {
  return 1 / (1 + Math.max(0, distance));
}
