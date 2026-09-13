# Progress — qafix-regression (fix the M10 final regression pass findings Q1-Q5)

Branch `m10/qafix-regression`, worktree `<repo>/.claude/worktrees/wf_ced35de1-fb8-5`,
based on `70c9bb9`. E2E port **6460**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m10/qafix-regression/`
(real-graph copy in `graph/`, served on **6481** while probing; probes `q1-probe.mjs`,
`q2-probe.mjs`, and QA's scripts copied from `../qa-regression/`, pointed at 6481 via `lib.mjs`).

Bugs go to `docs/bugs-inbox/qafix-regression.md` (NOT `docs/BUGS.md`), numbers B-410..B-419.

| QA | Bug | Severity | State |
|---|---|---|---|
| Q1 existing journal day: typed text lost / nowhere to type | B-410 | high | fixed (commit 1) |
| Q2 calendar day: text typed just after Enter garbled | B-411 | high | in flight |
| Q3 no UI to delete a page | B-412 | medium | queued (feature gap: log, skip) |
| Q4 word-count RPC 500 on palette-created page | B-413 | low | queued |
| Q5 no [[ / slash menu on the draft line | B-414 | low | queued (design: log, skip) |
| (found) same journal day created on two devices before either syncs loses one side's blocks | B-415 | — | to log |

## 1. Done (committed)

- B-410 (Q1): `JournalStreamView.tsx` renders `JournalDayLoading` (in `VirtualJournalDay.tsx`)
  until the stream answers; `BlockTree.tsx` renders `.vr-empty-start` for an empty editable page.
  Tests: `journal-draft-sync.spec.ts` (rewritten: the B-243 window no longer exists),
  `journal-day-start.spec.ts` (2 B-410 tests), `JournalStreamView.test.tsx` (1 new, B-170 test's
  mock now refetches). Sweep of 20 journal/page specs: 132 passed, 1 skipped.

## 2. In flight

- B-411 (Q2). Probe `q2-probe.mjs 25 300 30 2500` on the real graph: Enter at 346 ms, the draft's own
  optimistic `BlockTree` attached the editor at 646 ms (300 ms of keys to `<body>`), then at 734 ms the
  pinned section's tree replaced it, and keys went nowhere until the B-107 hand-back re-attached at
  902 ms (`secine`). Plan:
  1. One tree per day: once the draft has started the day, `VirtualJournalDay` keeps rendering its
     own tree; the section does not swap it for the stream's (per-day slot, keyed by day).
  2. The tree is seeded with the ops just written (`BlockTree` prop `initialOps`), so the claim
     effect attaches the editor in the same task as Enter.
  3. Order: the write must be POSTED before the seeded tree can post anything, and with older HLCs
     (a later `block.text` with an older HLC than the `block.create` loses LWW). So the template and
     HLC pool are prepared when the draft gains focus; Enter mints and posts synchronously. If not
     prepared yet, the textarea stays as a type-ahead buffer (Enter closes a line) until it is,
     then everything is written and seeded in one synchronous step.
  E2E red on base: `journal-day-start.spec.ts` "text typed 0 ms after Enter …" (`econd line`). The
  300 ms variant passes on the small e2e graph; plan a busy-worker variant (B-244's
  `occupyReplica`).

## 3. Next steps, in order

1. B-411 as above; unit tests in `VirtualJournalDay.test.tsx` need updating (B-107 hand-back tests).
2. B-413 (Q4): `server-context.ts` plugin RPC maps `OpError` to 500; word-count plugin.
3. Log B-412 (Q3, feature gap), B-414 (Q5, design), B-415 (found) — with a core probe for B-415.
4. Real-graph re-run of QA's s3/s5/s6 scripts against this branch; `pnpm nooklet verify` on the copy.

## Notes

- Decision (B-410): an existing page with no blocks gets a start row inside `BlockTree`, not the
  journal draft — it covers pages from agents too, and keeps the tree (and its undo history) mounted
  when the last block is deleted.
