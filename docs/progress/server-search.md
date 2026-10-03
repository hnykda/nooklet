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

## 3. Measured

- `tools/probes/client-fts-cost.mjs` (sqlite-wasm 3.53.4 in Node, owner's graph copy, 18,628
  blocks): FTS5 compiled in; one-time rebuild 57 ms; queries 0.05–0.9 ms.
- `tools/probes/search-latency.mjs` (real Chromium, production build, real server holding the
  owner's graph copy with the `fake` provider, 14,711 vectors, loopback): **device hits 2–4 ms
  after the keystroke; server's semantic matches merged 256–270 ms after it**, of which 250 ms is
  the deliberate typing pause (the request itself ~6–20 ms; curl: hybrid 4–10 ms). Not measured: a
  real model's query embedding (B-522's notes: bge-m3 ≈ 0.08 s warm, 1.4–5.9 s cold) and a
  phone's Tailscale round trip.
- e2e hang test: device hit 5 ms; server given up on at 6.3 s (6 s bound + debounce).

## 4. What the owner must configure for semantic search (server side)

Nothing in env or Helm values: the embedding provider is per graph, stored in that graph's
`setting` table. Set it once per graph, either in the app (Settings → Search & embeddings → "Turn
on semantic search", which calls `embeddings.configure`) or on the server:
`nooklet embed model bge-m3 --provider ollama --host http://<ollama-host>:11434 --data /data`
(on homeserver: `kubectl -n apps exec deploy/nooklet -- /app/node /app/server.mjs embed model …`, same
shape as the `token create` line in `docs/progress/real-device-test.md`). The server then backfills
in-process and switches semantic search on when every unit is embedded. sqlite-vec is already in
the image (`NOOKLET_SQLITE_VEC_PATH=/app/vec0.so`, `deploy/docker/Dockerfile`).

The draft chart (`deploy/k8s/charts/nooklet`) needs **no change for nooklet itself**; it needs an
Ollama the pod can reach. Nothing in `<infra-repo>` (k8s, docs) mentions Ollama, so
on homeserver that is a new service: either an `ollama/ollama` Deployment + ClusterIP Service in `apps`
(host `http://ollama.apps.svc:11434`, a PVC for `/root/.ollama` models, `ollama pull bge-m3`
once), or Ollama on the homeserver host bound to an address the pod can reach (`OLLAMA_HOST=0.0.0.0`,
firewalled to the cluster). nooklet's own limits (768Mi) are unaffected; the model's memory is
Ollama's.

**Comparison** (the owner's notes are mixed Czech/English):
- **Ollama + `bge-m3`** — multilingual (100+ languages), 1024 dims, no query prefix, 8K context
  (2,048 tokens on Ollama, research/06). Verified to exist: <https://ollama.com/library/bge-m3>
  (tags `latest`/`567m`, 1.2 GB download, "More than 100 working languages", fetched 2026-10-03).
  The owner's own A/B preferred it (ADR 010); ~65 short docs/s on an M-series Mac
  (research/06) — a full backfill of 19.6k units took 453 s there (B-520). Notes never leave the
  server. Resources on homeserver, **unverified** (the home server's CPU/RAM are not recorded in infra-repo):
  roughly 1.2 GB disk, ~1.5–2 GB RAM while loaded (Ollama unloads after 5 min idle by default,
  so the first query after idle is cold: 1.4–5.9 s measured on a Mac — the client's 6 s bound may
  miss that one query; set `OLLAMA_KEEP_ALIVE=-1` to keep it resident), CPU-only is fine for this
  volume but the initial backfill on a small CPU will take tens of minutes.
- **OpenAI-compatible API** (`--provider openai-compat --host https://api…/v1`, model e.g. a hosted
  multilingual embedding model) — no local resources, fast backfill, but **every block's text
  (with its breadcrumb) is sent to a third party**, on backfill and on every edit, and every query
  too. Costs money per token. And **it cannot work with a hosted API today**: `OpenAiCompatProvider`
  accepts an `apiKey`, but `embeddings/factory.ts` builds it with `{ baseUrl: host, model }` only —
  no key is ever passed, so only keyless endpoints (LM Studio, llama.cpp server) work.
- **Recommendation: Ollama with `bge-m3` on homeserver**, kept resident (`OLLAMA_KEEP_ALIVE=-1`).

## 5. Verification (2026-10-03)

- `pnpm -r test`: core 473, plugin-api 17, server 758, web 1476 — all passed.
- `pnpm -r typecheck`: exit 0.
- `pnpm exec biome check . --diagnostic-level=error`: only pre-existing format errors in
  `tools/probes/sweep-devices/*` (untouched, also on `34c8d3e`).
- e2e Chromium, port 6345 (+6346 for the semantic server): `search connectivity palette
  sync-timeout local-page-creation` → 26 passed. New specs: `search-semantic-server.spec.ts` (5),
  `search-local-only.spec.ts` (1). WebKit: not run (the webkit project found no tests for this
  filter).
- `connectivity.spec.ts` › "search returns…" failed 3/3 before (B-543, at the journal click, before
  any search) and passed 3/3 + the full run after its fix.
- `pnpm nooklet verify` not run: no server op/sync/schema change (the schema change is the client
  replica's FTS only).

## Done
- `3844838` feat(search): local-first search… (implementation, unit tests, e2e, probes)
- next commit: B-543 test fix, progress file

## Still unverified
- A real embedding model end to end through this client path (only the `fake` provider was used;
  the server's Ollama path itself is covered by B-520's earlier real-graph walk).
- A real phone (Capacitor) over Tailscale; the latency there.
- the home server's capacity for Ollama.
- WebKit for the new specs.

## BUGS.md updates to fold in
- **New, fixed — B-6xx · Search had no local fallback: offline it failed after 10 s, local-only it
  said "Search needs a server"** (owner's server-search request). Fixed by the replica FTS +
  local-first search. Tests: `apps/web/src/data/local-search.test.ts` (8),
  `apps/web/src/data/search-enrich.test.ts` (13), `apps/web/src/views/SearchView.test.tsx`
  › "SearchView: local first, then the server's semantic matches" (9),
  `apps/web/src/data/api-client.test.ts` › "callOp's time bound and cancellation" (2),
  `e2e/tests/search-semantic-server.spec.ts` (5), `e2e/tests/search-local-only.spec.ts` (1).
- **B-577**: its Search branch is superseded — local-only now searches the device (the calm "needs
  a server" message is gone). References/graph branches unchanged.
- **B-543 → fixed**: `connectivity.spec.ts` waits for `draft.or(today's first block)` before
  branching. Test: the spec itself (3/3 fail before, 3/3 pass after, plus the full run).
- **B-529** unchanged (plugin `semantic()` still unbounded). **B-524** unchanged; note the client
  now merges server hits by position, never by score, so raw RRF values no longer matter to it.
- **New, low, open — the device's tag filter is approximate**: `local-search.ts` matches `tags`
  from a block's own text plus `Task` for a marker; a `tags::` block property is not seen (the
  replica has no `ref` table). The server's answer, when merged, is exact.
- **New, low, open — the previous query's rows stay on screen until the device answers** (a
  resource keeps its last value while loading): 2–4 ms locally, so invisible in practice; noted
  because a probe timing "first list change" misreads it (`tools/probes/search-latency.mjs` caveat).
- **Follow-up, not a bug**: `((` autocomplete (`app/hosts.ts#createBlockSource`) still uses a
  bounded `LIKE`; it could use the replica's FTS now (diacritics folded). Not changed.
- **New, low, open — the OpenAI-compatible provider never sends an API key**: `factory.ts` builds
  `new OpenAiCompatProvider({ baseUrl: host, model })` without `apiKey`, and no setting holds one,
  so a hosted `/v1/embeddings` API answers 401. Found by reading code only. Not changed.
- **B-607** hit again while importing the owner's graph for this work (import → serve crashed;
  worked around by writing `graph.json`). Already logged.
