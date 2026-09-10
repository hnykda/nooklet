/** Builds an `EmbeddingProvider` from stored settings or a specific `embedding_model` row. */

import type { SqlDriver } from "@nooklet/core";
// M4/ADR 007's one named exception to "avoid packages/server/src/embeddings/": wiring a plugin's
// `ctx.registerEmbeddingProvider` into this factory, so `embedding.provider = "plugin"` (settings.ts)
// resolves to whatever a plugin registered instead of one of the three built-in HTTP clients below.
import { getEmbeddingProvider } from "../plugins/provider-registries.js";
import { FakeEmbeddingProvider } from "./fake-provider.js";
import type { EmbeddingModelRow } from "./model-registry.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAiCompatProvider } from "./openai-provider.js";
import type { EmbeddingProvider } from "./provider.js";
import { type EmbeddingProviderKind, getEmbeddingSettings } from "./settings.js";

/** Adapts a plugin's `EmbeddingProviderDef` (`@nooklet/plugin-api`: `{id, model, dims, embed(texts,
 * signal)}`) to this module's `EmbeddingProvider` interface (`{id(), dims(): Promise<number>,
 * embed(texts, kind, signal)}`). `kind` (query/document prompt-prefixing, `./provider.ts`) has no
 * equivalent on `EmbeddingProviderDef` — a plugin provider gets no prefix treatment; it owns its
 * own prompting if it needs any. */
function adaptPluginProvider(
  def: import("@nooklet/plugin-api").EmbeddingProviderDef,
): EmbeddingProvider {
  return {
    id: () => `plugin:${def.id}`,
    dims: async () => def.dims,
    embed: (texts, _kind, signal) => def.embed(texts, signal),
  };
}

function buildProvider(
  driver: SqlDriver,
  provider: EmbeddingProviderKind,
  model: string,
  host: string,
): EmbeddingProvider {
  if (provider === "plugin") {
    const plugin = getEmbeddingProvider(driver, model); // `model` holds the plugin provider's id here
    if (!plugin) {
      throw new Error(
        `embedding.provider is "plugin" but no plugin has registered an embedding provider with id "${model}" — is that plugin enabled?`,
      );
    }
    return adaptPluginProvider(plugin);
  }
  if (provider === "openai-compat") return new OpenAiCompatProvider({ baseUrl: host, model });
  if (provider === "fake") return new FakeEmbeddingProvider(8, model);
  return new OllamaProvider({ host, model });
}

/** Provider for the currently *configured* provider+model+host (settings table), used to probe
 * dims before a model has an `embedding_model` row yet (e.g. `embed model <name>`). */
export function buildProviderFromSettings(driver: SqlDriver): EmbeddingProvider {
  const s = getEmbeddingSettings(driver);
  return buildProvider(driver, s.provider, s.model, s.host);
}

/** Provider for an already-registered model row (host still comes from settings; provider+model
 * come from the row itself, so an old and a new model mid-switch each get the right client even
 * if they differ). */
export function buildProviderForModel(
  driver: SqlDriver,
  model: EmbeddingModelRow,
): EmbeddingProvider {
  const s = getEmbeddingSettings(driver);
  return buildProvider(driver, model.provider as EmbeddingProviderKind, model.model, s.host);
}
