# M9 progress — adversarial verification of m9/focus

Verifier's log for branch `m9/focus` (worktree `.claude/worktrees/wf_e473942f-106-6`, base
`cf08d19`, e2e port 6401, scratch `.../scratchpad/m9/focus-verify/`, `NOOKLET_DATA` there).
Bug numbers used: B-293, B-294 (inbox `docs/bugs-inbox/focus.md`).

## Done

- Read the whole diff (7 commits). Web unit 1022/1022; `pnpm -r typecheck` clean; biome on the
  changed files clean.
- e2e focus-return, date-picker-type-ahead, follow-link-popup, follow-link, views, dates,
  context-menu: 64 passed, 1 skipped.
- Probes (temporary `e2e/tests/zz-verify-focus.spec.ts`, not committed):
  - caret/range kept through palette open + Escape: OK (`abcdef`, select `cd`, Escape, `X` → `abXef`).
  - palette "Set scheduled date" + type-ahead: OK.
  - autocomplete/slash open + Cmd+Enter / Alt+Down: commands run, popup stays; no corruption from
    the branch.
  - **B-293 found**: palette page row / Create page row while editing, type at once → text goes into
    the block on the page being left (regression; base keeps it out).
  - Pre-existing (at `cf08d19` too): Enter on the autocomplete opened by walking into an existing
    link duplicates the link's tail → B-294, open, not this branch's.

## In flight

- B-293 fix in `commands/palette/CommandPalette.tsx`: no focus return for rows that leave the page.

## Next

1. Fix B-293 + e2e test (fails before, passes after), commit.
2. Log B-294.
3. Rerun covering specs; load loop on the palette tests.
