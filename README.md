# nooklet

A note-taking app in the tradition of Logseq, Roam and Obsidian: everything is a bullet in an
outline, pages link to each other with `[[wiki links]]` and `#tags`, and those links turn the
whole thing into a graph you can walk backwards through.

Built around four things:

- **Open source and self-hosted.** MIT licensed. Your notes live in a SQLite database and a mirror
  of plain markdown files on your own disk. No account, no cloud, nothing phones home.
- **Simple on purpose.** An outliner, tasks, links, search. No flashcards, no kanban boards, no
  whiteboards.
- **Syncable, if you want it.** One machine and nothing else is a perfectly normal way to run
  nooklet. When you do want more, run the server wherever you like — a laptop, a home server, a
  VPS behind Tailscale — and every device keeps a full local copy that works offline and
  reconciles when it reconnects.
- **AI as a first-class citizen, and entirely optional.** Agents can read and write your graph
  over MCP with real precision, search it semantically, and — if you let them — see and drive the
  window you have open. Every bit of it is off until you switch it on, and nothing degrades if you
  never do.

**Nothing here is mandatory.** Install it, write notes, and that is the whole product: a local
outliner with a markdown mirror on your disk. Sync needs a second device you choose to pair. AI
needs a token you choose to mint. Semantic search needs Ollama you choose to install. Skip all
three and nothing is missing or nagging you to enable it.

> **Status: early.** It works, it is tested, and its author uses it daily. Expect rough edges and
> breaking changes before 1.0. macOS is the supported platform today; Linux builds are
> best-effort and Windows is not built yet.

---

## Install

**macOS** — download the `.dmg` from [Releases](../../releases), or:

```sh
brew install --cask hnykda/tap/nooklet
```

The desktop app is self-contained: it runs its own server, so launching it is all you need.

### Or run it from source

```sh
pnpm install
pnpm --filter @nooklet/web build
pnpm nooklet serve
```

Then open <http://127.0.0.1:6100>. Import an existing Logseq graph with
`pnpm nooklet import ~/path/to/graph --data ~/.nooklet`.

---

## What it does

**Outlining.** Nested bullets, fold and zoom into any block, drag to reorder, indent with Tab. One
block is one thought; `[[links]]`, `#tags` and `((block refs))` connect them. A block reference
renders as the referenced block's own text, not an id.

**Tasks.** Mark a bullet `TODO` and cycle it with `Cmd+Enter` through DOING, DONE and the rest.
Each state has its own glyph, so a list is scannable without reading it. Tasks carry scheduled and
deadline dates as typed properties (see [ADR 011](docs/adr/011-scheduling-and-queries-syntax.md)
for why not org-mode syntax), and every task automatically references a `Task` page — derived from
the marker, never written into your text.

**Linking and references.** Every page shows what links to it, grouped by source page, plus
unlinked mentions. Namespaces (`Projects/Aurora`) nest. `[[` offers date shortcuts and searches
your existing blocks, so linking to a thought you already wrote does not mean remembering where it
was.

**Search.** Full-text through SQLite FTS5, and — optionally — **semantic search in any language**
via local embeddings through [Ollama](https://ollama.com) (default `bge-m3`, which is
multilingual), indexed into `sqlite-vec` and fused with keyword results. Nothing leaves your
machine. Leave it off and search stays keyword-only.

**Sync.** Every client holds a full SQLite replica. Writes become operations in an append-only log
stamped with a hybrid logical clock; fields merge last-writer-wins and sibling order uses
fractional indexing, so devices reconcile without a central lock and offline edits queue until
they can be pushed. `nooklet verify` replays the entire log and diffs it against live state.

**Markdown mirror.** Your notes are also written out as plain markdown, one file per page, with a
stable `^id` on each block so the round trip is lossless. The files are never the sync medium —
they are a greppable, git-able copy you can walk away with at any time.

---

## AI, if you want it

The same operations the app uses are exposed as an HTTP API, an OpenAPI spec, and an **MCP
server** — so Claude Code, Claude Desktop, Cursor or anything else that speaks MCP can work with
your graph properly, rather than pasting whole pages back and forth.

```json
{ "mcpServers": { "nooklet": {
  "type": "http",
  "url": "http://127.0.0.1:6100/mcp",
  "headers": { "Authorization": "Bearer nk_…" }
} } }
```

Mint the token with `nooklet token create --label claude --scope write`. An agent gets tools to
orient itself (`graph_overview`), search (keyword, semantic or hybrid), read and append pages,
**edit an exact substring inside a single bullet**, run atomic multi-step batches, and undo any
batch it just made.

**Agents can also see and drive an open window** — read what you are looking at, run any command
the keyboard can, navigate, highlight a block. This is off by default and gated behind both an
explicit per-window consent toggle and a separate token capability (`--ui-control`); see
[ADR 015](docs/adr/015-live-ui-control-channel.md).

None of it is required. Never create a token and nooklet is an ordinary local notes app.

---

## Security

- The server binds to `127.0.0.1` by default. Reaching it from another device needs both `--host`
  and an explicit `--allow-host` allowlist.
- A token is issued automatically only to a browser on the same machine, decided by the
  connection's peer address rather than a forgeable header. Every other device must be given one
  deliberately.
- Tokens are stored hashed, carry a scope (`read`/`write`/`admin`) plus separate `sync` and
  `ui-control` capabilities, and can be revoked.
- There is no TLS: put it behind a reverse proxy or a tailnet if it leaves your machine. A plain
  LAN IP is also not a browser *secure context*, so the client cannot open its local database
  there — use HTTPS or Tailscale.

Found a security problem? Please report it privately through
[GitHub security advisories](../../security/advisories/new) rather than a public issue.

---

## Contributing

Feature requests and bugs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Feature requests
are prioritised partly by 👍 reactions, so
[vote on the ones you want](../../issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement+sort%3Areactions-%2B1-desc).

```sh
pnpm test        # unit and component tests
pnpm e2e         # real Chromium against a real server — the suite that catches integration bugs
pnpm typecheck
pnpm lint
```

`docs/` holds the reasoning: [`PLAN.md`](docs/PLAN.md) for scope, [`adr/`](docs/adr/) for
decisions and what they cost, [`spec/`](docs/spec/) for implementation-ready detail,
[`research/`](docs/research/) for the findings behind them, and [`BUGS.md`](docs/BUGS.md) for what
is known to be broken.

## Layout

| Path | Contents |
|---|---|
| `packages/core` | Data model, outline parser/serializer, inline tokenizer, refs, op log, `applyOps` |
| `packages/server` | SQLite store, sync, HTTP API, MCP server, importer, mirror, embeddings, CLI |
| `packages/plugin-api` | Public types plugin authors compile against |
| `apps/web` | The web client — also what the desktop app displays |
| `apps/desktop` | Tauri shell that runs its own server ([ADR 016](docs/adr/016-desktop-shell-tauri.md)) |
| `e2e` | Playwright tests against a real server |

## License

[MIT](LICENSE).
