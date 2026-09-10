# vrite

A small, local-first outliner in the spirit of Logseq: markdown blocks, `[[page refs]]`, `#tags`,
linked/unlinked references, namespaces, journals, tasks, multi-device sync, a clear HTTP API + MCP
server for LLM agents, built-in embeddings via Ollama, and user plugins on both server and client.

Status: planning + core foundations. See `docs/PLAN.md`.

## Layout

- `packages/core` – data model, Logseq-compatible outline parser/serializer, reference extraction, journal dates.
- `docs/research` – research reports on Logseq internals and competing tools that informed the design.

## Development

```sh
pnpm install
pnpm test        # all packages
pnpm typecheck
pnpm lint
```
