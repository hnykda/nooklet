/**
 * OpenAI-compatible `/v1/embeddings` provider so LM Studio, llama.cpp server, or OpenAI itself
 * can be swapped in for Ollama (ADR 010, `docs/research/06-embeddings.md` §1.3). Response shape
 * verified against Ollama's own `/v1/embeddings` compat endpoint: `{data: [{embedding, index}]}`.
 */

import { applyPrefix, type EmbeddingProvider, type EmbedKind, profileFor } from "./provider.js";

export interface OpenAiCompatProviderOptions {
  /** e.g. "http://localhost:1234" (LM Studio) or "https://api.openai.com" — no trailing `/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class OpenAiCompatProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private cachedDims: number | undefined;

  constructor(opts: OpenAiCompatProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
  }

  id(): string {
    return `openai-compat:${this.model}`;
  }

  async dims(): Promise<number> {
    if (this.cachedDims !== undefined) return this.cachedDims;
    const [vec] = await this.embed(["probe"], "document");
    this.cachedDims = vec?.length ?? 0;
    return this.cachedDims;
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const profile = profileFor(this.model);
    const input = applyPrefix(texts, kind, profile);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`${this.baseUrl}/v1/embeddings ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return [...body.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => Float32Array.from(d.embedding));
  }
}
