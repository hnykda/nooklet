# server-search — search on a server for clients, with the device as the floor

Branch `worktree-agent-af21eebbdee0ec39a` (based on main `34c8d3e`). Started 2026-10-03.

Owner request (verbatim): "enable search-on-a-server for clients? e.g. we obv can't ship embedding
on the phone, so could we - if connected to a remote server - use embedding server search instead
with fallback to local search or something"

Coordinator refinement (adopted): **local first, then enrich** — show the device's keyword hits
immediately; ask the server for hybrid in parallel; merge its semantic hits in without moving rows
under the reader's pointer; the time bound only ends the wait for enrichment; cancel stale
requests; offline / local-only / no embeddings → local only plus a quiet note.

## 1. What existed before (evidence)

| Question | Answer | Evidence |
|---|---|---|
| What does SearchView search? | **Only the server.** `useSearchResults` → `apiClient.search` → `POST {apiBaseUrl}/api/v1/search` (`apiBaseUrl` already includes `/g/<id>`). | `apps/web/src/data/store.ts` (old `useSearchResults`), `apps/web/src/data/api-client.ts` |
| Local FTS on the client? | **None.** The replica had no `block_fts`/`page_fts`; `api-client.ts`'s header said so. The only local text search was `((` autocomplete's bounded `LIKE` (`app/hosts.ts#createBlockSource`). | `apps/web/src/db/schema-client.ts` (old), `grep block_fts apps/web/src` |
| Palette | Commands + page names, fuzzy, local (`commands/palette/CommandPalette.tsx` → `listPages`). No full text. Unchanged. | file |
| Hybrid/semantic to the server? | Yes, already: the view defaulted to `mode: "hybrid"`; the server did FTS+KNN+RRF or fell back to keyword with `fallback.reason` (B-520), shown by `SearchFallbackNote`. | `packages/server/src/ops/search.ts`, `views/SearchFallbackNote.tsx`, `e2e/tests/search-fallback.spec.ts` |
| Offline | Search request failed after `callOp`'s 10 s bound (B-564) → "Search failed. could not reach …" with Retry. No results at all. | `api-client.ts#callOp` |
| Local-only | "Search needs a server — not available in local-only mode." (B-577). No search at all. | old `SearchView.tsx` |
| Server exposure | `search` op in the `defineOp` registry → `POST /g/<id>/api/v1/search`, OpenAPI, MCP tool `search`, typed client. Probed on a real-graph copy (1,211 pages, 18,628 blocks, port 6346): `hybrid` 200 in 8 ms, `mode_used: "keyword"`, `fallback.reason: "not_configured"`. | curl, see "Probes" |
| What it needs | sqlite-vec loaded (it was: `v0.1.9`), and an **active** embedding model: provider `ollama` (default, host `http://127.0.0.1:11434`, model `bge-m3`) or `openai-compat` (`--host <base url>`), set by `nooklet embed model <name> [--provider] [--host]` or Settings → Search & embeddings (`embeddings.configure`). Stored in the graph's `setting` table (`embedding.provider/model/host`), not env/flags. | `embeddings/settings.ts`, `cli.ts` `embed` |
| What the client knows | Nothing ahead of time. It learns per search from `mode_used`/`fallback` (`not_configured`, `indexing`, `index_incomplete` (B-527), `provider_unreachable`, `model_missing`, `query_embedding_failed`, `sqlite_vec_unavailable`). `embeddings.status` exists (Settings uses it) but search never read it. | `semantic-search.ts#checkSemanticAvailability` |
| Fake provider for tests | Existed: `embeddings/fake-provider.ts`, `embedding.provider = "fake"`, but nothing outside unit tests could select it (CLI refused it). | `factory.ts`, `cli.ts` |
| Related pages | `related` op exists server-side; no client UI. Exposing it is *not* trivial (a sidebar panel, its own loading/empty/offline states, per-page refetch) — not built. | `ops/related.ts` |

**So the scope was larger than the request implied in one way and smaller in another:** there was
no local search to fall back *to* (it had to be built), but the server half (hybrid + reasons) was
already there and needed no change beyond a test-only switch.

## 2. What changed

- `packages/core/src/fts-query.ts` (moved from `packages/server/src/ops/`): one FTS query grammar
  for server and device. Server imports updated.
- `apps/web/src/db/schema-client.ts#ensureClientSearchIndex`: the replica gets `block_fts`/`page_fts`
  (server DDL and triggers, no trigram twins), created on every open `IF NOT EXISTS`, rebuilt once
  for a replica that predates them; inside a savepoint; never fatal. Called from
  `worker-core.ts#ensureSchema`. Spec note added to `docs/spec/sql-schema.md` rule 1.
- `apps/web/src/data/local-search.ts`: `searchLocal` (keyword, same filters as the server; tag
  filter approximated from block text + `Task` for markers) and `presenceOnDevice`.
- `apps/web/src/data/search-enrich.ts` (pure): `askServer` (time bound `ENRICH_TIMEOUT_MS` = 6 s,
  abort → discarded), `mergeHits`, `stabilizeHits`, `searchSourceLine`.
- `apps/web/src/data/search-session.ts`: `useSearch` — local resource on every keystroke (and on
  replica table changes); server asked after a 250 ms pause, only when there is a sync target,
  sync is not `offline`, and mode is not keyword; aborted on query change.
- `apps/web/src/data/api-client.ts#callOp`: `{signal, timeoutMs}` options; codes `aborted`/`timeout`.
- `apps/web/src/views/SearchView.tsx`: renders the merged list; `semantic` tag; "Not on this device
  yet" rows that do not open; a quiet `.search-source` line; fallback note kept (shown while a retry
  is in flight so its focused button survives, B-525).
- `store.ts#useSearchResults` removed (only SearchView used it).
- `packages/server/src/cli.ts`: `embed model … --provider fake` accepted only with
  `NOOKLET_TEST_FAKE_EMBEDDINGS=1` (for the e2e spec).

### Decisions
- `[[`/`((` autocomplete stays local and untouched (latency; `((` already worked offline). The
  palette has no full-text search; unchanged.
- Server keyword fallback answers are dropped (device's keyword hits stand) — "no embeddings → local
  only", per coordinator. The server is still asked each time so the fallback note stays truthful.
- Order: the server's ranking is adopted only if the reader has not moved a pointer over / focused
  the list (decided once, at arrival); otherwise device rows stay put and additions go below.
- Time bound 6 s: never delays anything on screen; a cold Ollama (1.4–5.9 s measured, B-522) may
  miss the first query after idle; the next is warm.

## In flight / next
- (update below as steps land)

## BUGS.md updates to fold in
- (filled in at the end)
