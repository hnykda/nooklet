# nooklet — plan and design

Date: 2026-09-10 (status updated 2026-09-11). Status: all milestones implemented. Decisions are recorded in `adr/`; the reasoning behind
them is in `research/` (eight reports, ~350 KB, produced by parallel research agents on this
date). This document is the readable synthesis: what we build, how, and in what order.

## 1. What nooklet is

A small, local-first outliner in the spirit of Logseq for one person with several devices:
markdown blocks in nested bullets, `[[page refs]]` and `#tags`, linked and unlinked references,
namespaces (`A/B/C`), a journal stream, tasks, properties on pages and blocks, fast search, and
reliable multi-device sync. It is built from day one for LLM agents: one clear HTTP API, exposed
as an MCP server, with a token-efficient markdown serialization. Embeddings via any Ollama model
give semantic search and "related" suggestions. Users extend both the server and the client with
TypeScript plugins.

Principles (each one is a lesson from a competitor's failure, see `research/02-competitors.md`):

1. **The home server holds the truth and the indexes; every client holds a replica.**
   Devices work fully offline and reconcile through a small op log. Nothing bypasses that log.
2. **Markdown stays transparent.** The graph is mirrored to plain markdown files that Logseq and
   Obsidian can open, and imported from them losslessly, but files are never the sync medium.
3. **Small scope, steady releases.** No flashcards, whiteboards, boards, or
   real-time co-editing. Every feature must serve outliner + refs + sync + API/MCP + embeddings
   + plugins.
4. **Every operation is a named command** with an id, a description, a default keybinding, and a
   place in the command palette and the slash menu. Plugins add commands the same way.
5. **One language, one runtime model, latest tooling.** TypeScript end to end, no legacy layers.
6. **Import faithfully, but do not clone Logseq.** Where another tool got something more right,
   or where a simpler design serves the same need, we take the simpler design.

## 2. Scope

### v1 features

| Area | What ships |
|---|---|
| Outliner | Nested bullets, one markdown block per bullet, Enter/Tab/Shift-Tab/Alt-Up-Down semantics, collapse, zoom into block, multi-select, drag by bullet, numbered blocks, headings inside blocks, code fences (syntax highlighting is an open seam — research/13 §4.2), tables and images as block content |
| References | `[[page]]`, `#tag`, `#[[multi word]]`, `((block))`, `{{embed}}` of page or block, aliases; linked references grouped by page and unlinked references per page |
| Namespaces | `A/B/C` page names; hierarchy view on the namespace page; short-form display; create with implied parents |
| Journals | A stream: today is always open at the top, older non-empty days below; a calendar to open any day; empty days do not exist as pages |
| Tasks | Turn a block into a task; cycle status with a shortcut or by clicking the checkbox; `TODO DOING DONE WAITING CANCELED`; priorities; `scheduled::` and `deadline::` dates with optional time and repeater; a "Scheduled and deadline" section on each journal day; a Tasks view with filters |
| Properties | Typed properties (text, number, date, checkbox, page, url, list) on blocks and on pages; a properties panel; tag pages can declare a property template |
| Search | Fuzzy page switcher (accent-insensitive), full-text search with snippets, semantic and hybrid search, "related pages/blocks" |
| Commands | Command palette for every operation, `/` slash menu while typing, user-customizable keybindings (JSON), plugins contribute commands |
| Sync | Self-hosted Node server; op-log sync with offline queue on every client; device pairing by link/QR |
| API and MCP | One operation registry that mounts as HTTP endpoints (with OpenAPI), MCP tools (Streamable HTTP + a stdio bridge), and a typed client; scoped tokens; audit trail of agent writes |
| Embeddings | Any Ollama embedding model (bge-m3 default: multilingual, covers Czech); server-side index kept fresh incrementally; model switch re-indexes |
| Plugins | One package format with an optional server half and client half; commands, slash commands, hooks, block renderers, panels, routes, MCP tools, providers |
| Import/export | Import from Logseq file graphs, the classic markdown-native format (ADR 012; all name encodings); continuous markdown mirror export; one-shot export |
| Mobile | Installable PWA that behaves natively (keyboard toolbar, gestures, quick capture); Capacitor shell for app stores in v1.x |
| Media | Images and files pasted/uploaded/captured on mobile are stored by the server under `assets/` and referenced as normal markdown images |

### Explicit non-goals (v1)

Flashcards, whiteboards, kanban boards, real-time cursors/co-editing (research/15 §8 ranks what a first step would be — presence over the existing live channel, then read-only share links — if and when wanted; neither is scheduled), multi-user
permissions (one user, many devices; the design leaves room for graph membership later),
end-to-end encryption (transport TLS + tokens; E2EE would block server-side embeddings and
MCP), PDF annotation, Logseq's `{{query}}`/Datalog blocks, org-mode, LOGBOOK/time tracking
(superseded by the op log, ADR 011), templates (later as a plugin or slash command). A single
query-fence syntax (```` ```query ````, one filter language shared with search and the Tasks
view, ADR 011) is specified but not shipped in v1. Logseq's org-style `SCHEDULED: <...>` lines are
an import target only; the feature itself (scheduled and deadline dates with repeaters) is in core.

### What the user's own graph told us

Two real data sources were analyzed (page names and aggregate statistics only, no content):
the Logseq file graph (952 files, 17.5k blocks) and the Logseq DB markdown mirror (1,202 files,
18.4k blocks). Findings that shaped the scope:

- Journals are the primary capture surface (840 journal files since 2022). Quick capture to
  today's journal is the number one mobile use case.
- Tasks are used heavily (about 700 task blocks, mostly DONE with the NOW/LATER workflow in the
  file graph, mapped to TODO/DOING in the DB version). Checkbox cycling is core.
- Person pages use an `@name` convention; Czech and English names with diacritics are common,
  so search must be accent-insensitive and file names must survive Unicode.
- Numbered lists (700+ lines), headings inside blocks, images (300 lines), links (2,200 lines),
  tables and code fences all occur. Block refs and embeds are rare but present. PDF highlight
  properties (`hl-*`), tweet/video macros, and query blocks are rare and become plugin territory.
- One page file is 1.7 MB. Large pages must render and sync without loading everything.
- Namespaces are barely used in the data, but the user asked for them explicitly.

## 3. Architecture

```
 ┌────────────────────────── devices ──────────────────────────┐
 │  PWA (phone)        PWA/desktop browser       Capacitor app │
 │  Solid UI + CM6     Solid UI + CM6            same build    │
 │  SQLite WASM/OPFS   SQLite WASM/OPFS          native SQLite │
 │  replica + outbox   replica + outbox          replica       │
 └────────┬───────────────────┬───────────────────────┬────────┘
          │ push/pull ops, WS poke, assets, search      │
 ┌────────▼───────────────────▼───────────────────────▼────────┐
 │                      nooklet server (Node 26)                 │
 │  SQLite: op log, state, refs, FTS5, embeddings, assets      │
 │  applyOps (single write path)  ← HTTP API ← MCP ← plugins   │
 │  importer / markdown mirror ↔ $DATA/pages/*.md, journals/   │
 │  embeddings worker → Ollama (/api/embed)                    │
 │  plugin host (server halves) · serves client plugin halves  │
 └─────────────────────────────────────────────────────────────┘
        ▲ HTTP+bearer            ▲ MCP (Streamable HTTP / stdio bridge)
   scripts, curl, other apps   Claude Code, Claude Desktop, Cursor, agents
```

Packages (pnpm workspace):

- `packages/core` — pure TypeScript, runs everywhere: data model, ids, HLC, op types,
  `applyOps` against a tiny SQL driver interface, outline parser/serializer, inline markdown
  tokenizer, reference extraction, journal dates, page-name rules. Exists today (46 tests).
- `packages/server` — Node: `node:sqlite` store, sync endpoints, operation registry, HTTP API,
  OpenAPI, MCP server, importer/mirror, embeddings worker, assets, auth tokens, plugin host, CLI
  (`nooklet serve`, `nooklet import`, `nooklet export`, `nooklet mcp --stdio`, `nooklet token`).
- `packages/plugin-api` — the public types plugins compile against (`nooklet.d.ts` in spirit).
- `apps/web` — the client (Vite + SolidJS + CodeMirror 6), PWA, later wrapped by Capacitor.
- `plugins/*` — built-in plugins that dogfood the plugin API (Ollama provider, mermaid,
  tweet/video embeds, Logseq importer).

## 4. Data model

```
Page  { id, name, key, journalDay | null, properties, createdAt, updatedAt, deletedAt }
Block { id, pageId, parentId | null, order, content, marker, priority, collapsed,
        properties, createdAt, updatedAt, deletedAt }
```

- `content` is the block's markdown text without bullet, marker, priority, or property lines.
  It may span lines and contain fences, tables, images, headings, numbered items.
- `marker` is the task state; `priority` A/B/C is parsed for compatibility but has no UI focus.
- `properties` are `key -> string` on both pages and blocks. Types come from property
  definitions (section 8); values stay strings on the wire so sync stays trivial.
- `order` is a fractional index among siblings (ADR 004). No linked lists.
- References are derived from content and property values, never stored as truth:
  `ref(srcBlock, dstPage | dstBlock, kind: page | tag | block | embed)`, plus `path_refs`
  (own refs plus ancestors' refs plus the page) to compute linked references the way Logseq
  does, and aliases expand both directions.
- Linked references of page P = blocks whose path refs include P (or an alias), excluding P's own
  blocks, grouped by page, most recent page first. Unlinked references = full-text hits for the
  page name (and aliases) in blocks that do not already reference P.
- Namespaces: the name holds the path; ancestors are implied. `[[C]]` typed inside namespace
  `A/B` resolves by shortest unambiguous suffix, like Foam and SilverBullet.
- A page exists once anything references it (ADR 024): links, tags, property values and the Task
  tag make the server create the page and its namespace ancestors; an empty page it made goes
  again with its last reference. Journal days are not created from date links.
- Page identity is the lowercased, NFC-normalized name. Journal pages carry `journalDay`
  (YYYYMMDD); their display title is formatted by a user setting, and references written in
  many date formats resolve to the same day.
- Ids are short, time-ordered strings (ADR 004, revised): 14 characters of Crockford base32,
  45 bits of milliseconds plus 25 random bits. Logseq UUIDs are mapped on import and block refs
  rewritten.

## 5. Storage and files (ADR 002)

SQLite is the truth on every node. Server-only tables hold embeddings, assets metadata, tokens,
devices, the change audit, and the mirror bookkeeping. Derived tables (`ref`, `path_ref`,
`block_fts`) are rebuilt from content and are never synced.

Markdown mirror (server side, opt-in, on by default for a fresh install):

```
$DATA/
  nooklet.sqlite
  pages/<Page Name>.md          # our clean outline format, Logseq/Obsidian readable
  journals/2026_09_10.md
  assets/<id>.<ext>
  plugins/<id>/...
```

Our outline format: page properties as `key:: value` lines at the top; one `- ` bullet per
block; two-space indentation; continuation lines indented to the content column; block property
lines after the first line; the block id appended to the first line as ` ^id` (Obsidian's block
id syntax; if the first line opens a code fence, the id sits alone on the first line and the
fence starts on the next). Every block carries its id, so a file edit *could* become a per-block
diff rather than a page replace — but that direction is not built (as of 2026-09-13): nothing
watches `pages/`, and the `chokidar` dependency nobody imported is gone. The mirror is DB → files
only; edits go through the app or the API. A watcher with content-hash echo suppression is the
design if it is ever wanted; it is not a milestone.

Import targets the Logseq file graph specifically (ADR 012), not the newer Logseq DB version's
one-way markdown export: tabs or spaces, `id::`/`collapsed::`, pre-block page properties, YAML
front matter, triple-lowbar and legacy file names, `title::` override, journals by file name,
`config.edn`, `NOW`/`LATER` kept as markers of their own (they are the owner's workflow, see
§Usage above — not mapped to `TODO`/`DOING`), numbered blocks, dangling block refs repaired,
duplicate ids repaired. The parser is generically liberal enough that it also happens to round-trip
the DB mirror's export format losslessly, but the importer's directory/config handling, tests, and
maintenance commitment are scoped to the file graph only.

## 6. Sync (ADR 003)

Op log with hybrid logical clocks, per-field last-writer-wins, fractional-index ordering, the
server as the single validator of tree structure with corrective ops, `push/pull/snapshot`
endpoints plus a WebSocket poke, and a `rebuild()` that replays the log to prove the state
tables are a pure function of it. Every client keeps pending ops in the same transaction as its
local state change. Assets are not in the op log: the server stores them, clients fetch on view
and cache. v1.1 adds a 3-way text merge for the rare same-block collision; per-block text CRDTs
remain a documented, migration-free upgrade path if live co-editing is ever wanted.

## 7. Editor (ADR 006)

- Every block renders as HTML from our own inline tokenizer (offset-annotated tokens shared by
  the renderer, the editor's live-preview decorations, and the server's reference indexer;
  measured at about 0.6 µs per block versus 30 µs for micromark).
- Exactly one editing surface exists: a single CodeMirror 6 `EditorView` that is re-parented
  into the active block. The block's markdown string is the only source of truth. This is the
  Logseq/Roam single-textarea architecture with Obsidian's editor engine, which has shipped on
  iOS and Android since 2021.
- Keyboard contract (desktop and hardware keyboards): Enter splits at the cursor; new block is
  a sibling unless the block has expanded children, then first child; Shift+Enter inserts a
  newline; Tab/Shift+Tab indent/outdent with logical outdenting; Backspace at start merges into
  the previous visible block; Up/Down at the first/last line move between blocks preserving
  column; Alt+Up/Down move the block; Cmd/Ctrl+Up/Down collapse/expand; Esc selects the block,
  then Shift+Up/Down extend the selection; Cmd/Ctrl+Enter cycles task state; Cmd/Ctrl+. zooms
  in; Cmd/Ctrl+K opens the palette. All of these are commands with rebindable keys.
- Autocomplete popups for `[[`, `#`, `((`, and `/` come from one source interface. The slash
  menu lists editor-context commands (task states, date, heading, code block, embed, template
  plugin entries) and inserts.
- Undo/redo is a document-level history of inverse ops with 500 ms text coalescing, so undo is
  sync-safe and crosses blocks.
- Long pages: `content-visibility: auto` plus lazy mounting first; virtualization over the
  flattened row list only if a 1.7 MB page proves it necessary.
- Paste of multi-line markdown creates blocks; paste of an image uploads an asset.

## 8. Properties, tasks, journals, namespaces

Properties:
- A property definition is a page of kind `property` with `type::` (text, number, date,
  checkbox, page, url, list). Definitions sync like any page. Unknown keys default to text.
- Blocks and pages both carry properties; the page header shows a properties panel; the block
  editor shows properties as chips under the block with an inline editor per type.
- A tag page (kind `tag`) may declare `template::` listing property keys; tagging a block or page
  offers those properties. This covers most of what Tana calls supertags with Logseq syntax.
- Special keys: `alias::` (list of pages), `tags::` (list), `scheduled::`/`deadline::` (date with optional time and repeater),
  `collapsed`, `marker`, `priority`, `list:: number` are stored in dedicated columns.

Tasks:
- A block becomes a task via the slash menu, the palette, the shortcut, or by typing a marker
  word at the start. Cycling order: none → TODO → DOING → DONE → none; WAITING and CANCELED are
  reachable from the menu. Clicking the checkbox toggles DONE.
- Scheduled and deadline (kept from Logseq, see https://docs.logseq.com/#/page/tasks): any block
  can carry `scheduled::` and `deadline::` typed date values (`2026-09-12`, optional time) and a
  `repeat::` value (ADR 011: `1w` shifting from the date, or `1w from done` shifting from
  completion — no org repeater dialects). Slash commands `/scheduled` and `/deadline` open a date
  picker; the journal page for a day shows a "Scheduled and deadline" section listing open
  tasks and dated non-task blocks scheduled for or due on that day, plus — on today — overdue
  tasks (built 2026-09-13: `apps/web/src/views/JournalAgenda.tsx`; read-only, grouped by page,
  hidden when empty). A block without a marker is listed on its exact day only, never as overdue:
  it can never be completed. Past the first ten, overdue tasks wait behind "Show all N overdue"
  (owner, 2026-09-13, reversing the earlier tasks-only and no-cap calls); the Tasks view sorts by
  these dates.
  Marking a repeating task DONE advances the date, resets the marker, and stamps `done::` with
  the completion time. Logseq's `SCHEDULED: <2026-09-12 Sat .+1w>` / `DEADLINE:` lines and
  `:LOGBOOK:` drawers are parsed on import into these properties and the sync op log
  respectively; the mirror never writes org syntax back.
- The Tasks view lists open tasks grouped by page with filters (state, tag, scheduled/deadline
  window, page/namespace) and the same list is available as an API/MCP query.

Journals:
- The Journals view is a stream: today's page is always shown at the top (virtual until the
  first block is written), followed by earlier non-empty days with infinite scroll.
- A calendar opens any day as a virtual page. A journal page is created only when it gets a
  block; an emptied journal page is removed by a server job. Lists, search, and the API never
  show empty days.
- Journal titles are display-only; the day is the identity. The page is *stored* under its ISO
  name (`2026-09-07`) and the title on screen is a user setting; references in any recognized date
  format resolve to the same day, and to the same reference key. ADR 018.

Namespaces:
- `A/B/C` is stored as the name. The page shows its children as a tree, the breadcrumb shows the
  path, and lists display the short form with the namespace dimmed. Creating `A/B/C` implies
  `A` and `A/B` for navigation without materializing them until they get content.

## 9. Search

- Page switcher: fuzzy match over names and aliases with diacritics folded (`č` matches `c`).
- Full-text: SQLite FTS5 with a unicode61 tokenizer that removes diacritics, prefix queries,
  snippets with block ids, filters by tag/page/namespace/date/marker.
- Semantic: KNN over block embeddings; hybrid = reciprocal rank fusion of FTS and KNN.
- Related: KNN over page vectors (mean of block vectors) excluding self, shown in the sidebar.
- Unlinked reference suggestions reuse full-text search.

## 10. Embeddings (ADR 010)

- Provider interface `embed(texts, kind: query | document) -> vectors` with an Ollama
  implementation over `/api/embed` (batches of 64, dimensions read from `/api/show`, per-model
  query-side instruction prefixes for models that expect them such as qwen3-embedding, none for
  bge-m3) and an OpenAI-compatible implementation so LM Studio, llama.cpp, or hosted APIs can be
  swapped in. Any model the user has in Ollama can be chosen at runtime.
- Default model bge-m3: multilingual (Czech and English), 1024 dims, about 65 short documents
  per second on this machine versus 8 for qwen3-embedding:8b, and it needs no query prefix. It
  is hard-capped at 2,048 tokens per input on Ollama, so units stay well under that.
- Unit of embedding: a block with its breadcrumb (`Page › ancestor › …`) plus its text and
  flattened descendants up to about 300 tokens; page units are the title plus top-level outline.
  This is where Smart Connections, Obsidian Copilot, Khoj, and the user's own Logseq MCP server
  converged; Logseq 2.0's context-free block embedding is the known-weak baseline.
- Incremental: `applyOps` marks changed units; a worker with its own SQLite connection drains a
  database-backed queue (3 s per-page debounce), skips unchanged content hashes, deletes vectors
  of deleted blocks, and reconciles on startup. Switching models builds a second index in the
  background and flips when complete.
- Storage: `sqlite-vec` `vec0` tables in the same SQLite file (float32, cosine), one table per
  model. Measured on this machine: a 20k-block graph is about 85 MB with hybrid queries in 22 ms;
  100k×1024 is 415 MB with KNN in 99 ms (int8 or binary quantization available if ever needed).
  Embeddings never sync to devices; semantic search is an API/MCP call.
- Hybrid search: FTS5 (unicode61 with diacritics removed, plus a trigram twin for substring
  matches) fused with KNN by reciprocal rank fusion in one SQL statement. Related pages/blocks
  use the stored vector of the current item, self excluded. No reranker in v1.
- No built-in chatbot: LLM features arrive through MCP tools (search, related, read, write).

## 11. HTTP API and MCP (ADR 008)

- One process, Hono 4: the web client, `/api/v1/*`, `/mcp`, `/openapi.json`, `/sync/*`,
  `/assets/*`. Schemas in Zod 4 with generated JSON Schema.
- One `defineOp` registry: name, summary, description, input/output schemas, annotations
  (read-only, destructive, idempotent), scopes, exposure flags, an LLM-friendly text renderer,
  and the handler. One loop mounts HTTP, one registers MCP tools (MCP SDK v2, spec 2026-07-28,
  stateless Streamable HTTP with bearer auth), one derives the typed client. Plugins register ops
  the same way and default to HTTP-only exposure.
- v1 MCP tools (18, few and well-described, most read tools always loaded): `graph_overview`,
  `page_list`, `page_read`, `block_read`, `search`, `page_backlinks`, `changes_since`,
  `page_create`, `page_append`, `block_insert`, `block_update`, `block_move`, `block_delete`,
  `page_update`, `batch`, `batch_undo`, `asset_upload` (plus `page_delete` requiring user
  interaction). Writes accept markdown and return the created outline with ids; `block_update`
  supports `old_str/new_str` edits and `if_version`; `batch` is atomic with `dry_run`.
  `batch_undo` and `asset_upload` are MVP, not deferred (ADR 013): an agent needs the same
  ability to attach media and cleanly reverse its own mistakes that a human has in the editor.
- Serialization for agents is the same outline format as the mirror (` ^id` suffixes), with
  `ids: none` and depth/size limits for cheap read-only passes and a JSON tree on request.
- Safety: scoped tokens (`read` default, `write`, `admin`) with labels that become the audit
  actor; soft delete to trash; idempotency keys; rate limits; a `changes` table written in the
  same transaction as the ops, powering `changes_since`, UI badges ("changed by agent X"), and
  `batch_undo` (reverses one batch_id's before/after state; itself a new, separately-audited
  batch — undoing an undo is just calling it again on the new batch).
- **AI parity with the live UI (ADR 013, M2 design)**: beyond the headless data API above,
  a running client instance should be observably and controllably by an agent while a human is
  looking at it, not just the underlying graph data — "what page/block is currently focused,
  what's selected" and "run this command" (reusing the ADR 009 command registry), over the
  same live connection the sync protocol already keeps open between server and client. This
  is a distinct, forward-looking capability (most competitors' AI integrations are headless);
  see ADR 015 (decision) and `docs/research/09-live-ui-control.md` (survey) for the design.
- Clients: Claude Code and Cursor connect to the local HTTP endpoint with a bearer token; Claude
  Desktop uses the `nooklet mcp --stdio` bridge.

## 12. Commands, keybindings, palette, slash menu

- A command is `{ id, title, description, category, when, defaultKeys, run }`. Core registers
  every operation (navigation, editing, tasks, properties, search, sync, settings).
- Keybindings are user-editable JSON (`keybindings.json`, synced as a setting): `{ key,
  command, when }`, with a settings UI that lists all commands, shows conflicts, and records
  chords. Mobile shows the same commands in the keyboard toolbar and long-press menus.
- The palette (Cmd/Ctrl+K) searches commands and pages; the slash menu shows commands whose
  `when` includes the editor context, plus inserts (today's date, page ref, task states, headings,
  code block, embed, image, table, property).
- Plugins contribute commands, slash items, and default keybindings declaratively in their
  manifest so the palette can show them before the plugin code loads.

## 13. Plugins (ADR 007)

- A plugin is a directory (or a single `*.plugin.ts`) with a `nooklet` manifest: id, API version,
  optional `server` and `client` entries, JSON-schema settings (host renders the UI, values
  synced), declared permissions, and declared contributions.
- Server half: change events with origin (user/api/mcp/sync/plugin/import), one `beforeWrite`
  transform-or-veto hook, commands (optionally auto-exposed as MCP tools), RPC functions the
  client half can call, HTTP routes under `/api/plugins/<id>/`, MCP tools and resources,
  scheduled jobs, importers/exporters, embedding and search providers, a per-plugin KV store.
- Client half: commands and keybindings, slash items, code-block and `{{macro}}` renderers,
  sidebar panels, block/page menu items, toolbar and status items, themes via CSS variables, an
  editor API, notifications and dialogs, settings. Plugins receive `HTMLElement`s in named,
  host-owned slots; no UI framework is part of the public API.
- v1 runtime: trusted ES modules loaded with `import()` on both sides (the trust boundary is
  the plugins directory, like Obsidian, Home Assistant, Vite). The API is async, JSON-only, and
  handle-based so that a `worker_thread` host (v1.x) and a Web Worker + sandboxed-iframe host for
  untrusted client plugins (v2) can be added without changing it.
- Built-in features that are naturally optional ship as internal plugins: Ollama provider,
  mermaid, tweet and video embeds, Logseq import, PDF highlight display if ever wanted.

## 14. Mobile and packaging (ADR 005)

PWA first with the native-feel rules (fixed shell, safe areas, measured keyboard inset, one
moving editor element, toolbar with indent/outdent/move/task/date, swipe to indent, long-press
drag, haptics via the platform layer), then a Capacitor 8 shell for iOS/Android stores (native
SQLite, exact keyboard events, share-sheet receiving, `nooklet://` scheme for Shortcuts and Siri,
home-screen quick actions), then Tauri 2 for desktop (global quick-capture hotkey, tray). Quick
capture is a dedicated lightweight route that appends to today's journal without loading the
graph.

## 15. Milestones



Status is tracked in the first column. Effort assumed one developer directing coding agents.

| # | Milestone | Status | Contents |
|---|---|---|---|
| M0 | Foundations | **done** | `core`: model, parser/serializer, refs, journals, short ids, HLC, ops, inline tokenizer, `applyOps`/`rebuild` on a driver interface with property-based multi-device convergence tests |
| M1 | Server | **done** | SQLite store, sync endpoints (push/pull/snapshot/WS poke), Logseq file-graph importer (ADR 012), mirror export, FTS5, op registry, HTTP API + OpenAPI, MCP server + stdio bridge, tokens, CLI, audit/changes. Verified end to end against the real 952-page graph |
| M1.5 | AI parity | **done** | `batch_undo`, `asset_upload` (ADR 013) |
| M2 | Web client | **done** | Solid app, SQLite WASM replica, sync client, page/journal views, CM6 editor surface, references panels, search, palette/keymap/slash menu, tasks, properties, PWA shell, live-UI-control channel (ADR 015) |
| M3 | Embeddings | **done** | Provider interface, Ollama + OpenAI-compatible, worker queue, hybrid search, related |
| M4 | Plugins | **done** | `@nooklet/plugin-api` package and docs (done); loader for both halves, extension points, built-ins as plugins |
| M5 | Mobile polish | **partial** | Keyboard toolbar, gestures and the quick-capture route are done in the PWA. iOS Capacitor shell (`apps/web/ios/`, committed): builds with Xcode 26.6 and runs on the iOS 26.5 Simulator (2026-09-14) — boots, "Just this device" local-only mode works (B-563/B-569), a server address can be entered (B-561 session), deep-link scheme registered, `pnpm ios:sync`/`ios:open`. Local-only storage durability: `persist()`, reopen-on-resume, native-file checkpoint (B-573, proposal 004). **Not verified**: any physical device, any `@capacitor/*` plugin call reaching its native bridge, a completed connect to a real server from the Simulator, a real background/resume or eviction/restore cycle. No Android project; icons, signing and privacy manifest untouched. macOS is the shipping target (ADR 016) and phone is a stated later bet |
| M6 | Hardening | **done** | Multi-device simulation tests, rebuild parity, 3-way text merge, op GC, backups/restore, docs |
| M7 | What Logseq users use most and ask for most (research/13 §4.2) | **done** (2026-09-12) | All ten landed, each with tests: 1. ```` ```query ```` fence (ADR 011 amended; `core/query.ts`, `/query`) · 2. templates: `/template`, journal template, `<% today %>` (ADR 019) · 3. turn block into page, move block to page, merge pages (ADR 020; ops + MCP + context menu) · 4. find and replace (`graph.replace`, `/replace` view) · 5. linked-reference filters and sort, per device (ADR 021) · 6. appearance: font size, width, custom CSS · 7. page outline card in the shelf · 8. trash/restore, page history with undo and restore-this-version (ADR 022; no expiry) · 9. highlight.js and KaTeX behind lazy seams (research/14) · 10. orphan-asset GC (`gc --asset-grace`) and "link all unlinked references" (`mentions.link`). Not done, logged: B-85 cross-page `block.move` strands descendants (core), B-86 `[[Page|label]]` refs, B-88 editing row outlives its block, B-94 query `today` after midnight, B-108 template insert not in Cmd+Z. |
| M12 | Multi-graph hosting; desktop and phone as clients (ADR 025) | **done** except its M7 (2026-09-16) | Server hosts N graphs under `/g/:graphId/` with a graph registry, one-time storage migration, root token and `/graphs`; client keeps a list of graphs (OPFS/lock namespaced) with a graph switcher; desktop `desktop.json` holds a list of remote graphs plus its own sidecar, picker auto-restarts the app and re-checks an unreachable server every 3 s. Progress and evidence: `docs/progress/multi-graph-hosting.md`. Open: ADR 025's M7 (confirm the switcher on the iOS Simulator), a human click-through of the desktop picker (never done), B-585, B-587. (M8–M11 were QA/fix runs, recorded in `docs/progress/coordinator.md`, not scope.) |

Milestone exit criteria: M1 imports the user's real graph and answers MCP queries from Claude
Code; M2 replaces Logseq for daily journaling on desktop and phone; M3 finds notes by meaning in
Czech and English; M4 has three built-in plugins running through the public API only.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Hand-rolled sync bugs | Property-based multi-device simulation, `rebuild()` parity check on every server start in dev, op log kept forever |
| CodeMirror composition bugs on specific Android keyboards | `Surface` interface with a ~300-line textarea fallback, early device matrix |
| iOS viewport/keyboard regressions (26.x) | Stale-value guards, per-release testing, Capacitor shell as the escape hatch |
| iOS storage eviction | Server is truth; outbox flushed within seconds; snapshot re-bootstrap — **does not hold for a "Just this device" (local-only) replica, which has no server to re-bootstrap from.** For that case (2026-09-15): `navigator.storage.persist()`, reopen-on-resume, and a periodic checkpoint of the SQLite bytes into native app storage restored on an empty pool (`docs/BUGS.md` B-573, `docs/proposals/004-capacitor-storage-durability.md`). The restore path has not run on a real eviction |
| Two independently-started graphs (e.g. desktop standalone + phone local-only) wanting to become one | Merging two populated graphs stays rejected (`docs/proposals/003-independently-started-graphs.md`, Option B); ADR 025 instead lets a device hold both graphs side by side and switch between them |
| Scope creep | Non-goals list above; ADR for every new subsystem; internal plugins for optional features |
| Tokenizer grammar drift vs pasted Logseq/Obsidian text | Written grammar, spec corpus from both real graphs, unknown syntax stays text |
| TypeScript 7 / Biome 2 / Solid 2.0 churn | Pin majors; bounded migrations |

## 17. Decisions confirmed by the user (2026-09-10)

1. **UI framework**: SolidJS 1.9. Confirmed.
2. **Plugin trust in v1**: trusted plugins from the plugins directory. Confirmed.
3. **Ids**: the user is indifferent between UUIDs and short ids; we keep the short 14-character
   ids of ADR 004 for token efficiency and Obsidian `^id` compatibility, mapping Logseq UUIDs on
   import.
4. **Mirror default**: markdown mirror on by default in the server data directory. Confirmed.
5. **Embedding models**: bge-m3 is the default; qwen3-embedding:8b is the other first-class
   profile. Both selectable at runtime.
6. **Cut features**: templates, LOGBOOK (superseded by the op log), PDF highlights, `{{query}}`/
   Datalog blocks, and tweet/video macros stay out of core. Confirmed. Scheduled/deadline was
   later restored to core at the user's request, using typed properties and a `repeat::` value
   instead of org syntax, with history read from the op log instead of a LOGBOOK drawer (ADR
   011); the org-style syntax stays import-only.
7. **Multi-graph**: one graph per server in v1. Confirmed. **Superseded 2026-09-15 by ADR 025**: a
   server hosts N independent graphs routed by `/g/:graphId/`, and a client holds a list of graphs
   instead of one slot. Each individual graph is still exactly what this line originally meant —
   one canonical op log, one `ServerContext`, no cross-graph merge — the server process is what
   gained the ability to host more than one.
