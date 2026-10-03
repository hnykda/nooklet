# ADR 025: A server hosts N graphs, routed by `/g/:graphId/`; a client remembers a list, not one slot

Date: 2026-09-15. Status: accepted. Supersedes `PLAN.md` §17.7 ("one graph per server in v1.
Confirmed") and the "one graph per server" line in `docs/spec/00-conventions.md`'s Graph
definition.

## Context

Two independent problems converged this session:

- **Client UX**: connecting to a server, or switching between local-only and a server, was
  exclusive and destructive — one slot, chosen once, changing it meant quitting the app
  (`apps/desktop/launcher/index.html`'s picker, B-563/B-584) and orphaning whatever was on the
  device before (`docs/proposals/003-independently-started-graphs.md`, written the same session).
  The owner: *"could we implement multiple graphs? ... once we have that, we will be able to add
  'remote graphs' next to the existing one instead of loading all at once"* — then, when asked
  whether the client-only version (each remote entry pointing at its own single-graph server) was
  enough: *"Well, I want the server to be able to hold/sync multiple graphs too... Somehow
  differentiated (URL?)"*.
- **Server-side scaffolding that was never finished**: `docs/spec/00-conventions.md` already
  defines "Graph" as *"one graph per server in v1; every table still carries `graph_id` so this can
  change without migration."* `packages/server/src/graph-identity.ts`'s header already distinguishes
  the logical `graph_id` column (always `'default'` today) from the physical `graphInstanceId`
  (a per-file UUID). `sync/realtime.ts`'s commit/poke bus already keys its state per-`ServerContext`
  via a `WeakMap`, with its own comment explaining that shape exists "to support multiple
  `ServerContext`s coexisting in one process" even though "in production there is exactly one." The
  intent to eventually host more than one graph was designed in from day one; it was never wired up.

Proposal 003 (previous session) analyzed a harder, different problem — merging two graphs that were
*already independently populated* — and correctly rejected a general op-log merge (identity
collision: two graphs that never shared a common ancestor mint the same kind of id independently, no
coordination). This ADR does not revisit that. Every graph this ADR describes still has exactly one
canonical history, one `ServerContext`, one SQLite file. What changes is that **a server process can
hold more than one such graph, and a client can hold more than one graph in its list** — no merging,
ever, across two graphs that already have independent content.

## Decision

### Identifiers and routing

A graph id is a slug, chosen once at creation, immutable at the protocol level (renaming is a
client-local label only — see "Client" below — so the URL never needs to change and nothing needs
alias/redirect handling). Every graph-scoped endpoint moves under `/g/:graphId/` — `/api/v1/*`,
`/sync/*`, `/ui/live`, `/mcp` all keep their existing shape and payloads, just prefixed. A client's
stored "server URL" becomes `https://host[:port]/g/<graphId>` instead of `https://host[:port]`;
everything downstream (`apiBaseUrl()`, WebSocket URL construction) already builds off one base URL,
so this is a routing change, not a protocol change.

Two new, graph-unscoped endpoints sit above that prefix:

- `GET /graphs` — list the graphs this server hosts (id, label, created_at). Gated by a **root
  token** (below), not a per-graph one — there is no single graph whose token table this could live
  in. Decided over "no discovery, share exact URLs" after asking directly: the owner wants to browse
  what a server already hosts, not just paste links.
- `POST /graphs` — create a new graph, empty or seeded from a request body (the "promote a
  local-only graph" move — see "Client" below). Also root-token gated.

### Storage layout: one SQLite file per graph, not one shared file with `graph_id` filtering

`<dataDir>/graphs/<graphId>/graph.sqlite` plus `<dataDir>/graphs/<graphId>/{pages,journals,assets}/`
(today: `<dataDir>/graph.sqlite` + `<dataDir>/{pages,journals,assets}/` directly,
`packages/server/src/cli.ts`'s `dataDir()`/`open()`). Assets need no separate design: `storeAssetBytes`
(`assets/store.ts:94`) already takes `dataDir` as an explicit parameter rather than a hardcoded path
and writes to `<dataDir>/assets/`, exactly like the mirror — nesting the whole data dir one level
deeper under `graphs/<graphId>/` carries it along unchanged, and `asset_sha256`'s unique index
(currently unscoped, `schema.ts:218`) is safe for the same reason `page_key` is: each graph's `asset`
table is a physically separate table in a separate file, not a shared one filtered by `graph_id`. A
one-time startup migration folds an existing flat layout with no `graphs/` directory yet into
`graphs/default/` automatically — this covers `pages/`, `journals/`, and `assets/` together, one
directory rename.

This is the one place this ADR **rejects** the shape the schema comment above seems to invite (one
shared database, rows filtered by `graph_id`), for a concrete reason found while designing this:
`page_key`/`page_journal_day`'s unique indexes are `ON page(key) WHERE deleted_at IS NULL` — no
`graph_id` in the index — and `op`/`changes`/`token` either lack a `graph_id` column entirely or
were never load-bearing for cross-graph isolation. Making shared-file multi-graph actually safe means
rescoping every unique index and adding `graph_id` to the op log and the token table — real schema
surgery, and the kind of thing a missed `WHERE graph_id = ?` turns into a real cross-graph data leak,
not just a bug. One file per graph gets the same isolation for free from the filesystem and from
`ServerContext` already being the one thing every route/WS handler is constructed with (dependency
injection at mount time, not a bare module singleton — confirmed in `http/app.ts`, `live/live.ts`,
`sync/realtime.ts`). The `graph_id` column stays on state tables (now meaningfully set to that file's
own graph id rather than always `'default'`) for diagnostics/export, not as a query-scoping
mechanism.

### Server process

One process holds a registry (`graphId -> ServerContext`, built lazily on first request per graph
rather than eagerly scanning `graphs/*/` at boot, so creating a graph never requires a restart). An
outer Hono app resolves `/g/:graphId/*` to the right `ServerContext` and delegates to the *same*
`createApp(ctx)` construction that exists today (`http/app.ts`), mounted at that prefix via `app.route(prefix, subApp)` — each mounted instance is already fully self-contained, so this composes
without touching the order-sensitive internals of `createApp` itself (its own comment already
explains why `mountMcp`'s `"/"`-matching sub-app must be mounted last *within* one graph's app; nothing
here changes that). `/sync/live` and `/ui/live` resolve their `ServerContext` the same way at
connect time; `sync/realtime.ts`'s bus needs no change — it was already built for this.

### Auth

Per-graph tokens need no schema change: the `token` table lives inside that graph's own SQLite
file, so a token minted for graph A physically cannot verify against graph B's driver. A new
**root token**, generated once per data dir and stored outside any graph's file (e.g.
`<dataDir>/root.token`, printed once by `nooklet serve` on first run, the same "mint once, surface
it" shape `createSoleToken` already uses for the loopback web-client convenience token), gates
`GET /graphs` and `POST /graphs` only. No per-root-token granularity beyond that, no multi-tenant
account system — this server hosts graphs for one owner (and whoever they hand graph-scoped tokens
to), the root token is an operator credential, not a user identity.

### Client

Replaces the single `storedServerUrl()`/one-slot model (`apps/web/src/data/bootstrap.ts`) with a
list, each entry: `{ label, graphId, baseUrl, token }` (`baseUrl` already includes `/g/<graphId>`,
so `apiBaseUrl()` needs no separate graphId parameter). Switching the active graph reloads the app
pointed at a different entry — `client.ts`/`WorkerDb` stay module singletons initialized once at
boot; hot-swapping them live is not worth building when a reload already does the job and the
picker/connect flow already does this today. Each entry keeps its own OPFS storage the same way
origins already isolate today's single graph — see "Open follow-ups" for the one piece that needs
namespacing work.

Three legal moves, matching what was confirmed in conversation (explicitly **not** a fourth: local
content is never attached to an *existing, populated* different graph — that is proposal 003's
rejected merge, and stays rejected):

1. **New local-only graph** — fresh, empty, unsynced. Unchanged from today.
2. **Promote a local-only graph to a new remote graph** — `POST /graphs` against a server with the
   root token, seeded from this device's local op log. Safe specifically because the target graph
   is created empty by this same call — there is no existing content on the other side to collide
   with, so this is a push, not a merge. Today's connect flow (`ConnectView.tsx`) discards/orphans
   existing local content on connect rather than pushing it (per proposal 003) — that needs to
   change for this move to actually work, not just for the endpoint to exist.
3. **Add an existing remote graph** — point at a graph that already has content (via `GET /graphs`
   discovery or a shared `/g/<id>` URL) and a graph-scoped token; this device joins as a new
   replica, contributing nothing. If the list slot being filled had local-only content already, the
   client forces an explicit choice (keep it as its own separate list entry, or discard it) rather
   than silently combining it into the incoming graph's history.

Renaming a graph, and removing one from a device's list (stop syncing/showing it here, never
touches server data), are both purely local operations on the client's list — no protocol needed.

## Consequences

- `PLAN.md` §17.7 and `docs/spec/00-conventions.md`'s Graph definition both need their "one graph
  per server" line updated to point here — done in this same change for `PLAN.md`; the spec
  documents (`00-conventions.md`, `sql-schema.md`'s index/`op`/`token` definitions) are a real
  follow-up, not done as part of this ADR, since they're implementation-adjacent detail rather than
  a decision.
- No change to ADR 003's per-graph sync protocol at all — HLC, op log, LWW fields, fractional
  indexing are all exactly as they are today, just addressed under a path prefix instead of a bare
  origin.
- A server that only ever hosts one graph (the common case — a single owner's home server) pays
  almost nothing for this: `graphs/default/` instead of the data dir root, one extra path segment
  in every URL, a root token it never has to think about again after first boot.

## Open follow-ups (not resolved by this ADR)

- `ConnectView.tsx`'s connect flow needs a genuine "push my existing local content" path for move 2
  to work end to end — today it always behaves as "join, discard what was here."
- Per-graph OPFS namespacing on the client: today's replica is keyed by *origin* alone. Multiple
  graphs living behind the same origin (e.g. two remote graphs on the same desktop app instance, or
  local-only plus a remote graph) need their storage keyed by graph id too — a `poolName`/db
  filename change in `db/sqlite-wasm-driver.ts`, not a protocol change.
- Whether `nooklet serve`'s CLI grows a `nooklet graph create <id>` wrapping the same `POST /graphs`
  logic, for scripting/ops use outside the app itself. Not required for the client-facing moves
  above.
