/**
 * Embedding config (`embedding.provider` / `embedding.model` / `embedding.host`), stored as rows
 * in the `setting` table per the task's instruction.
 *
 * NOTE on `docs/spec/sql-schema.md` rule 25 / Open issue 1: `setting.set` has no op kind yet, and
 * that spec says implementers must not invent a parallel *user-facing* write path as a stopgap.
 * This module's `putSetting` is a narrow exception scoped to the embeddings subsystem configuring
 * itself (called only from the CLI's `embed model`/`embed status` commands and the model registry,
 * never exposed as an HTTP/MCP op) — the same category of server-internal bookkeeping
 * `embed_dirty`/`embedding_model` already are, not a general settings-write API. Revisit and fold
 * into a real `setting.set` op once that op kind lands.
 */

import type { SqlDriver } from "@nooklet/core";

// "plugin" added for M4/ADR 007: a plugin's `ctx.registerEmbeddingProvider` (see
// `../plugins/provider-registries.ts` and this file's one consumer, `./factory.ts`'s
// `provider === "plugin"` branch). When set, `model` holds the plugin provider's own `id`, not a
// model name.
export type EmbeddingProviderKind = "ollama" | "openai-compat" | "fake" | "plugin";

export interface EmbeddingSettings {
  provider: EmbeddingProviderKind;
  model: string;
  host: string;
}

const DEFAULTS: EmbeddingSettings = {
  provider: "ollama",
  model: "bge-m3",
  host: "http://127.0.0.1:11434",
};

const KEYS = {
  provider: "embedding.provider",
  model: "embedding.model",
  host: "embedding.host",
} as const;

function getSetting(driver: SqlDriver, key: string): string | undefined {
  const row = driver.get<{ value_json: string }>("SELECT value_json FROM setting WHERE key = ?", [
    key,
  ]);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json) as string;
  } catch {
    return undefined;
  }
}

function putSetting(driver: SqlDriver, key: string, value: string): void {
  const now = Date.now();
  driver.run(
    `INSERT INTO setting(key, graph_id, value_json, updated_at, hlc) VALUES (?, 'default', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, hlc = excluded.hlc`,
    [key, JSON.stringify(value), now, new Date(now).toISOString()],
  );
}

export function getEmbeddingSettings(driver: SqlDriver): EmbeddingSettings {
  return {
    provider:
      (getSetting(driver, KEYS.provider) as EmbeddingProviderKind | undefined) ?? DEFAULTS.provider,
    model: getSetting(driver, KEYS.model) ?? DEFAULTS.model,
    host: getSetting(driver, KEYS.host) ?? DEFAULTS.host,
  };
}

export function setEmbeddingSettings(
  driver: SqlDriver,
  patch: Partial<EmbeddingSettings>,
): EmbeddingSettings {
  if (patch.provider !== undefined) putSetting(driver, KEYS.provider, patch.provider);
  if (patch.model !== undefined) putSetting(driver, KEYS.model, patch.model);
  if (patch.host !== undefined) putSetting(driver, KEYS.host, patch.host);
  return getEmbeddingSettings(driver);
}
