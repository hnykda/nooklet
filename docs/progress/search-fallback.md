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

## In flight

- Real-graph run with Ollama (part 2).

## Next steps

1. Real-graph copy served from this branch on :6438, Ollama bge-m3: configure via
   `embeddings.configure`, poll `embeddings.status` + `search` fallback during indexing, time it,
   CPU (`ps`/`top` of node + ollama), errors; semantic query once active.
2. Desktop sidecar: read `apps/desktop/src-tauri/src/main.rs`, run the bundled sidecar from
   `<repo>/apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app/Contents/Resources/sidecar`
   the same way against a scratch copy on :6439; check `embeddings.status.sqlite_vec`.

## Decisions

## Still unverified
