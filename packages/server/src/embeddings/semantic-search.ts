/**
 * Glue between the model registry / KNN and `ops/search.ts` + `ops/related.ts`: is semantic
 * search available right now, embed a query, and turn raw vec0 hits (rowids into `embedding_vec_
 * <id>`) back into block/page ids ordered by similarity.
 */

import type { SqlDriver } from "@nooklet/core";
import { buildProviderForModel } from "./factory.js";
import { knnQuery } from "./knn.js";
import {
  type EmbeddingModelRow,
  embedQueueLength,
  findModel,
  getActiveModel,
  modelCounts,
} from "./model-registry.js";
import { messageOf, probeEmbeddingProvider } from "./probe.js";
import { type EmbeddingProviderKind, getEmbeddingSettings } from "./settings.js";
import { getVecStatus } from "./vec-loader.js";

/**
 * Why a semantic or hybrid search answered with keyword results instead (B-520).
 *
 * Every one of these used to reach the reader as the same four words, "Fell back to keyword",
 * which cannot be acted on: the fix for "never set up" (open Settings) is nothing like the fix for
 * "Ollama is not running" (start it) or "still indexing" (wait). The server is the only side that
 * can tell them apart, so it says which — `reason` for code to branch on, `message` as a sentence
 * for an agent or an older client to show as-is.
 */
export type SemanticFallbackReason =
  /** The vec0 extension did not load; no vectors can be stored or queried on this server. */
  | "sqlite_vec_unavailable"
  /** No model was ever registered for the configured provider/model — the state a fresh install is in. */
  | "not_configured"
  /** The configured model is registered and its backfill is still running. */
  | "indexing"
  /** The backfill finished its queue but some units failed to embed, so the model never activated. */
  | "index_incomplete"
  /** A model is active, but its server did not answer when the query was embedded. */
  | "provider_unreachable"
  /** A model is active and its server answers, but no longer has that model. */
  | "model_missing"
  /** A model is active and its server answers, yet embedding the query failed anyway. */
  | "query_embedding_failed";

export interface SemanticFallback {
  reason: SemanticFallbackReason;
  message: string;
  provider?: string;
  model?: string;
  host?: string;
  /** Vectors stored so far (`indexing`, `index_incomplete`). */
  indexed?: number;
  /** Units the index will hold once done: indexed + pending + failed + still queued. It shrinks a
   * little as the queue drains, because empty blocks are dropped rather than embedded. */
  total?: number;
  /** Units that failed to embed (`indexing`, `index_incomplete`). */
  errors?: number;
  /** The underlying error text, verbatim, when there is one. */
  error?: string;
}

export interface SemanticAvailability {
  available: boolean;
  model?: EmbeddingModelRow;
  /** Set exactly when `available` is false. */
  fallback?: SemanticFallback;
}

/** The newest stored embedding error for a model — what the indexer's provider actually said. */
function lastEmbeddingError(driver: SqlDriver, modelId: number): string | undefined {
  return (
    driver.get<{ error: string | null }>(
      "SELECT error FROM embedding WHERE model_id = ? AND status = 'error' ORDER BY updated_at DESC LIMIT 1",
      [modelId],
    )?.error ?? undefined
  );
}

export function checkSemanticAvailability(driver: SqlDriver): SemanticAvailability {
  const vec = getVecStatus(driver);
  if (!vec.loaded) {
    const error = vec.error ?? "sqlite-vec not loaded";
    return {
      available: false,
      fallback: {
        reason: "sqlite_vec_unavailable",
        message: `Semantic search cannot run on this server: the sqlite-vec extension did not load (${error}).`,
        error,
      },
    };
  }
  const model = getActiveModel(driver);
  if (model) return { available: true, model };

  // No active model. Whether that is "never set up" or "set up and not ready yet" is decided by
  // the configured model's registry row — `embeddings.configure` writes the settings and the row
  // together, and the row stays inactive until its backfill completes (rule 19).
  const settings = getEmbeddingSettings(driver);
  const registered = findModel(driver, settings.provider, settings.model);
  if (!registered) {
    return {
      available: false,
      fallback: {
        reason: "not_configured",
        message:
          "Semantic search is not set up: no embedding model is configured. It can be turned on " +
          "in Settings → Search & embeddings.",
      },
    };
  }
  const counts = modelCounts(driver, registered);
  const queued = embedQueueLength(driver);
  const total = counts.indexed + counts.pending + counts.errors + queued;
  const named = `${registered.provider}:${registered.model}`;
  const common = {
    provider: registered.provider,
    model: registered.model,
    host: settings.host,
    indexed: counts.indexed,
    total,
    errors: counts.errors,
  };
  // Mirrors `promoteConfiguredModelIfReady`: it activates when the queue is empty and nothing is
  // pending or failed. Queue empty with failures left is the one state it never leaves on its own.
  if (queued === 0 && counts.pending === 0 && counts.errors > 0) {
    const error = lastEmbeddingError(driver, registered.id);
    return {
      available: false,
      fallback: {
        reason: "index_incomplete",
        message:
          `Indexing ${named} stopped with ${counts.errors} item(s) that failed to embed ` +
          `(${counts.indexed} of ${total} embedded), so it was not switched on` +
          `${error ? `. Last error: ${error}` : ""}. Fix the embedding server, then re-index from Settings.`,
        ...common,
        ...(error ? { error } : {}),
      },
    };
  }
  return {
    available: false,
    fallback: {
      reason: "indexing",
      message:
        `The semantic index for ${named} is still being built (${counts.indexed} of ${total} ` +
        "embedded); search uses it as soon as it is complete.",
      ...common,
    },
  };
}

