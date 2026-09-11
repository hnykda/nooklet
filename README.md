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
pnpm --filter @nooklet/web build          # the client; the server serves it from its own origin

# Optional: import an existing Logseq graph (the classic markdown file-graph format)
pnpm nooklet import ~/path/to/logseq-graph --data ~/.nooklet

# Mint a token for an agent, then run it
pnpm nooklet token create --label claude-code --scope write --sync --data ~/.nooklet
pnpm nooklet serve --data ~/.nooklet
```

Open <http://127.0.0.1:6100>. The same process serves the app, the HTTP API, the MCP endpoint,
the OpenAPI spec and the sync WebSockets — it prints all of them on startup. `--data` defaults to
`$NOOKLET_DATA`, then `~/.nooklet/default`.

The raw token is shown **once**, at creation. `--scope write` lets an agent edit the graph;
`--sync` lets a device sync; add `--ui-control` to let an agent see and drive a live window.

For hacking on the client, `pnpm --filter @nooklet/web dev` still gives you Vite with HMR against
the same running server.

### Reaching it from another device

`serve` binds to `127.0.0.1`. To reach it from another device, bind wider **and** allowlist the
hostname you will actually type — both are required, since any other `Host` is refused with 403:

```sh
pnpm nooklet serve --data ~/.nooklet --host 0.0.0.0 --allow-host my-mac.tailnet.ts.net
```

> **Use HTTPS or a tailnet, not a plain LAN IP.** `http://192.168.1.5:6100` is not a *secure
> context*, and the client stores its replica in OPFS and coordinates writers with
> `navigator.locks` — both of which browsers gate behind secure contexts. The app will fail to
> open its local database there. `https://`, `localhost`, and Tailscale's `*.ts.net` (which serves
> HTTPS) all qualify. A bearer token over plain HTTP is also readable by anyone on the network
> path.

A remote device has no token until you give it one: open the app, and it will ask. Create the
token with `pnpm nooklet token create --label phone --scope write --sync`.

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

An agent gets 25 tools. The ones that matter most: `graph_overview` to orient, `search`
(keyword, semantic, or hybrid), `page_read`, `page_append` (write nested markdown in one call and
get back stable block ids), `block_update` (replace an exact substring inside one block),
`batch` (atomic multi-step edits), and `batch_undo` (reverse any batch it just made).

## CLI

| Command | What it does |
|---|---|
| `nooklet serve` | The app, HTTP API, MCP endpoint, sync endpoints, asset serving |
| `nooklet import <dir>` | One-shot import of a Logseq file graph |
| `nooklet export` | Write the markdown mirror to the data directory |
| `nooklet mcp --stdio` | MCP over stdio, for Claude Desktop |
| `nooklet token create/list/revoke` | Manage API tokens (`read`, `write`, `admin`) |
| `nooklet embed status/run/model` | Embedding index status, indexing, model switching |
| `nooklet backup` / `restore` | Consistent snapshot of the database plus assets, and its restore |
| `nooklet verify` | Replay the whole op log and diff it against live state |

In this repo, run any of them as `pnpm nooklet <command>`.

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
