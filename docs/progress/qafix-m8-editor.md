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
| Q3 typed `scheduled::` line: DB text, mirror property | B-342 | medium | logged, owner decision `ab146ed` |
| Q4 caret before inserted image | B-343 | low | fixed `e7aa7fb` |
| Q5 `/mermaid` after text inline, never renders | B-344 | low | logged, feature gap `ab146ed` |
| Q6 Set scheduled date on multi-selection dates one block | B-345 | low | fixed `ea06b2d` |
| (found) marker commands act on one block of a selection | B-346 | low | logged, owner decision |
| (found) Backspace/Delete in the palette deletes selected blocks | B-347 | high | fixed (commit after ab146ed) |

## 1. Done (committed)

- `94776a3` Q1/B-340: new `apps/web/src/editor/merge-fields.ts#carryFields`; `commands.ts` merges
  return `MergeRefused` on a conflict; `BlockTree.tsx` shows it in the tree's toast
  (`ReadOnlyNotice.tsx#show(text)`); spec R20a. Unit: `commands.test.ts` (4/6 new red on base).
  E2E `merge-keeps-fields.spec.ts` (2/2 red on base, green after). Related specs (merge, editing,
  block-properties, read-only, parity, undo-redo, focus, editing-row-leaves): 79 passed.
- `7bec2d2` Q2/B-341: `DateChips.tsx` `onLocked`, `BlockRowView.tsx` `onReadOnlyRefused`, one line in
  `BlockTree.tsx`. E2E `read-only.spec.ts` B-341 test red before, green after; read-only + dates +
  journal-agenda: 21 passed.
- `e7aa7fb` Q4/B-343: `BlockTree.tsx#insertUploadedImage` dispatch sets `selection`. E2E
  `image-insert.spec.ts` both tests now type after the insert (2/2 red before, green after; + assets:
  3 passed).
- `ea06b2d` Q6/B-345: `commands/registrations/task.ts` date commands gated on
  `editorFocused || (blockSelected && selectionCount == 1)`; spec table + R38. Unit
  `registrations/index.test.ts` (2/2 red before), e2e `dates.spec.ts` B-345 test (red on base
  `task.ts`, green after). Also B-346/B-347 entries and probe
  `tools/probes/palette-keys-delete-selection.spec.ts`.
- `ab146ed` B-342 (Q3, owner decision: two options with costs in the entry; probe
  `tools/probes/serialize-property-shaped-content.ts` shows every property/timestamp-shaped content
  line re-reads as a property) and B-344 (Q5, feature gap: `classifyFence` reads line 1 only, and the
  plugin host lacks `insertBlockAfter`/`focusBlock`/`currentBlock`). Logged, not fixed.
- B-347 (found, high, fixed): new `apps/web/src/app/text-field-keys.ts` + 3-line hookup in
  `CommandLayer.tsx`; spec R12a. Unit `text-field-keys.test.ts` (3), e2e
  `palette-text-keys.spec.ts` (red before hookup, green after). Sweep of 20 specs (palette-text-keys,
  undo-redo, redo, focus, template-undo, views, commands, popups, page-title-draft, page-find,
  search-filters, settings, dates, selection, context-menu, help, read-only, page-rename,
  autocomplete, templates): 204 passed, 1 skipped, 1 failed = `views.spec.ts` "opening the palette
  while editing … hands focus back" — fails the same with every web file restored to `cf08d19`
  (2/2), i.e. the known B-246/B-193 entry, not this branch.

## 2. In flight

- Nothing.

## 3. Next steps, in order

1. Final regression run of touched specs; report.

## Notes

- `biome check` on `apps/web/src/editor/BlockRowView.tsx` already fails on `cf08d19`
  (`lint/a11y/noStaticElementInteractions` on the row's `onContextMenu`); not touched here.
- Decision (B-340): a merge carries the marker as a marker, and refuses on conflicting values.
- E2E harness trap: Playwright `fill("")` presses Delete — on the palette input with blocks selected
  that deletes them (B-347). Close and reopen the palette instead.

## 4. How to resume

`git switch m9/qafix-m8-editor` in the worktree; read the table above and `git log cf08d19..`.
E2E: `cd e2e && NOOKLET_E2E_PORT=6460 pnpm exec playwright test <spec> --project=chromium`.
