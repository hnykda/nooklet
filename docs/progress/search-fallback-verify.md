# M11 verify — m11/search-fallback (adversarial check of B-520..B-524)

Verifier's resilience log. Branch `m11/search-fallback` from `be81345`, worktree
`.claude/worktrees/wf_b8e786c1-020-3`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/search-fallback-verify/`
(`data/` = NOOKLET_DATA, `graph/` = `.backup` of the owner's graph taken 18:23, `sidecar-graph/` =
`.backup` of `graph/` after indexing). E2E/serve port 6418 only. Bug numbers used: B-525..B-528.

## Done (committed)

- `11e9a7f` this file.
- `c129d3a` B-525 logged; `6de438e` fixed (note's Try again / Check again keep keyboard focus).
- `4afa983` B-526 fixed (e2e "not set up" test collided with search-cleared.spec's "Quokka" page).
- `17f36dc` B-527, B-528 logged open (Settings panel, pre-existing).

## Author's claims, re-checked independently

- Root cause: the `.backup` copy has 18,633 live blocks, 953 pages, 0 `embedding_model` /
  `embedding` / `embed_dirty` rows, no `embedding.*` settings; `embeddings.status` → vec v0.1.9
  loaded, active null, Ollama reachable with bge-m3:latest. Branch server: hybrid "dovolená" →
  `fallback.reason = not_configured`; keyword → no `fallback`. Confirmed.
- New tests fail on the old code: http test 8/8 vs 52e5d20's server files; timeout test 3/4 vs
  43fbe68's `semantic-search.ts`; SearchView tests 3 fail vs 43fbe68's view, 1 (B-523) vs 1f06196's.
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
- Not logged, noted: `data-api.ts#semantic` (plugin API) still embeds with the unbounded
  `embedQueryVector` — B-522's hang in a sibling path, by code reading only (not reproduced). The
  Settings panel does not move focus into itself or restore it on close (pre-existing, all openers).

## Next

1. Full server + web unit suites, `pnpm -r typecheck`, biome.
2. Full Chromium e2e in chunks (≤ 10 min each) on 6418.
