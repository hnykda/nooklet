# M8 progress — impl-small (audit §2 small wins)

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Brief: `docs/review/2026-09-12-exposure-audit.md` §2 table, in this order — #15 block timestamps
in the block context menu; #16 search in the current page (Cmd/Ctrl+F); #17 read-only page lock
(`read-only:: true`); #18 random page (`nav.randomPage`, journals excluded); #11 search filters in
the UI (marker, journals only / pages only) if time remains.

Branch `m8/impl-small`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-28`,
based on `da85cfb` (the worktree was created at an older commit, `41666ee`; the branch was reset to
`da85cfb` before any work). E2E port 6409. Bug entries go to `docs/bugs-inbox/impl-small.md`
(numbers B-230..B-239), never `docs/BUGS.md`.

## 1. Done (committed)

- #15 block timestamps (B-230) — commit "feat(web): block created/edited times in the context
  menu". Files: `apps/web/src/app/{block-times.ts,block-times.test.ts,BlockTimestamps.tsx,
  block-timestamps.css}`, `apps/web/src/data/block-times.ts`, one-line hookup in
  `app/BlockContextMenu.tsx`, `e2e/tests/block-timestamps.spec.ts`. Unit web 689/689; e2e
  block-timestamps + context-menu 16 passed, 1 skipped (pre-existing fixme B-73). Logged B-231
  (open) in passing.

## 2. In flight

- #16 search in the current page.

## 3. Next steps, in order

1. #15 block timestamps footer in `app/BlockContextMenu.tsx` (new module + one-line hookup).
2. #16 search in the current page.
3. #17 read-only page lock.
4. #18 random page.
5. #11 search filters.

## 4. Decisions

- `biome check` is not clean repo-wide at `da85cfb` (9 errors, 13 warnings, none in my files —
  e.g. `BlockContextMenu.tsx:134` `useSemanticElements` on `role="separator"`). My files are clean;
  I do not fix others' lint in shared files (merge conflicts).
- #15: "Edited" rather than "Updated", because `updated_at` moves only on `block.text`.

## 5. How to resume

- `git log --oneline da85cfb..m8/impl-small` for what landed; this file for what is in flight.
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-small/`.
- E2E: `cd e2e && NOOKLET_E2E_PORT=6409 pnpm exec playwright test <specs> --project=chromium`.
