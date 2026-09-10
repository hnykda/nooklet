# ADR 010: Embeddings via Ollama, vectors in sqlite-vec, hybrid search by rank fusion

Date: 2026-09-10. Status: accepted.

## Decision

- Server-only embeddings. Provider interface with an Ollama `/api/embed` implementation (default)
  and an OpenAI-compatible one; the model is a runtime setting, dimensions are discovered from the
  model, and query-side instruction prefixes are applied per model profile.
- Default model bge-m3 (multilingual, 1024 dims, no prefix, fast); qwen3-embedding:8b and any
  other pulled model are selectable. One `vec0` table per model; model switches re-index in the
  background and flip atomically.
- Unit = block with breadcrumb context and flattened descendants (about 300 tokens max); page
  unit = title plus top-level outline. Content-hash keyed, queue-driven, reconciled at startup.
- Vectors live in `sqlite-vec` inside the graph's SQLite file, loaded into `node:sqlite` with
  `allowExtension`. Full-text search is FTS5 (unicode61 with diacritics removed, plus a trigram
  table). Hybrid results come from reciprocal rank fusion (k = 60) in a single SQL statement.
- Pure TypeScript; no Python.

## Why

- Measured locally: sqlite-vec answers KNN over 100k×1024 float32 vectors in about 99 ms and a
  realistic 20k-block hybrid query in 22 ms, in the same file as everything else, so there is no
  second store to keep consistent. Alternatives (LanceDB, usearch, pure JS) only pay off past a
  million vectors.
- bge-m3 embeds about 8× faster than qwen3-embedding:8b on this machine and the user's own
  A/B test on their Czech/English graph preferred it for quality.
- Context-free block embeddings (Logseq 2.0's approach) are the known-weak baseline; every
  well-liked notes-AI tool prepends the breadcrumb.

## Consequences

- Three driver gotchas are documented in `research/06-embeddings.md`: bind integers as BigInt or
  cast for vec0 columns, never partition vec0 by page (chunk pre-allocation exploded to 8 GB),
  and pass `Float32Array.buffer` to `node:sqlite`.
- bge-m3 is capped at 2,048 tokens per input on Ollama; units are sized accordingly.
