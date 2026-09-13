# Progress — qafix-regression (fix the M10 final regression pass findings Q1-Q5)

Branch `m10/qafix-regression`, worktree `<repo>/.claude/worktrees/wf_ced35de1-fb8-5`,
based on `70c9bb9`. E2E port **6460**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m10/qafix-regression/`.
Real-graph copies there: `graph/` (served on 6481 while probing; today emptied, days 20-27 used),
`graph2/` (6482, today used), `graph3/` (6483; `reset3.mjs` restores it from a fresh backup and
restarts the server). Probes: `q1-probe.mjs`, `q1-verify.mjs`, `q2-probe.mjs`, `p3/s2-net2.mjs`,
`p3/worker-latency.mjs`; QA's scripts copied from `../qa-regression/` (`lib.mjs` → 6481,
`p2/lib.mjs` → 6482, `p3/lib.mjs` → 6483). Kill the three servers when done (lsof -iTCP:648x).

Bugs go to `docs/bugs-inbox/qafix-regression.md` (NOT `docs/BUGS.md`), numbers B-410..B-419.

| QA | Bug | Severity | State |
|---|---|---|---|
| Q1 existing journal day: typed text lost / nowhere to type | B-410 | high | fixed `d19ee0a` |
| Q2 day started from its draft: text typed after Enter garbled | B-411 | high | fixed (commit 2) |
| Q3 no UI to delete a page | B-412 | medium | queued (feature gap: log, skip) |
| Q4 word-count RPC 500 on palette-created page | B-413 | low | queued |
| Q5 no [[ / slash menu on the draft line | B-414 | low | queued (design: log, skip) |
| (found) same journal day created on two devices before either syncs | B-415 | — | to log (with core probe) |
| (found) new rows vanish ~2 s after Escape while the `[[` search keeps the worker busy | B-416 | low | logged (commit 2), not fixed |
| existing B-107 (hand-back removed), B-243 (test rewritten) | — | — | entries in inbox (commits 1-2) |

## 1. Done (committed)

- `d19ee0a` B-410 (Q1): `JournalStreamView.tsx` renders `JournalDayLoading` (in
  `VirtualJournalDay.tsx`) until the stream answers; `BlockTree.tsx` renders `.vr-empty-start` for an
  empty editable page. Tests: `journal-draft-sync.spec.ts` (rewritten), `journal-day-start.spec.ts`
  (2 B-410 tests), `JournalStreamView.test.tsx` (1 new). Sweep of 20 specs: 132 passed, 1 skipped.
- commit 2, B-411 (Q2): new `views/JournalDayOutline.tsx` (+ test); `VirtualJournalDay.tsx`
  rewritten around `prepare` (template + HLC pool on focus), synchronous commit, type-ahead buffer
  (`closed` lines), `onStarted`; `BlockTree.tsx` prop `initialOps`; `JournalStreamView.tsx` keys
  both day slots by day. E2E `journal-day-start.spec.ts` now 6 tests (offsets -101..-105, shifted by
  `repeatEachIndex`; -73 had collided with `pages.spec.ts`'s "2nd, two months back"), 3 of the 4
  B-411 tests red on base; `--repeat-each=3` with `journal-draft-sync`: 21/21. Sweep of 27 specs:
  189 passed, 1 skipped, 3 failed → `pages.spec` calendar test was my offset collision (fixed);
  `journal-agenda` "finishing a task elsewhere…" and `template-undo` "…empty bullet…" passed on
  rerun (9/9) — load. Web unit 1132/1132, typecheck clean. Real graph: QA's s5 (days 20-27), s6, and
  s2 (fresh copies) all store every line.

## 2. In flight

- Nothing.

## 3. Next steps, in order

1. B-413 (Q4): `packages/server/src/plugins/server-context.ts:199` plugin RPC turns `OpError`
   not_found into 500; word-count plugin (`plugins/word-count`). Reproduce with a server unit test.
2. Log B-412 (Q3, feature gap), B-414 (Q5, design), B-415 (found) — B-415 with a core probe in
   `tools/probes/`.
3. Final: full e2e run on 6460; `pnpm nooklet verify --data <scratch>/graph3` (no ops/schema touched,
   but cheap); kill servers 6481-6483.

## Notes

- Decision (B-410): an existing page with no blocks gets a start row inside `BlockTree`, not the
  journal draft — it covers pages from agents too, and keeps the tree (and its undo history) mounted
  when the last block is deleted.
- Decision (B-411): keep the textarea draft (Q5 stays a design question) but make its hand-over
  synchronous; no second tree per day.
- `page.clock.setFixedTime` in a probe makes pushes fail with HLC drift (the main-thread clock is
  faked, the worker's is not): QA's `s3-draft.mjs` with a non-today date cannot check storage.