export type QueryEmbedding =
  | { vector: Float32Array; fallback?: undefined }
  | { vector?: undefined; fallback: SemanticFallback };

/**
 * How long a search waits for its query vector before answering with keyword results instead.
 *
 * Without a bound, a host that accepts the connection and never answers held every semantic and
 * hybrid search for undici's 300 s header timeout — "Searching…" with no end (B-522). A warm
 * model answers in milliseconds; the bound has to clear a COLD one, which Ollama loads into memory
 * on the first request after its keep-alive lapses. Measured 2026-09-13 on an M4 Pro at load
 * average ~70, bge-m3 unloaded first: whole semantic searches of 5.9 s, 4.2 s and 1.4 s cold,
 * 0.08 s warm. 15 s leaves 2.5x the worst of those.
 */
export const QUERY_EMBED_TIMEOUT_MS = 15_000;

/**
 * Embed the query text with the active model's provider, and on failure say why. Never throws.
 *
 * A failed embed is classified by asking the host what it has (`probeEmbeddingProvider`, one GET
 * with a short timeout) — only on this failure path, so a working search pays nothing for it. The
 * provider's own error cannot be trusted to tell the cases apart: a refused connection arrives as
 * a bare "fetch failed", a missing model as a raw HTTP body.
 */
export async function embedQueryForSearch(
  driver: SqlDriver,
  model: EmbeddingModelRow,
  query: string,
  signal?: AbortSignal,
  opts: { timeoutMs?: number } = {},
): Promise<QueryEmbedding> {
  const timeoutMs = opts.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  let failure: string;
  // Read once, at the failure: `timeout` keeps ticking through the probe below and would later
  // read as aborted for a failure that had nothing to do with it.
  let timedOut = false;
  try {
    const provider = buildProviderForModel(driver, model);
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const [vector] = await provider.embed([query], "query", bounded);
    if (vector) return { vector };
    failure = "the provider returned no vector";
  } catch (err) {
    timedOut = timeout.aborted && !signal?.aborted;
    // An abort by our own bound reads "This operation was aborted" — true, and no help.
    failure = timedOut ? `no answer within ${timeoutMs / 1000} s` : messageOf(err);
  }

  const settings = getEmbeddingSettings(driver);
  const named = `${model.provider}:${model.model}`;
  const common = { provider: model.provider, model: model.model, host: settings.host };
  // A request its caller already abandoned has no reader for a diagnosis; do not go probing.
  if (signal?.aborted) {
    return {
      fallback: {
        reason: "query_embedding_failed",
        message: `Embedding the query with ${named} was cancelled.`,
        ...common,
        error: failure,
      },
    };
  }
  const probe = await probeEmbeddingProvider({
    provider: model.provider as EmbeddingProviderKind,
    model: model.model,
    host: settings.host,
  });
  if (probe.reachable === false) {
    // A host that let both calls time out is better described by the longer wait than by the
    // probe's own generic abort message.
    const error = timedOut ? failure : (probe.error ?? failure);
    return {
      fallback: {
        reason: "provider_unreachable",
        message: `The embedding server at ${settings.host} is not reachable (${error}).`,
        ...common,
        error,
      },
    };
  }
  if (probe.modelAvailable === false) {
    return {
      fallback: {
        reason: "model_missing",
        message: `The embedding server at ${settings.host} has no model named "${model.model}".`,
        ...common,
        error: failure,
      },
    };
  }
  return {
    fallback: {
      reason: "query_embedding_failed",
      message: `Embedding the query with ${named} failed: ${failure}`,
      ...common,
      error: failure,
    },
  };
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
