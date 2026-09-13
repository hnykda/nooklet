# Bug inbox — search-fallback (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-520..B-529.

---

### B-520 · Search says "Fell back to keyword search" and never says why
**Status:** open · **Severity:** medium · **Reported:** 2026-09-13 (owner sees "Fell back to
keyword search. 4 results" and asks whether semantic search works at all)

The Search view's summary line says the search fell back to keyword and stops there. On the
owner's graph the cause is that no embedding model was ever configured — `embedding_model`,
`embedding` and `embed_dirty` are empty and there is no `embedding.*` setting — while Ollama is
running locally with bge-m3 pulled. Nothing on screen says that, or where to turn it on, and the
same words cover every other reason the server degrades: sqlite-vec not loaded, the embedding
server not answering, a model registered but still backfilling, a backfill that stopped on errors.
The server already knows which one it is (`checkSemanticAvailability`, `embeddings.status`); the
`search` op only returns `mode_used`.

---

### B-521 · `search` with a `pages` filter naming no existing page answers `mode_used: "keyword"` for a hybrid request
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, search-fallback (adding B-520's
`fallback`) · **Test:** `packages/server/src/ops/search-fallback.http.test.ts` › "reports the
requested mode — nothing was searched, so nothing fell back"

`pages: ["No Such Page"]` short-circuits before anything runs and returned `mode_used: "keyword"`,
which the op's own description tells an agent to read as "embeddings are unavailable". Nothing was
searched in any mode. It now returns the requested mode, empty hits, and no `fallback`. The web
client never sends `pages`, so this was agent-visible only.

**Fixed 2026-09-13.** `packages/server/src/ops/search.ts` (the early return). The test fails on
the old code.

---

### B-522 · With an active model whose host accepts connections but never answers, every semantic/hybrid search hangs
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, search-fallback (checking that
B-520's `fallback` covers an unreachable host) · **Probe:** `tools/probes/search-embed-silent-host.ts`
· **Test:** `packages/server/src/embeddings/query-embed-timeout.test.ts` (4)

A refused port fails at once and now says "not reachable". A host that accepts the TCP connection
and then says nothing — Ollama wedged while loading a model, a forwarded port to a stopped
container, a VPN route that drops packets — is different: the query embed's `fetch` gets only the
request's own abort signal, so the search waits on it. The probe's hybrid `search` was still
pending after 30 s (undici's default header timeout is 300 s). In the Search view that is
"Searching…" with no end and no reason — B-520's note never gets a result to render.

**Fixed 2026-09-13.** `embedQueryForSearch` (`packages/server/src/embeddings/semantic-search.ts`)
bounds the query embed with `QUERY_EMBED_TIMEOUT_MS` combined with the request's signal; a timeout
is reported as "no answer within N s" — `provider_unreachable` when the host's model list also does
not answer, `query_embedding_failed` when it does. After the fix the probe's search answers in
17.5 s (15 s bound + the probe's 2.5 s) with `provider_unreachable`. The tests use a 300 ms bound
against a silent socket and a host that lists the model but never embeds; run against the old
code, those two hang past their 15 s test timeout and the constant's test fails (3 of 4 fail; the
cancelled-by-caller test passes on both). The 15 s bound is sized against measured cold loads of
bge-m3: whole semantic searches of 5.9 s, 4.2 s and 1.4 s at load average ~70 (0.08 s warm).

---

### B-523 · After turning semantic search on from the Search view's note, closing Settings leaves the note saying it is not set up
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, search-fallback (walking the owner's
flow on a real-graph copy) · **Test:** `e2e/tests/search-fallback.spec.ts` › "closing Settings
re-runs a search that had fallen back, so its note is not left stale (B-523)";
`apps/web/src/views/SearchView.test.tsx` › "closing Settings re-runs a search that fell back, and
only one that did (B-523)"

Search → "Set up semantic search…" → Settings → "Test connection & enable" → close. The Search
view underneath still shows the result it had before, so the note keeps saying "semantic search is
not set up" until the query is edited — it reads as if enabling did nothing. The results resource
is keyed only on the query and filters; nothing re-runs it when Settings closes.

**Fixed 2026-09-13.** `SearchView.tsx` re-runs the search when `settingsOpen` goes from true to
false and the result on screen had a `fallback`; a result that did not fall back is left alone.
The e2e test failed before the fix (no `search` request within 5 s of closing Settings).
