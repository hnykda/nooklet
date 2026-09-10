# ADR 014: Stay on Node for the server; Bun is a viable later swap, not a now decision

Date: 2026-09-10. Status: accepted.

## Decision

The server keeps targeting Node (26.x, per ADR 001). Bun was evaluated and rejected *for now*,
not on principle — the `SqlDriver` abstraction in `packages/core` (ADR 001/003) means the runtime
is deliberately not a one-way door.

## Why

Most of the stack would run on Bun today: Hono has first-class Bun support, the MCP TypeScript
SDK v2 explicitly lists Bun as a supported runtime, and TypeScript runs natively without a
transpile step. Bun is also genuinely faster at install, test, and cold start, and collapses
several tools into one binary.

The two places it costs us are exactly the two things this architecture leans on hardest:

1. **sqlite-vec extension loading on macOS** (needed from M3 for embeddings, ADR 010). Bun on
   macOS links Apple's system SQLite, which is built with extension loading *disabled*, so
   `loadExtension()` throws "This build of sqlite3 does not support dynamic extension loading".
   The workaround is real but is a per-machine setup step: `Database.setCustomSQLite(...)` pointed
   at a Homebrew `libsqlite3.dylib`. By contrast, `node:sqlite` ships its own SQLite build, and
   loading `sqlite-vec` through it with `allowExtension: true` was already *verified working on
   this machine* during the embeddings research (`docs/research/06-embeddings.md`).
2. **`worker_threads`**, which the embeddings indexer design uses (a worker with its own WAL
   connection). Bun's Node compatibility layer covers most of `node:*`, but `worker_threads` is
   still documented as partial, with known gaps around CPU-bound parallelism. Node's is boring
   and stable.

Set against that, Bun's headline advantage — raw request throughput — is close to irrelevant
here. This is a single-user, local-first notes server whose work is SQLite queries and occasional
Ollama HTTP calls, not high-QPS serving. We would be trading a verified-working SQLite/extension
path and stable worker threads for speed we do not need.

## Consequences

- No change to the current stack; `packages/server` stays on `node:sqlite` via
  `@vrite/core/node-sqlite`.
- Revisiting is cheap and bounded: `packages/core/src/sync/driver.ts` is a ~30-line interface and
  `node-sqlite-driver.ts` its ~85-line implementation, so a `bun-sqlite-driver.ts` is a small,
  self-contained addition if Bun's macOS SQLite situation improves or the tradeoffs change.
- Bun remains usable *incidentally* by anyone who prefers it for running scripts or tests, as long
  as they do not depend on extension loading; this ADR is about what the project targets and
  tests, not what a contributor may run locally.
- Irrelevant to the web client (M2): that toolchain is Vite, where this decision does not apply.
