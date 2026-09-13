# M9 progress — clipboard-sync

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Brief: B-245 (Cmd/Ctrl+X on a block selection → `block.cutSelection`, spec row), B-233
(`editing.spec.ts` Enter test fails after `a-fresh-journal.spec.ts`), B-247 (an edit queued behind
a busy replica worker is lost on reload: measure the window, make pending edits survive a reload,
proposal if it needs a design decision).

Branch `m9/clipboard-sync`, worktree `<repo>/.claude/worktrees/wf_e473942f-106-9`,
based on `cf08d19`. E2E port 6402. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/clipboard-sync/`
(`NOOKLET_DATA=<scratch>/data`; `bin/e2e.sh <repeat> <specs…>` runs Playwright on 6402). Bug
entries: `docs/bugs-inbox/clipboard-sync.md` (new numbers B-300..B-309).

## 1. Done (committed)

- B-233 — test fix: `e2e/tests/editing.spec.ts` counts rows relative to the start;
  `e2e/tests/a-fresh-journal.spec.ts` waits for the server to hold its two blocks. Cause: a race
  between the push debounce and the test's browser context closing (see inbox entry). Commit
  "test(e2e): journal Enter tests no longer depend on a push race (B-233)".

- B-245 — `block.cutSelection`: new `apps/web/src/editor/selection-clipboard.ts` (+test), hookup in
  `BlockTree.tsx` (copy case now calls the shared function; new cut case), `keydown.ts` union,
  `commands/registrations/structural.ts` (Cmd/Ctrl+X), spec row + R31 paragraph, e2e test in
  `selection.spec.ts`. Unit web 1006/1006; e2e selection.spec 19/19; the new test fails with the
  registration removed. Logged B-300 (Backspace/Cmd+X in the page title act on a standing block
  selection) in passing. Commit "feat(web): Cmd/Ctrl+X cuts a block selection (B-245)".

- B-247 measured (`tools/probes/replica-busy-window.mjs`, numbers in the inbox entry): even an
  idle-ish worker loses an edit reloaded 100–300 ms after typing; logged B-301 (an op durable in
  the replica is never pushed after a reload until the next local write). Commit "docs(bugs):
  measure the B-247 window; log B-301".

## 2. In flight

- `e2e/tests/reload-durability.spec.ts` (uncommitted until green): 3 tests, all FAIL before the
  fix (verified). Fix plan:
  1. B-301: `WorkerDb.start()` schedules a push when `pending_op` is not empty (+ unit test in
     `db/worker-core.test.ts`).
  2. B-247: new `db/unapplied-ops.ts` — a synchronous `localStorage` write-ahead copy of each
     `applyOps` batch, keyed by page-load owner (held Web Lock = alive), removed when the worker
     answers; at `initDb`, batches of dead owners are replayed through a new worker method that
     skips op ids already in the replica's `op` table. Hook: `db/client.ts#applyOps` + `initDb`.
  3. Proposal `docs/proposals/002-pending-edits-durability.md` with the options.

## 3. Next steps

1. B-247 / B-301 fix per "In flight".
2. B-300 if time allows: end a standing selection on a pointerdown outside the outliner (same
   exclusions as the editing listener); probe spec kept in scratch
   (`zz-probe-selection-input.spec.ts`) → turn into a regression test.
3. Full e2e run at the end (a-fresh-journal now deterministically leaves 2 blocks in today's
   journal; check nothing else depended on the old race).

## 4. Decisions

- B-233: fixed the tests, not the product (the product's Enter is correct).
- B-245: the cut deletes only after the clipboard write resolved (no clipboard → no delete). Not
  wired through `resolveCommand`, same as copy (spec note 11). Wiki shortcut page not regenerated
  (generated file; regenerate after merge).

## 5. Environment notes

- Real-graph copy: `<scratch>/graph/graph.sqlite` (sqlite3 .backup of the owner's graph, 952 pages,
  18,628 blocks, op max seq 20,411). Served by `<scratch>/bin/serve-real.sh` on port 16402 (log
  `<scratch>/server.log`); kill with `lsof -ti :16402 | xargs kill` when done.
