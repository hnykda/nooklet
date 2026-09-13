# Progress — qafix-m8-editor (fix exploratory-QA findings on M8 editor features, Q1-Q6)

Branch `m9/qafix-m8-editor`, worktree `<repo>/.claude/worktrees/wf_e473942f-106-15`,
based on `cf08d19`. E2E port **6460**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/qafix-m8-editor/`.
QA scripts that found these: `.../scratchpad/m9/qa-m8-editor/*.mjs`.

Bugs go to `docs/bugs-inbox/qafix-m8-editor.md` (NOT `docs/BUGS.md`), numbers B-340..B-349.

| QA | Bug | Severity | State |
|---|---|---|---|
| Q1 merge drops marker/dates/properties | B-340 | high | fixed `94776a3` |
| Q2 date chip writes on a read-only page | B-341 | medium | fixed `7bec2d2` |
| Q3 typed `scheduled::` line: DB text, mirror property | B-342 | medium | queued (may be owner decision) |
| Q4 caret before inserted image | B-343 | low | fixed (commit after 7bec2d2) |
| Q5 `/mermaid` after text inline, never renders | B-344 | low | queued |
| Q6 Set scheduled date on multi-selection dates one block | B-345 | low | queued |

## 1. Done (committed)

- `94776a3` Q1/B-340: new `apps/web/src/editor/merge-fields.ts#carryFields`; `commands.ts` merges
  return `MergeRefused` on a conflict; `BlockTree.tsx` shows it in the tree's toast
  (`ReadOnlyNotice.tsx#show(text)`); spec R20a. Unit: `commands.test.ts` (4/6 new red on base).
  E2E `merge-keeps-fields.spec.ts` (2/2 red on base, green after). Related specs (merge, editing,
  block-properties, read-only, parity, undo-redo, focus, editing-row-leaves): 79 passed.
- `7bec2d2` Q2/B-341: `DateChips.tsx` `onLocked`, `BlockRowView.tsx` `onReadOnlyRefused`, one line in
  `BlockTree.tsx`. E2E `read-only.spec.ts` B-341 test red before, green after; read-only + dates +
  journal-agenda: 21 passed.

## 2. In flight

- Q5 next.

## 3. Next steps, in order

1. Q5, Q6, then assess Q3.

## Notes

- `biome check` on `apps/web/src/editor/BlockRowView.tsx` already fails on `cf08d19`
  (`lint/a11y/noStaticElementInteractions` on the row's `onContextMenu`); not touched here.
- Decision (B-340): a merge carries the marker as a marker, and refuses on conflicting values.

## 4. How to resume

`git switch m9/qafix-m8-editor` in the worktree; read the table above and `git log cf08d19..`.
E2E: `cd e2e && NOOKLET_E2E_PORT=6460 pnpm exec playwright test <spec> --project=chromium`.
