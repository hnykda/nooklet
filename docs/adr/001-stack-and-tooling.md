# ADR 001: Stack and tooling

Date: 2026-09-10. Status: accepted.

## Decision

- TypeScript end to end, ESM only, latest stable everything, no backward-compatibility layers:
  Node 26 (built-in `node:sqlite`), TypeScript 7 (native compiler), pnpm 12 workspaces,
  Vite 8, Vitest 5, Biome 2 for lint + format.
- Monorepo layout: `packages/core` (pure model + parsing + sync primitives, runs in Node and the
  browser), `packages/server` (Node: SQLite, sync, HTTP API, MCP, embeddings, plugin host),
  `packages/plugin-api` (public plugin types), `apps/web` (the client; PWA first).
- Python is not required. Ollama serves embedding models over HTTP, so pure TS suffices.

## Why

The user asked for modern tech with no legacy baggage, and a single language keeps one build,
one test runner, and one plugin language (a lesson from SilverBullet, which lost users migrating
between three scripting DSLs). `node:sqlite` removes native-module build pain and ships FTS5.

## Consequences

- Package exports point at TypeScript source; consumers (Vite, tsx, Vitest) transpile. A build step
  is added only when publishing.
- If TypeScript 7 or Biome 2 blocks something, pin down one major, do not fork the setup.
