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

(nothing yet)

## In flight

- Step 1: reading the code. Suspected cause (NOT yet evidenced): `data/store.ts` calls
  `invalidateBlockRefs()` on every change event naming `block`, which empties the whole
  `block-ref-cache.ts` signal, so every `lookupBlockText` returns `undefined` until its refetch.

## How to resume

`git log --oneline 52e5d20..` shows what landed. Before each commit: biome check on the files,
`pnpm -r typecheck`, `pnpm --filter @nooklet/web test`. e2e:
`cd e2e && NOOKLET_E2E_PORT=6417 pnpm exec playwright test <specs> --project=chromium`.
