/** Builds an `EmbeddingProvider` from stored settings or a specific `embedding_model` row. */

import type { SqlDriver } from "@nooklet/core";
import { FakeEmbeddingProvider } from "./fake-provider.js";
import type { EmbeddingModelRow } from "./model-registry.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAiCompatProvider } from "./openai-provider.js";
import type { EmbeddingProvider } from "./provider.js";
import { type EmbeddingProviderKind, getEmbeddingSettings } from "./settings.js";

function buildProvider(
  provider: EmbeddingProviderKind,
  model: string,
  host: string,
): EmbeddingProvider {
  if (provider === "openai-compat") return new OpenAiCompatProvider({ baseUrl: host, model });
  if (provider === "fake") return new FakeEmbeddingProvider(8, model);
  return new OllamaProvider({ host, model });
}

/** Provider for the currently *configured* provider+model+host (settings table), used to probe
 * dims before a model has an `embedding_model` row yet (e.g. `embed model <name>`). */
export function buildProviderFromSettings(driver: SqlDriver): EmbeddingProvider {
  const s = getEmbeddingSettings(driver);
  return buildProvider(s.provider, s.model, s.host);
}

/** Provider for an already-registered model row (host still comes from settings; provider+model
 * come from the row itself, so an old and a new model mid-switch each get the right client even
 * if they differ). */
export function buildProviderForModel(
  driver: SqlDriver,
  model: EmbeddingModelRow,
): EmbeddingProvider {
  const s = getEmbeddingSettings(driver);
  return buildProvider(model.provider as EmbeddingProviderKind, model.model, s.host);
}
