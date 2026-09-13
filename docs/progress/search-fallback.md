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

(nothing yet)

## In flight

- Logged B-520 (the unexplained fallback) in the inbox.

## Next steps

1. Server: `checkSemanticAvailability` returns a structured reason; `embedQueryVector` reports why
   it failed; `search` output gains `fallback` (defineOp). http test.
2. Web: `api-client` maps it; `SearchView` renders one sentence per reason, "not set up" with a
   button that opens Settings at the embeddings section. Component tests.
3. e2e: "not set up" message → Settings.
4. Real-graph run with Ollama; desktop sidecar run.

## Decisions

## Still unverified
