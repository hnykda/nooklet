# nooklet

nooklet is a local-first outliner in the spirit of Logseq. You write in nested bullets, link pages
with `[[links]]` and `#tags`, keep a daily journal and track tasks. Every device holds the whole
graph in SQLite and works offline; a self-hosted server syncs them. AI agents are first-class
users: the same operations the app uses are an MCP server and an HTTP API, so Claude Code or Cursor
can search your notes, read pages with stable block ids, and edit one bullet at a time. The server
also writes every page to plain markdown you can grep, commit or open in Logseq and Obsidian.

MIT licensed, self-hosted, no account, no telemetry.

> **Project status**
>
> The basic functionality is there: you can run a sync server, and the clients (the desktop app,
> the browser, and the mobile app, tested on an iPhone) sync with it in both directions. The
> everyday features (editing text, nested bullets, links and tags, journals, tasks, images, search)
> should work. It is of course not bug-free, and not as feature-rich as projects with years of
> development behind them. What it does have is a codebase that is easy to hack on, and a design
> that is extensible from the ground up: one operation registry drives the app, the HTTP API, the
> MCP server and the typed client, and features can ship as plugins. Expect rough edges and
> breaking changes before 1.0. See [Platform support](#platform-support) for what is tested where.

> Screenshot placeholder: the journal view with the shelf open.

## Quick start

You need Node 24+, pnpm 12 and git.

```sh
git clone https://github.com/hnykda/nooklet.git
cd nooklet
pnpm install
pnpm --filter @nooklet/web build
pnpm nooklet serve
```

Open <http://127.0.0.1:6100>. Bring a Logseq file graph with
`pnpm nooklet import /absolute/path/to/graph`.

For several devices, run the server on your Tailscale network with HTTPS and give each device its
own token. [Getting started](docs/guide/getting-started.md) walks through it, plus the macOS desktop
app and the iOS app (both built from source for now).

## Build from source

[Building from source](docs/guide/building.md) covers the toolchain, every build command, the test
layers and CI. [Build and install nooklet on your iPhone](docs/guide/ios-from-source.md) walks through
Xcode, signing with a free Apple ID, and pairing the phone with your server.

## Documentation

- [What nooklet is](docs/guide/what-is-nooklet.md): who it is for, what is different, non-goals
- [Features](docs/guide/features.md): what works today, and what is partial
- [How it works](docs/guide/how-it-works.md): SQLite everywhere, the op log, clocks, the mirror
- [Sync, offline and conflicts](docs/guide/sync-and-offline.md)
- [Getting started](docs/guide/getting-started.md)
- [Self-hosting](docs/guide/self-hosting.md): Tailscale, Docker, Kubernetes, proxies, backups, Ollama
- [Build and install nooklet on your iPhone](docs/guide/ios-from-source.md): Xcode, free signing, pairing, Web Inspector
- [Security model](docs/guide/security.md)
- [For AI agents](docs/guide/agents.md): MCP, the HTTP API, an example
- [Building from source](docs/guide/building.md): toolchain, build commands, tests, CI
- [FAQ and troubleshooting](docs/guide/faq.md)

Design records live in [docs/adr](docs/adr/), specifications in [docs/spec](docs/spec/), and known
bugs in [docs/BUGS.md](docs/BUGS.md).

## Not planned

No flashcards, no kanban boards or whiteboards, no real-time co-editing, no hosted service. The
scope is an outliner, tasks, links, search, sync and an API agents can use.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Repository layout

| Path | Contents |
|---|---|
| `packages/core` | Data model, outline parser and serializer, op log, `applyOps`, queries |
| `packages/server` | SQLite store, sync, HTTP API, MCP server, importer, mirror, embeddings, CLI |
| `packages/plugin-api` | Types plugin authors compile against |
| `apps/web` | The client; also what the desktop and iOS apps show |
| `apps/desktop` | Tauri shell with a bundled server |
| `plugins` | Built-in plugins: mermaid, word-count, daily-summary |
| `deploy` | Container image and an example Kubernetes chart |
| `e2e` | Playwright tests against a real server and a production build |

## License

[MIT](LICENSE)
