# nooklet

A small, local-first outliner in the spirit of Logseq: markdown blocks in nested bullets,
`[[page refs]]` and `#tags`, linked and unlinked references, namespaces, a journal stream, tasks
with scheduling, and multi-device sync.

It is built so that **AI agents are first-class users, not an afterthought**. The same operations
the app uses are exposed as an HTTP API and an MCP server, so Claude Code, Claude Desktop, Cursor,
or anything else that speaks MCP can read and write your graph precisely — including surgical
edits inside a single bullet, not just whole-page replacement.

## Quick start

```sh
pnpm install

# Import an existing Logseq graph (the classic markdown file-graph format)
pnpm --filter @nooklet/server exec tsx src/cli.ts import ~/path/to/logseq-graph --data ~/.nooklet

# Mint a token for an agent, then run the server
pnpm --filter @nooklet/server exec tsx src/cli.ts token create --label claude-code --scope write --data ~/.nooklet
pnpm --filter @nooklet/server exec tsx src/cli.ts serve --data ~/.nooklet
```

That prints the HTTP API, MCP endpoint, and OpenAPI spec URLs. `--data` defaults to
`$NOOKLET_DATA`, then `~/.nooklet/default`.

## Connecting an agent

For Claude Code or Cursor, point them at the MCP endpoint with the token you minted:

```json
{ "mcpServers": { "nooklet": {
  "type": "http",
  "url": "http://127.0.0.1:6100/mcp",
  "headers": { "Authorization": "Bearer <your-token>" }
} } }
```

Claude Desktop connects over stdio instead:

```sh
nooklet mcp --stdio --token <your-token> --data ~/.nooklet
```

An agent gets 18 tools. The ones that matter most: `graph_overview` to orient, `search`
(keyword, semantic, or hybrid), `page_read`, `page_append` (write nested markdown in one call and
get back stable block ids), `block_update` (replace an exact substring inside one block),
`batch` (atomic multi-step edits), and `batch_undo` (reverse any batch it just made).

## CLI

| Command | What it does |
|---|---|
| `nooklet serve` | HTTP API, MCP endpoint, sync endpoints, asset serving |
| `nooklet import <dir>` | One-shot import of a Logseq file graph |
| `nooklet export` | Write the markdown mirror to the data directory |
| `nooklet mcp --stdio` | MCP over stdio, for Claude Desktop |
| `nooklet token create/list/revoke` | Manage API tokens (`read`, `write`, `admin`) |
| `nooklet embed status/run/model` | Embedding index status, indexing, model switching |

## How it works

SQLite is the source of truth, on the server and in every client. Every write anywhere becomes an
op in an append-only log with a hybrid logical clock, and each field merges last-writer-wins, so
devices reconcile without a central lock. The server validates tree structure and issues
corrective ops when two devices move blocks into a cycle.

Your notes are also mirrored to plain markdown files that Logseq and Obsidian can open, with a
stable `^id` on each block so the round trip is lossless. Files are never the sync medium — they
are a transparent, greppable, git-able copy you can walk away with.

Embeddings run locally through Ollama (default `bge-m3`), indexed incrementally into `sqlite-vec`
alongside SQLite's own full-text search, and fused for hybrid results.

## Layout

| Path | Contents |
|---|---|
| `packages/core` | Data model, outline parser/serializer, inline tokenizer, refs, op log, `applyOps` |
| `packages/server` | SQLite store, sync, HTTP API, MCP server, importer, mirror, embeddings, CLI |
| `packages/plugin-api` | Public types plugin authors compile against |
| `apps/web` | The web client (PWA) |
| `docs/PLAN.md` | The plan: scope, architecture, milestones |
| `docs/adr/` | Architecture decisions, one per file, with the reasoning |
| `docs/spec/` | Implementation-ready specs (grammar, schema, API types, MCP tools, keymap) |
| `docs/research/` | The research reports the design came from (written under the project's old name) |

## Development

```sh
pnpm test        # all packages
pnpm typecheck
pnpm lint
```
