# M11 progress — search-fallback (why search fell back to keyword)

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief: the owner sees "Fell back to keyword search. 4 results" and asks whether semantic search
works. Measured on a copy of their graph: no embedding model configured (`embedding_model`,
`embedding`, `embed_dirty` empty; no `embedding.*` settings) while Ollama runs locally with bge-m3.
So the fallback is right but unexplained.

1. Search view says *why* it fell back: not set up (button to the Settings section), service
   unreachable (with the address), index still building (N of M), any other reason the server
   knows. New op output only through `defineOp`.
2. Settings embeddings flow end to end on a real-graph copy on this branch's own port with Ollama
   at http://127.0.0.1:11434 / bge-m3: configure, indexing progress, semantic query. Time/rate,
   CPU, errors. Plus the desktop sidecar's sqlite-vec loading, run the way `src-tauri/src/main.rs`
   spawns it, on a scratch copy.
3. Tests: component/unit per message, Playwright for "not set up" → Settings, http test for the
   new output field.

Branch `m11/search-fallback` from `52e5d20`, worktree
`<repo>/.claude/worktrees/wf_b8e786c1-020-3`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/search-fallback/`
(`data/` = NOOKLET_DATA, `graph/` = `.backup` copy). E2E port 6418. Bugs to
`docs/bugs-inbox/search-fallback.md` (new numbers B-520..B-529).

## Done (committed)

- `c42f932` progress file; B-520 logged in the inbox before fixing.
- `43fbe68` server: `search` output `fallback` {reason, message, provider, model, host, indexed,
  total, errors, error} (defineOp), reasons in `embeddings/semantic-search.ts`
  (`checkSemanticAvailability` now returns `fallback`; new `embedQueryForSearch` classifies a failed
  query embed by probing the host). B-521 (pages filter matching nothing said `keyword`) fixed.
  Spec `docs/spec/mcp-tools.md` §4.3.5. Test `server/src/ops/search-fallback.http.test.ts` (8, all
  fail on the old code). Server suite 684/684, typecheck clean.
- Evidence before the fix (old code, real-graph copy on :6438): `search` hybrid → only
  `{mode_used: "keyword"}`; `embeddings.status` → vec loaded v0.1.9, active null, switching_to
  null, provider reachable with bge-m3:latest + qwen3-embedding:8b. I.e. "not set up".

- `1f06196` web: `views/SearchFallbackNote.tsx` (+ `search-fallback.css`), one sentence and
  action per reason; `SettingsPanel.tsx#openEmbeddingsSettings` (scroll-request signal, same
  pattern as `PluginsSection`); `api-client.ts` maps `fallback`. Tests
  `SearchFallbackNote.test.tsx` (11), `SearchView.test.tsx` (+3). Web suite 1152/1152.
- `4c22ed4` e2e `e2e/tests/search-fallback.spec.ts` (2). Chromium with settings.spec + views.spec:
  39 passed. The in-viewport assertion was checked to fail with the scroll removed.

- `6f5d00f` B-523 fixed (closing Settings re-runs a fallen-back search; e2e +1 failed before, unit
  +1); B-522 logged with probe `tools/probes/search-embed-silent-host.ts`.
- `78853bf` B-522 fixed: `QUERY_EMBED_TIMEOUT_MS` = 15 s on the query embed. Test
  `server/src/embeddings/query-embed-timeout.test.ts` (4; 3 fail on the old code). Server 688/688.

## Real-graph run (part 2) — owner's graph `.backup` taken 17:46, this branch's server on :6438

Graph: 18,630 live blocks, 953 pages. Ollama at http://127.0.0.1:11434 with bge-m3:latest (1024d,
F16) and qwen3-embedding:8b. Machine: Apple M4 Pro, 14 cores, 48 GB; load average 9-73 throughout
from other agents' suites, so CPU figures are noisy.

- UI flow driven by Playwright (`<scratch>/ui-configure.mjs`), production build served by the
  server: Search "dovolená" hybrid → "Fell back to keyword search: semantic search is not set up.
  Set up semantic search…", 6 results. Button → Settings at Search & embeddings, "○ Off" →
  "Turn on semantic search…" → form prefilled http://127.0.0.1:11434 / bge-m3 → "Test connection &
  enable": 213 ms to "● Indexing… · ollama:bge-m3 · 1024d · 0 embedded · 19583 still queued".
  Back in Search: "the semantic index is still being built (0 of 19,583 embedded). Check again".
- Backfill (`<scratch>/monitor.jsonl`, 45 samples every 10 s): registered → activated in
  **453 s (7.5 min)**. 14,468 vectors (13,515 blocks + 953 pages); the other 5,115 blocks are
  empty/non-embeddable and drop out of the queue. **0 errors.** ≈32 vectors/s (≈43 queue units/s).
  The search fallback's N of M went 0/19519 → 14085/14468 and the M shrank as expected.
- Resource use while indexing: nooklet server ~2 % CPU (max 7 %), RSS ~240 MB; Ollama processes
  mean 138 % CPU (max 217 %, of 1400 %), RSS 3.36 GB; GPU "Device Utilization %" mean 70 % (0-98;
  the zeros fall between batches). `search` stayed 3-19 ms throughout. DB file 46 MB → 112 MB.
- Server log: only "activated ollama:bge-m3 (id 1) — backfill complete"; no indexer errors.
- After activation: Search "dovolená" hybrid → 50 results, no note, first hit "dovolena" (no
  diacritics; keyword alone did not find it). API: "vacation plans" semantic → mode_used semantic,
  top hit "udělat plán na prázdniny s Robinem" (Czech), 84 ms; keyword → 0 hits; hybrid → 5 hits,
  211 ms. "jak se připravit na pohovor" semantic → interview-prep notes, 168 ms.
- Cold model (bge-m3 unloaded via `keep_alive: 0`): whole searches 5.9 s, 4.2 s, 1.4 s; warm 0.08 s.
  Sized B-522's 15 s bound.

## In flight

- Desktop sidecar check.

## Next steps

1. Desktop sidecar: run the bundled sidecar from
   `<repo>/apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app/Contents/Resources/sidecar`
   exactly as `apps/desktop/src-tauri/src/main.rs#spawn_server` does (node server.mjs serve --data
   --port --web; env NOOKLET_SQLITE_VEC_PATH=vec0.dylib, ESBUILD_BINARY_PATH, NODE_ENV=production)
   against a copy of `graph2/` (already indexed) on :6439; check `embeddings.status.sqlite_vec`, a
   semantic search, and that no file in the bundle changed (`<scratch>/sidecar-before.txt`).
2. Stop the :6438 server. Final suites; report.

## Decisions

- The reasons live on the server (`semantic-search.ts`), the wording per reason in the client
  (`SearchFallbackNote.tsx`) so each can carry its own button; an unknown reason shows the server's
  `message`.
- A failed query embed is classified by probing the host only after the failure — no cost to a
  working search.
- `index_incomplete` (queue empty, failures left) is split from `indexing` because
  `promoteConfiguredModelIfReady` never leaves it on its own.

## Still unverified
