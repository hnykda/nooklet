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

Branch `m11/search-fallback` from `ac2528e`, worktree
`<repo>/.claude/worktrees/wf_b8e786c1-020-3`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/search-fallback/`
(`data/` = NOOKLET_DATA, `graph/` = `.backup` copy). E2E port 6418. Bugs to
`docs/bugs-inbox/search-fallback.md` (new numbers B-520..B-529).

## Done (committed)

- `5124767` progress file; B-520 logged in the inbox before fixing.
- `8314c36` server: `search` output `fallback` {reason, message, provider, model, host, indexed,
  total, errors, error} (defineOp), reasons in `embeddings/semantic-search.ts`
  (`checkSemanticAvailability` now returns `fallback`; new `embedQueryForSearch` classifies a failed
  query embed by probing the host). B-521 (pages filter matching nothing said `keyword`) fixed.
  Spec `docs/spec/mcp-tools.md` §4.3.5. Test `server/src/ops/search-fallback.http.test.ts` (8, all
  fail on the old code). Server suite 684/684, typecheck clean.
- Evidence before the fix (old code, real-graph copy on :6438): `search` hybrid → only
  `{mode_used: "keyword"}`; `embeddings.status` → vec loaded v0.1.9, active null, switching_to
  null, provider reachable with bge-m3:latest + qwen3-embedding:8b. I.e. "not set up".

- `6b2351f` web: `views/SearchFallbackNote.tsx` (+ `search-fallback.css`), one sentence and
  action per reason; `SettingsPanel.tsx#openEmbeddingsSettings` (scroll-request signal, same
  pattern as `PluginsSection`); `api-client.ts` maps `fallback`. Tests
  `SearchFallbackNote.test.tsx` (11), `SearchView.test.tsx` (+3). Web suite 1152/1152.
- `e2be5ef` e2e `e2e/tests/search-fallback.spec.ts` (2). Chromium with settings.spec + views.spec:
  39 passed. The in-viewport assertion was checked to fail with the scroll removed.

- `6da28ad` B-523 fixed (closing Settings re-runs a fallen-back search; e2e +1 failed before, unit
  +1); B-522 logged with probe `tools/probes/search-embed-silent-host.ts`.
- `872dece` B-522 fixed: `QUERY_EMBED_TIMEOUT_MS` = 15 s on the query embed. Test
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

## Desktop sidecar check (bundle built 17:23 in the main checkout, not from this branch)

Ran `<repo>/apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app/Contents/Resources/sidecar/node`
`server.mjs serve --data <scratch>/sidecar-graph --port 6439 --web <sidecar>/web` with
`NOOKLET_SQLITE_VEC_PATH=<sidecar>/vec0.dylib`, `ESBUILD_BINARY_PATH=<sidecar>/esbuild`,
`NODE_ENV=production` — `main.rs#spawn_server`'s arguments and env, but from this shell's
environment and cwd rather than launchd's (a sandbox rule refused `env -i HOME=…`). Data: a
`.backup` of the indexed `graph2/`.

- Bundled node v26.8.1. `embeddings.status`: sqlite_vec loaded **v0.1.9**, active ollama:bge-m3
  1024d, 14,468 indexed, provider reachable. `lsof` on the process shows the bundle's own
  `sidecar/vec0.dylib` mapped.
- Semantic "vacation plans" → mode_used semantic, top hit "udělat plán na prázdniny s Robinem", 247 ms;
  hybrid "dovolená" → hybrid, 254 ms. So vec0 KNN over real vectors works in the packaged server.
- Negative control, same command without `NOOKLET_SQLITE_VEC_PATH` on :6440 and an empty data dir:
  `sqlite_vec.loaded: false`, error "Cannot find module 'sqlite-vec'" — the env var is what makes it
  load.
- No file in the bundle changed (mtime/size listing before and after identical). Both sidecars
  stopped.
- The bundle predates this branch, so its `search` has no `fallback` field.

## Suites at the end

- server 688/688 (84 files); web 1153/1153 (139 files); `pnpm -r typecheck` clean; biome clean on
  every changed file.
- e2e Chromium, port 6418: search-fallback (3) + settings + views — 40 passed, 0 failed. The WebKit
  project only matches `storage.spec.ts`, so nothing here ran on WebKit. Full e2e suite not run.
- `pnpm nooklet verify` not run: no op, sync or schema code changed (search is read-only).

## Next steps

None left in the brief. For the coordinator: fold `docs/bugs-inbox/search-fallback.md` (B-520..B-524)
into `docs/BUGS.md`.

## Decisions

- The reasons live on the server (`semantic-search.ts`), the wording per reason in the client
  (`SearchFallbackNote.tsx`) so each can carry its own button; an unknown reason shows the server's
  `message`.
- A failed query embed is classified by probing the host only after the failure — no cost to a
  working search.
- `index_incomplete` (queue empty, failures left) is split from `indexing` because
  `promoteConfiguredModelIfReady` never leaves it on its own.

## Still unverified

- The desktop sidecar was run with this shell's environment, not the app's launchd environment;
  vec loading is a `loadExtension` of an absolute path, so PATH/cwd should not matter, but the app
  itself was not launched.
- CPU/GPU figures were taken under load average 9-73 from other agents; an idle machine would index
  faster. GPU utilization is the IOAccelerator counter sampled every 10 s, not power metrics.
- Cold-load timings are three samples on one machine. A slower machine could exceed the 15 s
  query-embed bound on a first query; it would then fall back with "no answer within 15 s" once and
  work on the next.
- Browsers other than Chromium were not run.
