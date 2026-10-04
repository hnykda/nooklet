# M11 verify — m11/search-fallback (adversarial check of B-520..B-524)

Verifier's resilience log. Branch `m11/search-fallback` from `9140f05`, worktree
`.claude/worktrees/wf_b8e786c1-020-3`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/search-fallback-verify/`
(`data/` = NOOKLET_DATA, `graph/` = `.backup` of the owner's graph taken 18:23, `sidecar-graph/` =
`.backup` of `graph/` after indexing). E2E/serve port 6418 only. Bug numbers used: B-525..B-529 (range exhausted).

## Done (committed)

- `5bf6f6b` this file.
- `f0ce70d` B-525 logged; `1e48360` fixed (note's Try again / Check again keep keyboard focus).
- `b57ac32` B-526 fixed (e2e "not set up" test collided with search-cleared.spec's "Quokka" page).
- `ef609b0` B-527, B-528 logged open (Settings panel, pre-existing).
- B-529 logged open (plugin data API `semantic()` unbounded query embed; code reading only).

## Author's claims, re-checked independently

- Root cause: the `.backup` copy has 18,633 live blocks, 953 pages, 0 `embedding_model` /
  `embedding` / `embed_dirty` rows, no `embedding.*` settings; `embeddings.status` → vec v0.1.9
  loaded, active null, Ollama reachable with bge-m3:latest. Branch server: hybrid "dovolená" →
  `fallback.reason = not_configured`; keyword → no `fallback`. Confirmed.
- New tests fail on the old code: http test 8/8 vs ac2528e's server files; timeout test 3/4 vs
  8314c36's `semantic-search.ts`; SearchView tests 3 fail vs 8314c36's view, 1 (B-523) vs 6b2351f's.
- UI flow on the copy (Chromium, production build): note "not set up" → button → Settings at Search
  & embeddings → "Turn on semantic search…" → prefilled http://127.0.0.1:11434 / bge-m3 → enable
  310 ms → close → note "still being built (0 of 19,586 embedded). Check again".
- Backfill, measured by me (`monitor.jsonl`, 49 samples / 10 s): enable 16:25:40Z → active between
  16:34:02Z and 16:34:12Z, ≈ **8.4–8.5 min**; 14,469 vectors, **0 errors**, ≈ **28.9 vectors/s**.
  Load average 57–130 the whole time (other agents). nooklet server CPU mean 3.2 % (max 43 %), RSS
  ≤ 392 MB; Ollama (serve + llama-server) mean 96 % (max 282 %), RSS ≈ 3.4 GB. Hybrid search while
  indexing: median 33 ms, max 150 ms. DB 48.7 MB → 115.5 MB. `fallback` said `indexing` with N of M
  moving (192/19,522 → 12,742/14,920) until activation, then `hybrid` with no fallback.
- After: semantic "vacation plans" → top hit "udělat plán na prázdniny s Robinem" (155 ms), keyword → 0
  hits; hybrid "dovolená" → hybrid, hits "dovolena"/"dovolená" (242 ms). B-524 confirmed: hybrid
  scores 0.016 / 0.035.
- Unreachable host (`embedding.host` → closed port 59999): `provider_unreachable` in 26 ms with
  ECONNREFUSED; Chromium and WebKit render "the embedding service at http://127.0.0.1:59999 is not
  reachable. (fetch failed: connect ECONNREFUSED …) Try again Search settings".
- Silent host (TCP accept, never answers) on the real copy: search answered in **17,538 ms**,
  `provider_unreachable` "(no answer within 15 s)". Confirmed B-522's fix.
- Desktop sidecar: bundle `nooklet.app/Contents/Resources/sidecar` (17:23 build) run exactly as
  `main.rs#spawn_server` (node server.mjs serve --data --port --web; NOOKLET_SQLITE_VEC_PATH,
  ESBUILD_BINARY_PATH, NODE_ENV=production) under `env -i` with cwd `/`, on :6418 against
  `sidecar-graph/`: vec v0.1.9 loaded, `lsof` shows the bundle's `vec0.dylib` mapped; semantic 110 ms,
  hybrid 293 ms; a new page's 3 units were embedded by the sidecar's indexer within 4 s and found by
  a semantic query — vec0 writes and KNN both work in the bundle. Bundle listing unchanged. Stopped.

## Found

- B-525 (fixed): real browsers lost focus on Try again / Check again. Two causes — `<For>` over new
  objects, and a `{" "}` string in each item's fragment that Solid re-creates, moving the button.
- B-526 (fixed): e2e test isolation, see inbox.
- B-527 / B-528 (open): Settings panel wording in the failed-backfill state; no auto-refresh.
- B-529 (open): `data-api.ts#semantic` (plugin API) still embeds with the unbounded
  `embedQueryVector` — B-522's hang in a sibling path, by code reading only (not reproduced).
- Not logged, noted: the Settings panel does not move focus into itself or restore it on close
  (pre-existing, same for every opener, not something this branch changed).

## Suites (after the verifier's commits)

- server 688/688 (84 files); web 1154/1154 (139 files, +1 B-525); `pnpm -r typecheck` exit 0; biome
  clean on the 14 code files the branch changed (DiagnosticsPanel.tsx has pre-existing biome errors,
  untouched here).
- e2e `search-fallback.spec.ts` (4): Chromium 4/4; WebKit 4/4 through a throwaway config (not
  committed — the WebKit project only matches `storage.spec.ts`).
- Full Chromium e2e, run in four chunks of spec files on 6418 (a single run exceeds the 10-minute
  foreground limit): 148 passed + 1 skipped; 110 passed + 1 failed; 139 passed; 139 passed + 1
  failed + 1 skipped. The two failures — `journals.spec.ts` "clicking a search result opens the page
  it came from" (target page stuck on "Loading…") and `review-reactivity.spec.ts` "a failed Older
  changes…" (25 history batches, expected 26) — both passed when re-run (journals: chunk re-run and
  alone; review-reactivity: alone, 7/7). The chunk-2 re-run failed a different test instead,
  `pages.spec.ts` "a page created through the API appears in the open sidebar without a reload",
  which passed alone (14/14). None touches code this branch changed; recorded as flaky under load
  (load average 15–130 during the runs), not proven pre-existing on main.
- `pnpm nooklet verify` not run: no op, sync or schema code changed.

## Still unverified

- The installed desktop app itself was not launched; the sidecar was run by hand the way `main.rs`
  spawns it (`env -i`, cwd `/`).
- Nothing exercised `model_missing` / `query_embedding_failed` against a real Ollama (the author's
  stub-server http tests cover them).
- The three flaky e2e tests above were not run on ac2528e to show they are flaky there too.
