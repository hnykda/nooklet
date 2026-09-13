# M11 progress — adversarial verification of m11/keys-in-fields (B-300)

Resilience log for the verifying agent. Branch `m11/keys-in-fields` (worktree
`.claude/worktrees/wf_975bcd44-fae-2`), e2e port 6411, scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/keys-in-fields-verify/`.
Bugs go to `docs/bugs-inbox/keys-in-fields.md` (B-450..B-459; B-452 used here).

## Done
- Read the diff (`52e5d20..499afcd`): `isFieldOutsideOutliner` + `withoutOutliner` + 3 lines in
  `KeyboardDispatch`; spec R12b; unit + e2e tests; inbox B-300/B-450/B-451. Design checked against
  every `when` clause in `commands/registrations` (no negated clause survives hiding the outliner;
  no default chord bindings), `popupOpen` claims, `historyEditorHost`, the palette's full-context rows.
- Reran the branch's tests: `text-field-keys.test.ts` 6/6; e2e `keys-in-fields` 7/7 +
  `palette-text-keys` 1/1.
- Probe `tools/probes/keys-in-fields-verify.spec.ts` (cases A–F, results in its header). Findings:
  - B-452 (new, pre-existing, fixed): Cmd+Z on a focused Settings `<select>` undid a block deletion.
  - B-450 evidence: a focused `a[href]` (reachable by Tab from the title) + Enter opens the selected
    block. Added to B-450, still the owner's decision.
  - Everything else held: title Tab/Cmd+Enter/Escape, palette→Escape focus return to the title,
    Czech + namespaced rename with a second browser context and undo, journal draft Enter.
- Real-graph copy (sqlite3 .backup, served on 6411 by this build): title and palette keys over a
  selection on "Balení" and "TTRPG/VTM-alpha/Isabella D'Angelo" left page.read identical;
  `pnpm nooklet verify` 20470 ops, OK exact.
- Fix B-452: `text-field-keys.ts#textFieldOwnsKey` target test widened to
  `isOtherTextField || isFieldOutsideOutliner`; spec R12a amended; unit test (fails without the fix:
  `edit.redo`, `edit.undo` reachable from a select) and e2e test (fails without the fix at the
  select's Cmd+Z) added. Unit 7/7; biome clean on touched files; `pnpm -r typecheck` clean.
- E2E after the fix, port 6411, load ~90–100: batch 1 (keys-in-fields, palette-text-keys,
  focus-return, page-find, undo-redo, redo, undo-gaps, settings, selection) 73 passed; batch 2
  (templates, template-undo, refactor, views, commands, popups, help, navigation, phone-palette,
  journal-day-start, dates, date-picker-type-ahead, page-rename, page-title-draft, search-cleared,
  search-filters, context-menu, page-icons) 164 passed, 1 skipped (context-menu fixme).

- `bd843cc` fix B-452 + tests + probe + inbox + this file.
- Web unit suite after the fix: 138 files, 1142/1142.
- Every one of the 98 e2e spec files ran at least once on `bd843cc` (port 6411, Chromium), in five
  runs (some files matched two filters and ran twice): 73 passed; 164 passed + 1 skipped
  (context-menu fixme); 83 passed + 3 failed (`editing.spec` openJournal strict-mode — ordering, B-453;
  alone 5/5); 105 passed + 1 failed (`journal-agenda` "finishing a task elsewhere…" live update, load;
  alone 6/6); 124 passed + 1 skipped (storage WebKit-only). `review-reactivity` Retry tests passed at
  load ~25–56 → evidence added to B-451 (load-dependent).
- Inbox: B-450 link evidence, B-451 load evidence, B-452 fixed, B-453 (test helper) logged.

## Next steps
1. Commit the inbox/progress update. Return verdict to the coordinator.
