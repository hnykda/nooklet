/**
 * Deterministic, network-free `EmbeddingProvider` used by tests (unit tests via
 * `providerFor` injection in `indexer.test.ts`/`semantic-search.test.ts`) and internally by
 * `factory.ts` for `embedding.provider = "fake"`, a settings value only test setup ever writes —
 * never offered by the CLI's `embed model` command to real users. This is the seam that lets
 * `pnpm vitest run` exercise the whole pipeline (chunk -> hash -> embed -> upsert vector -> KNN ->
 * RRF) without Ollama running.
 *
 * Vectors are a seeded PRNG keyed off the input text, then L2-normalized (matching real
 * providers' unit-norm outputs per research/06 §1.1) so identical text always produces the
 * identical vector and cosine distance stays meaningful for KNN/related tests.
 */

import type { EmbeddingProvider, EmbedKind } from "./provider.js";

export class FakeEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly dimsN = 8,
    private readonly modelName = "fake-model",
  ) {}

  id(): string {
    return `fake:${this.modelName}`;
  }

  async dims(): Promise<number> {
    return this.dimsN;
  }

  async embed(texts: string[], _kind: EmbedKind): Promise<Float32Array[]> {
    return texts.map((t) => deterministicUnitVector(t, this.dimsN));
  }
}

function deterministicUnitVector(text: string, dims: number): Float32Array {
  let seed = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed ^ text.charCodeAt(i)) >>> 0;
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const raw: number[] = [];
  for (let i = 0; i < dims; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    raw.push((seed / 0xffffffff) * 2 - 1);
  }
  const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0)) || 1;
  return Float32Array.from(raw.map((x) => x / norm));
}
