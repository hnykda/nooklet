# Spec conventions and shared vocabulary

Every spec in this directory builds on these definitions. When a spec needs a term that is not
here, it defines it and adds a one-line entry to the glossary at the end of this file.

## Documents

Specs are implementation-ready: an engineer (or coding agent) must be able to implement from the
spec plus `packages/core` without asking design questions. Each spec has these sections:
Purpose · Definitions · Normative rules (numbered, use MUST/SHOULD/MAY) · Interfaces (TypeScript
types, SQL, JSON examples) · Examples · Test cases (inputs and expected outputs) · Open issues.

The plan (`../PLAN.md`) and the ADRs (`../adr/`) are authoritative on decisions; specs refine
them and MUST NOT contradict them. The research reports (`../research/`) are background.

## Vocabulary

- **Graph**: one user's whole dataset (pages, blocks, assets, settings). One graph per server in v1;
  every table still carries `graph_id` so this can change without migration.
- **Page**: a named container of top-level blocks. Kinds: `page`, `journal`. A journal page is
  identified by its `journalDay`. A **property definition** is a page named `property/<key>`
  (reserved namespace `property`) with a `type::` property. A **tag page** is any page that is
  referenced via `#tag`; it MAY declare `props:: key1, key2` to offer those properties on
  tagging.
- **Block**: a node of a page's tree with markdown `content`, optional task `marker`, optional
  `priority`, `collapsed`, `properties`, and a `place` = `(pageId, parentId | null, order)`.
- **Reference (ref)**: derived link from a block to a page (`[[page]]`, `#tag`, property value)
  or to a block (`((id))`, `{{embed ((id))}}`). Kinds: `page`, `tag`, `block`, `embed`.
- **Op**: one write to one field of one entity (see `packages/core/src/ops.ts`). **Op log**: the
  server's append-only sequence of ops; `seq` is the server-assigned position; `hlc` is the
  conflict clock. **applyOps**: the single write path.
- **Device**: a client installation with a `deviceId` (8 hex chars) and its own HLC.
- **Origin** of a write: `user` (editor), `api`, `mcp`, `sync` (arriving from another device),
  `plugin`, `import`, `mirror` (file watcher), `system` (server jobs, corrective ops).
  **Actor**: human-readable attribution (token label, device name, plugin id).
- **Mirror**: the markdown files the server writes and watches. **Outline format**: our
  markdown outline representation (files and API), defined in `markdown-grammar.md`.
- **Unit** (embeddings): the text chunk that gets one vector (block-with-context or page).
- **Command**: a named, rebindable user-facing operation (`ADR 009`). **Operation (op
  definition)**: an API entry defined with `defineOp` (`ADR 008`); not the same as a sync op.

## Identifiers and formats

- Entity ids (page, block, property definition, asset): 14 lowercase Crockford base32 chars,
  time-ordered (`packages/core/src/ids.ts`). Logseq UUIDs are import input only.
- Device id: 8 lowercase hex. HLC: `2026-09-10T12:34:56.789Z-0003-a1b2c3d4` (`hlc.ts`).
- Op id = its HLC. Sync cursor = integer `seq`.
- Journal day: integer `YYYYMMDD` in storage and core; string `YYYY-MM-DD` in the API and MCP.
- Timestamps: epoch milliseconds (integer) in storage and ops; ISO 8601 UTC strings in the API.
- Page key (identity): `normalizePageName(name)` = NFC, trim, collapse whitespace, lowercase.
- Order keys: `fractional-indexing` strings; ties broken by block id.
- Token scopes: `read`, `write`, `admin`; device tokens carry `sync` in addition to `write`.

## Naming

- TypeScript: `camelCase` fields, `PascalCase` types, files `kebab-case.ts`, ESM with `.js`
  import specifiers. Public packages: `@vrite/core`, `@vrite/server`, `@vrite/plugin-api`.
- SQL: `snake_case` tables and columns; tables singular (`page`, `block`, `block_prop`, `ref`,
  `op`, `embedding`). JSON columns end in `_json`. HLC columns end in `_hlc`.
- Op definitions: `noun.verb` (`page.read`, `block.insert`, `search.query`, `graph.overview`,
  `sync.push`). HTTP: `POST /api/v1/<name>` with a JSON body; GET aliases MAY exist for reads.
  MCP tool name = op name with `.` replaced by `_`.
- Commands: `area.verb` ids (`block.indent`, `task.cycle`, `nav.journals`, `search.open`).
- Settings keys: `dotted.lower.case` (`journal.titleFormat`, `embedding.model`, `mirror.enabled`).
- Property keys: lowercase, `-` instead of `_`, as Logseq normalizes them.

## API conventions

- Request and response bodies are JSON. Errors use one envelope:
  `{ "error": { "code": "not_found" | "invalid" | "conflict" | "forbidden" | "unauthorized" |
  "rate_limited" | "too_large" | "internal", "message": string, "hint"?: string,
  "details"?: object } }` with HTTP status 404/400/409/403/401/429/413/500.
- Lists are paginated: inputs `limit` (default 50, max 500) and `cursor` (opaque string);
  outputs `{ items: [...], cursor?: string }` where a missing cursor means the end.
- Writes accept an optional `idempotencyKey` (stored 24 h) and return what they changed.
- Every write records a `changes` row in the same transaction: `seq`, `origin`, `actor`,
  `batchId`, entity, before/after summaries.
- Authentication is `Authorization: Bearer <token>`; `read` is the minimum scope.

## Storage conventions

- Data directory `$VRITE_DATA` (default `~/.vrite/<graph>`): `graph.sqlite`, `pages/`,
  `journals/`, `assets/`, `plugins/`, `config.json`, `tokens.json` is NOT a file (tokens live in
  SQLite, hashed).
- SQLite: WAL mode, `foreign_keys` on, `synchronous=NORMAL`, one writer connection, separate
  read connections for search and the embeddings worker.
- Derived tables (`ref`, `path_ref`, `block_fts`, `page_fts`, `embedding`) are rebuildable from
  state and never synced; state tables are rebuildable from the op log.

## Glossary additions

(Specs append one line each here when they introduce a term.)
