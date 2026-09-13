# Bug inbox — search-fallback (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-520..B-529.

---

### B-520 · Search says "Fell back to keyword search" and never says why
**Status:** fixed · **Severity:** medium · **Reported:** 2026-09-13 (owner sees "Fell back to
keyword search. 4 results" and asks whether semantic search works at all) · **Test:**
`packages/server/src/ops/search-fallback.http.test.ts` (7 of its 8, one per reason),
`apps/web/src/views/SearchFallbackNote.test.tsx` (11), `apps/web/src/views/SearchView.test.tsx` ›
"SearchView fallback note (B-520)" (3), `e2e/tests/search-fallback.spec.ts` › "a hybrid search on a
graph with no embedding model says semantic search is not set up, and the button opens Settings at
Search & embeddings"

The Search view's summary line says the search fell back to keyword and stops there. On the
owner's graph the cause is that no embedding model was ever configured — `embedding_model`,
`embedding` and `embed_dirty` are empty and there is no `embedding.*` setting — while Ollama is
running locally with bge-m3 pulled. Nothing on screen says that, or where to turn it on, and the
same words cover every other reason the server degrades: sqlite-vec not loaded, the embedding
server not answering, a model registered but still backfilling, a backfill that stopped on errors.
The server already knows which one it is (`checkSemanticAvailability`, `embeddings.status`); the
`search` op only returns `mode_used`.

**Fixed 2026-09-13.** `search` gains `fallback` {reason, message, provider, model, host, indexed,
total, errors, error}, present exactly when `mode_used` differs from the requested mode (spec:
`docs/spec/mcp-tools.md` §4.3.5). Reasons, decided in `packages/server/src/embeddings/
semantic-search.ts`: `sqlite_vec_unavailable`, `not_configured`, `indexing` (N of M),
`index_incomplete` (queue drained with failures — the state the model never leaves on its own),
`provider_unreachable`, `model_missing`, `query_embedding_failed`; the last three are told apart by
probing the host only after a query embed failed. The Search view
(`apps/web/src/views/SearchFallbackNote.tsx`) says each in its own sentence with the action that
fits: "Set up semantic search…" opens Settings scrolled to Search & embeddings
(`SettingsPanel.tsx#openEmbeddingsSettings`); unreachable/failed get "Try again"; indexing gets
"Check again". Every http test fails on the old code.

Walked end to end on a copy of the owner's graph with Ollama/bge-m3: the note said "not set up",
the button led to Settings, enabling took 213 ms, the note then said "still being built (0 of
19,583 embedded)", and 453 s later (14,468 vectors, 0 errors) the same hybrid search ran as hybrid
with no note. Details in `docs/progress/search-fallback.md`.

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

---

### B-524 · Hybrid search scores are raw RRF values (≈0.016–0.037), not the 0–1 score the op describes
**Status:** open · **Severity:** low · **Found:** 2026-09-13, search-fallback (in passing, on the
real-graph copy after indexing) · **Test:** none

`search` documents "a 0-1 score" per hit. In hybrid mode the score is reciprocal-rank fusion
(`embeddings/rrf.ts`, k=60, weights 1.25/1.0), whose maximum is 2.25/61 ≈ 0.037; "vacation plans"
hybrid on the owner's graph returned five hits all scored 0.016. Blocks and pages are fused in
separate lists and then sorted together, so the best page and the best block tie at the same value
and interleave regardless of how good either is. In range, but not comparable with keyword or
semantic scores, and no agent can threshold on it. Not changed here.

---

### B-525 · "Try again" / "Check again" on the search fallback note drops keyboard focus to `<body>`
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, search-fallback verify (real-graph
copy on :6418, Chromium and WebKit) · **Test:** `e2e/tests/search-fallback.spec.ts` › "Try again
and Check again keep keyboard focus on the pressed button when the same reason comes back (B-525)";
`apps/web/src/views/SearchView.test.tsx` › "Check again keeps keyboard focus on the button when the
same reason comes back (B-525)" (the `<For>` half only)

Tab to "Try again" (embedding server unreachable) or "Check again" (index still building) and press
Enter: the search re-runs, the note comes back with the same reason, and `document.activeElement`
is `<body>`. Measured with Playwright against this branch's production build: after Enter on "Check
again" during a real backfill and on "Try again" with `embedding.host` pointed at a closed port,
activeElement was `<body>` in both Chromium and WebKit; the note's button before and after the
refetch were different DOM nodes (`isConnected` false for the old one).

Cause: `SearchFallbackNote` renders its actions with `<For each={explained().actions}>`, and
`explainFallback` builds fresh `{kind, label}` objects on every call. `<For>` is keyed by
reference, so every new result — even one with the identical reason — disposes the focused button
and mounts a new one.

That was only half of it. Switching to `<Index>` kept the same button node (unit test green), and
focus STILL fell to `<body>` in Chromium: a MutationObserver on the note showed the button removed
and re-added on every result. Each item was `<>{" "}<button/></>`; Solid's `normalizeIncomingArray`
(solid-js 1.9.15 `web.js`) recurses into a nested array with the single previous node as
`current`, so the `" "` string never matches a previous text node and becomes a new one each time,
and `reconcileArrays` then re-inserts the button next to it — a move, which a browser blurs and
jsdom does not.

**Fixed 2026-09-13.** `apps/web/src/views/SearchFallbackNote.tsx`: `<Index>` over the actions, and
each item one `<span>` holding its space and its button. The e2e test fails on the branch's code
(`<For>`) and on `<Index>` with the fragment, passes with both changes on Chromium and on WebKit (run
through a throwaway config — the committed WebKit project only matches `storage.spec.ts`).
