type:: reference
summary:: One page on how nooklet is built — packages, the path of one write, the data directory — with the decision records by number.
tags:: reference

- SQLite is the source of truth on the server and in every client. Every write becomes an op in an append-only log with a hybrid logical clock; fields merge last-writer-wins and sibling order uses fractional indexing, so devices reconcile without a lock. The server validates tree structure and emits corrective ops. Markdown files are a lossless export with stable `^id` suffixes — never the sync medium, a greppable copy you can walk away with (`CLAUDE.md`; ADRs 002, 003, 004).
- ## Packages
  - `packages/core` — pure TypeScript that runs in Node and the browser: the data model, 14-character ids, the hybrid logical clock, op types and `applyOps` against a tiny `SqlDriver` interface, the outline parser and serializer, the inline tokenizer, reference extraction, journal dates, page-name rules. Platform-free except for one Node driver, which is what keeps a native port cheap.
  - `packages/server` — Node 26 with `node:sqlite`: the store, `serverApplyOps` (the single write path), sync endpoints (`/sync/push`, `/sync/pull`, `/sync/snapshot`, a WebSocket poke), the `defineOp` registry mounted as HTTP, OpenAPI and MCP, tokens, the Logseq importer, the markdown export, FTS5 and `sqlite-vec` search, the embeddings worker, assets, the plugin host, the live-window channel, and the CLI.
  - `packages/plugin-api` — the public types plugins compile against.
  - `apps/web` — the client: Vite, SolidJS, CodeMirror 6; a SQLite-WASM replica in OPFS inside a worker; the sync client with an outbox; the command registry, palette, slash menu and keymap; the PWA shell. Also what the desktop app displays.
  - `apps/desktop` — a Tauri 2 shell that bundles Node, the server and the client as a sidecar and starts them, or reuses a server already on port 6100 ([[Getting started]]).
  - `plugins/` — built-in plugins that dogfood the plugin API: `daily-summary`, `mermaid`, `word-count`.
  - `e2e/` — Playwright against a real server serving a real production build; the suite that catches integration bugs.
- ## One write, end to end
  - A keystroke settles in the editor → the client turns it into ops and applies them to its local replica and its outbox in one transaction → the sync client pushes → `serverApplyOps` validates, numbers and applies them, rebuilds the derived rows (`ref`, `path_ref`, `page_tag`, `page_alias`, full-text), writes a `changes` row for attribution and undo, marks embedding units dirty, and pokes the other clients → they pull. An agent's `page_append` enters at `serverApplyOps` the same way; so does an import.
  - Derived tables — references, full-text, embeddings — live only on the server and are rebuildable; state tables are rebuildable from the op log, which `nooklet verify` proves by replaying it. The client has no reference index, which is why backlinks, search and the graph view are API calls.
- ## The data directory
  - `graph.sqlite` (WAL mode, with `-wal` and `-shm` beside it), `assets/` (uploaded and imported files, content-addressed), `pages/` and `journals/` (the markdown export, once you run `nooklet export`), `plugins/`, `backups/`. The database and `assets/` are the data; everything else is regenerable. Default `~/.nooklet/default`, or `$NOOKLET_DATA`, or `--data`.
- ## Decision records (`docs/adr/`)
  - 001 Stack and tooling — TypeScript end to end, Node 26, pnpm, Vite, Vitest, Biome; no legacy layers.
  - 002 SQLite is the truth; markdown files are a lossless mirror — never the sync medium. (The continuous, watched mirror it describes is not built; see [[Markdown format]].)
  - 003 Sync = op log + hybrid logical clocks + per-field last-writer-wins; the server validates the tree.
  - 004 Short time-ordered ids (14 characters, Crockford base32) and fractional-index ordering.
  - 005 Client packaging: PWA first, Capacitor for stores, Tauri for desktop.
  - 006 Editor: rendered blocks plus one re-parented CodeMirror 6 surface; one hand-written tokenizer shared by renderer, editor and indexer.
  - 007 Plugins: one package with optional server and client halves, trusted ESM in v1.
  - 008 One operation registry for HTTP, MCP and the typed client.
  - 009 Every operation is a command; keybindings are user data.
  - 010 Embeddings via Ollama, vectors in sqlite-vec, hybrid search by rank fusion.
  - 011 Scheduling, repeats and query blocks use one property/fence syntax, not org-mode.
  - 012 The importer targets the Logseq file graph only.
  - 013 AI parity: undo and asset upload in the MVP; live UI control designed for M2.
  - 014 Stay on Node, not Bun — sqlite-vec extension loading and `worker_threads`.
  - 015 Live UI control: a dedicated `/ui/live` socket, the existing command registry, consent by default-asymmetry.
  - 016 Desktop shell: Tauri, pointed at the local server. (The server is now bundled as a sidecar; the ADR's "v1 does not bundle" paragraph is superseded.)
  - 017 Page-level tags, and how a journal becomes `#Journal`. (The `tagged_pages` group it promises is not built.)
  - 018 Journal pages are stored by ISO date; the title format is a setting.
  - 020 Block/page refactors and graph replace are server ops; a merge rewrites, aliases and deletes.
  - There is no 019 file as of 2026-09-12, although code comments and the references panel cite one.
- The specs in `docs/spec/` — conventions, the markdown grammar, the SQL schema, API and plugin types, MCP tools, commands and keymap — are the implementation-ready detail; `docs/research/` holds the evidence behind the ADRs; `docs/PLAN.md` is the synthesis; `docs/BUGS.md` is what is known to be broken; `docs/OPERATIONS.md` is the runbook.
