/**
 * `ServerPluginContext.registerEmbeddingProvider`/`registerSearchProvider`: small in-memory
 * registries, keyed by `SqlDriver` (not `ServerContext` — `../embeddings/factory.ts`'s functions
 * already take a bare `driver`, so keying the same way lets the ONE wiring point below (see
 * `../embeddings/factory.ts`'s `provider === "plugin"` branch) stay a one-line lookup instead of
 * threading a whole `ServerContext` through the embeddings module).
 *
 * `registerSearchProvider` has no consumer wired up yet — the task names only the EMBEDDING
 * provider registry as the one thing in `../embeddings/` this plugin host is allowed to touch, and
 * `ops/search.ts`'s query flow is out of scope here. This registry still exists (so the context
 * method is real, returns a working `Disposable`, and is testable) — wiring a plugin search
 * provider into `search`/`related.find`'s actual ranking is a follow-up.
 */
import type { SqlDriver } from "@nooklet/core";
import type { EmbeddingProviderDef, SearchProviderDef } from "@nooklet/plugin-api";

const embeddingProviders = new WeakMap<SqlDriver, Map<string, EmbeddingProviderDef>>();
const searchProviders = new WeakMap<SqlDriver, Map<string, SearchProviderDef>>();

function mapFor<T>(store: WeakMap<SqlDriver, Map<string, T>>, driver: SqlDriver): Map<string, T> {
  const m = store.get(driver) ?? new Map<string, T>();
  store.set(driver, m);
  return m;
}

export function registerEmbeddingProvider(
  driver: SqlDriver,
  def: EmbeddingProviderDef,
): () => void {
  const m = mapFor(embeddingProviders, driver);
  if (m.has(def.id)) throw new Error(`embedding provider "${def.id}" is already registered`);
  m.set(def.id, def);
  return () => m.delete(def.id);
}

/** Read by `../embeddings/factory.ts` when `embedding.provider` setting is `"plugin"` (the
 * `embedding.model` setting then holds the plugin provider's own `id`). */
export function getEmbeddingProvider(
  driver: SqlDriver,
  id: string,
): EmbeddingProviderDef | undefined {
  return embeddingProviders.get(driver)?.get(id);
}

export function listEmbeddingProviders(driver: SqlDriver): EmbeddingProviderDef[] {
  return [...(embeddingProviders.get(driver)?.values() ?? [])];
}

export function registerSearchProvider(driver: SqlDriver, def: SearchProviderDef): () => void {
  const m = mapFor(searchProviders, driver);
  if (m.has(def.id)) throw new Error(`search provider "${def.id}" is already registered`);
  m.set(def.id, def);
  return () => m.delete(def.id);
}

export function listSearchProviders(driver: SqlDriver): SearchProviderDef[] {
  return [...(searchProviders.get(driver)?.values() ?? [])];
}
