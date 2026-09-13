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

## 2. In flight

(nothing)

## 3. Next steps

1. B-245: extract the copy serializer from `BlockTree.tsx#runSelectionCommand` into
   `editor/selection-clipboard.ts` (pure, unit-tested); add `block.cutSelection` (keydown union,
   structural registration Cmd/Ctrl+X, BlockTree case: clipboard write resolves → one
   `deleteSelectedBlocks` commit = one undo step); spec row + R31 sentence; e2e in
   `selection.spec.ts` (clipboard text, rows gone, one Cmd+Z restores).
2. B-247: measure the window (worker round-trip latency during cold load / `[[` search on the real
   graph copy); write-ahead journal of in-flight `applyOps` batches in `localStorage`, replayed at
   `initDb` (op ids are HLCs, `applyOps` is idempotent per id — verify); proposal doc with options.
3. Full e2e run at the end (a-fresh-journal now deterministically leaves 2 blocks in today's
   journal; check nothing else depended on the old race).

## 4. Decisions

- B-233: fixed the tests, not the product (the product's Enter is correct).
