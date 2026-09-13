# M11 verify — m11/search-fallback (adversarial check of B-520..B-524)

Verifier's resilience log. Branch `m11/search-fallback` at `be81345`, worktree
`.claude/worktrees/wf_b8e786c1-020-3`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/search-fallback-verify/`
(`data/` = NOOKLET_DATA). E2E/serve port 6418 only. Bug numbers still free: B-525..B-529.

## Done

- Read the whole diff (server `semantic-search.ts`/`search.ts`, web note/view/settings, tests, spec).
- New server tests on HEAD: 12/12. Against 52e5d20's `search.ts`/`semantic-search.ts`/`probe.ts`:
  http test 8/8 fail. `query-embed-timeout.test.ts` against 43fbe68's `semantic-search.ts`: 3/4 fail
  (two time out at 15 s, constant missing) — matches the author's claim.
- Web: `SearchFallbackNote.test.tsx` + `SearchView.test.tsx` 21/21 on HEAD. SearchView tests vs
  43fbe68's view: 3 fail (the fallback-note ones); vs 1f06196's view: 1 fails (B-523).
- e2e `search-fallback.spec.ts` Chromium on 6418: 3 passed.

## In flight

- Hunting regressions / edge cases (see Next).

## Next

1. Real-graph copy on 6418: owner's state → note says not set up; configure; sample indexing rate.
2. Desktop sidecar vec0 path check on a scratch copy.
3. Edge cases: stale scroll request, indexing state with the indexer not running, focus.
