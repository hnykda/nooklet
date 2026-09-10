/**
 * `EmbeddingProvider`: the interface both real adapters (`ollama-provider.ts`,
 * `openai-provider.ts`) and the test-only `fake-provider.ts` implement, plus the per-model prompt
 * profiles from `docs/research/06-embeddings.md` §1.2 (query-side instruction prefixes; bge-m3
 * gets none — the research measured that adding one made its results *worse* — qwen3-embedding
 * gets one).
 */

export type EmbedKind = "query" | "document";

export interface EmbeddingProvider {
  /** e.g. "ollama:bge-m3" — informational, not stored as the identity (provider+model columns are). */
  id(): string;
  /** Discover the vector width. Cached by implementations; may hit the network once. */
  dims(): Promise<number>;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface EmbedProfile {
  model: RegExp;
  /** Prepended to query-side texts only. Never applied to documents (research §1.2). */
  queryPrefix?: string;
  docPrefix?: string;
  /** Conservative cap in tokens; chunking (chunker.ts) stays well under this. */
  maxTokens: number;
}

// Table verbatim from research/06-embeddings.md §1.2 (measured A/B: the qwen3 instruction helps
// qwen3 and *hurts* bge-m3 — margins 0.115/0.008/0.261 -> 0.062/0.004/0.107 with the prefix added).
export const EMBED_PROFILES: readonly EmbedProfile[] = [
  { model: /^bge-m3/, maxTokens: 1500 },
  {
    model: /^qwen3-embedding/,
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant notes from a personal knowledge base\nQuery: ",
    maxTokens: 4000,
  },
  {
    model: /^embeddinggemma/,
    queryPrefix: "task: search result | query: ",
    docPrefix: "title: none | text: ",
    maxTokens: 1500,
  },
  {
    model: /^nomic-embed-text/,
    queryPrefix: "search_query: ",
    docPrefix: "search_document: ",
    maxTokens: 1500,
  },
  {
    model: /^mxbai-embed-large/,
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    maxTokens: 400,
  },
  { model: /^snowflake-arctic-embed2/, queryPrefix: "query: ", maxTokens: 1500 },
];

/** Unknown models get no prefix (user-overridable later; not needed for v1). */
export function profileFor(model: string): EmbedProfile {
  return EMBED_PROFILES.find((p) => p.model.test(model)) ?? { model: /(?:)/, maxTokens: 1500 };
}

export function applyPrefix(
  texts: readonly string[],
  kind: EmbedKind,
  profile: EmbedProfile,
): string[] {
  const prefix = kind === "query" ? profile.queryPrefix : profile.docPrefix;
  if (!prefix) return [...texts];
  return texts.map((t) => prefix + t);
}
