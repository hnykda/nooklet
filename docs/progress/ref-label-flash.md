# ref-label-flash — progress

Branch `m11/ref-label-flash` from `52e5d20`, worktree
`.claude/worktrees/wf_b8e786c1-020-2`. e2e port **6417**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/ref-label-flash/`
(`data/` = NOOKLET_DATA for any nooklet command; `graph/` = real-graph backup when made).

Task: B-500 — every refresh turns `((block refs))` back into the `((id))` placeholder until the
lookup answers. Bug entries go to `docs/bugs-inbox/ref-label-flash.md` (new numbers B-510..B-519),
never `docs/BUGS.md`.

## Plan

1. Reproduce with a MutationObserver text recorder (e2e, Chromium + WebKit).
2. Fix: resolved labels stay across refreshes (stale-while-revalidate cache); check the other
   things a refresh may flash (page names/icons, embeds, query fences, date chips, references
   panel, word count).
3. Measure row renders / resolver calls per refresh on a real-graph page, before and after.
4. Playwright test: across N refreshes no snapshot holds an unresolved `((` for a resolvable ref.

## Done

- Step 1, reproduced (`e2e/tests/ref-label-flash.spec.ts`, 3 tests, all FAIL on `52e5d20`; the
  webkit project's `testMatch` now includes this spec). MutationObserver on `.page-view`:
  - 5 pulls (API `block.update` of an unrelated block on the page): **25 of 30** DOM snapshots show
    every `((ref))` label as `((id))`; Chromium and WebKit identical (25/30).
  - typing ` typed` into another block: **4 of 13** snapshots; Chromium and WebKit identical.
  - rows and ref spans are NOT remounted in the outliner (0 new `.vr-row`, 0 new `.vr-block-ref`):
    the span stays, its content swaps to the placeholder and back.
  - "Flash Rich" page (icon, SCHEDULED + property, embed, query fence, references panel, word
    count), 5 pulls: outliner rows with refs and the query result with a ref flash `((id))` on
    every pull; title/icon, embed, date chip text, references panel text, word count keep their
    text. But per 5 pulls: 10 `.vr-query-hit` remounted (all hits, every pull), 5 `.reference-item`
    (every pull), 5 `.vr-date` chips and 5 `.vr-prop` rows in the outliner (every pull) — DOM
    rebuilt with identical content.
  - Found in passing: the references panel never resolves `((id))` at all (InlineContent passes no
    resolver) — not a flash; to log.
- Cause, from the evidence (all 4 labels go to placeholder together, no remount): `data/store.ts`
  calls `invalidateBlockRefs()` on every change event naming `block`, which empties the whole
  `block-ref-cache.ts` record, so every `lookupBlockText` returns `undefined` until its refetch.

## In flight

- Step 2: rewriting `data/block-ref-cache.ts` as per-id signals, stale-while-revalidate, one
  batched `IN (…)` re-read per change for the ids on screen.

## How to resume

`git log --oneline 52e5d20..` shows what landed. Before each commit: biome check on the files,
`pnpm -r typecheck`, `pnpm --filter @nooklet/web test`. e2e:
`cd e2e && NOOKLET_E2E_PORT=6417 pnpm exec playwright test <specs> --project=chromium`.
