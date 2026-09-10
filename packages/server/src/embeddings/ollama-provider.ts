/**
 * Ollama `/api/embed` provider (default, per ADR 010). Shapes verified in
 * `docs/research/06-embeddings.md` §1.1/§1.3: request `{model, input, truncate, keep_alive}`,
 * response `{model, embeddings: number[][]}`; dims discovered via `/api/show`'s
 * `model_info["<arch>.embedding_length"]`, falling back to a one-text probe embed.
 */

import { applyPrefix, type EmbeddingProvider, type EmbedKind, profileFor } from "./provider.js";

export interface OllamaProviderOptions {
  model: string;
  /** Defaults to `OLLAMA_HOST` env, then `http://127.0.0.1:11434` (research/06 §1.1). */
  host?: string;
}

export function defaultOllamaHost(): string {
  return process.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434";
}

export class OllamaProvider implements EmbeddingProvider {
  private readonly host: string;
  private readonly model: string;
  private cachedDims: number | undefined;

  constructor(opts: OllamaProviderOptions) {
    this.host = (opts.host ?? defaultOllamaHost()).replace(/\/+$/, "");
    this.model = opts.model;
  }

  id(): string {
    return `ollama:${this.model}`;
  }

  async dims(): Promise<number> {
    if (this.cachedDims !== undefined) return this.cachedDims;
    const discovered = await this.discoverDimsViaShow();
    if (discovered !== undefined) {
      this.cachedDims = discovered;
      return discovered;
    }
    // Fallback (also what mcp-logseq does, per research/06 §1.1): embed a probe and measure it.
    const [vec] = await this.embed(["probe"], "document");
    this.cachedDims = vec?.length ?? 0;
    return this.cachedDims;
  }

  private async discoverDimsViaShow(): Promise<number | undefined> {
    try {
      const res = await fetch(`${this.host}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model }),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        model_info?: Record<string, unknown>;
      };
      const arch = body.model_info?.["general.architecture"];
      if (typeof arch !== "string") return undefined;
      const val = body.model_info?.[`${arch}.embedding_length`];
      return typeof val === "number" ? val : undefined;
    } catch {
      return undefined;
    }
  }

  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const profile = profileFor(this.model);
    const input = applyPrefix(texts, kind, profile);
    const res = await fetch(`${this.host}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input, truncate: true, keep_alive: "10m" }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`ollama /api/embed ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as { embeddings: number[][] };
    return body.embeddings.map((e) => Float32Array.from(e));
  }
}
