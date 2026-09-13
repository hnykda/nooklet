# M11 progress — keys-in-fields (B-300)

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief: B-300 (with a block selection standing, keys typed into the page title or the command
palette's input act on the selected blocks). Owner-approved fix, option (c): the global
`KeyboardDispatch` (`apps/web/src/app/CommandLayer.tsx`, capture phase) leaves keys alone whose
target is an input, textarea or contenteditable OUTSIDE the outliner. Check every command meant to
fire from such a field and keep it working; list each in the bug entry with how it was checked.
Playwright: title Backspace/Cmd+X with a selection; palette Backspace, Cmd+A then Cmd+X with a
selection; a selection still answers Backspace/Cmd+X when no field has focus. Raise severity to high.

Branch `m11/keys-in-fields` from `52e5d20`, worktree
`<repo>/.claude/worktrees/wf_975bcd44-fae-2`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/keys-in-fields/`
(`data/` = NOOKLET_DATA). E2E port 6411. Bugs go to `docs/bugs-inbox/keys-in-fields.md` (new
numbers B-450..B-459), never `docs/BUGS.md`.

## Findings

- `52e5d20` already had B-347's partial fix (`textFieldOwnsKey`, R12a): Backspace/Cmd+X in the
  title and Backspace/Cmd+A/Cmd+X in the palette were already fine. Every other key still ran
  against the outliner: title Enter → `block.editSelected`, Cmd+Shift+D → duplicate, Cmd+. → zoom,
  palette over an edit Cmd+Shift+K → `[]()` into the block. Probe:
  `tools/probes/keys-in-fields-selection.spec.ts` (results in its header).
- Decision: implement (c) as "dispatch with the outliner hidden" rather than "skip dispatch", so
  the `when: true` global shortcuts (Cmd+K, Cmd+J, …) and `pageView` Cmd+F keep firing from fields
  without a hand-kept allowlist. Palette rows still see the full context.
- New B-450 (open, owner decision): Enter on a focused BUTTON with a selection standing opens the
  block instead of pressing the button. Buttons are outside (c)'s scope.

## Done

- Code: `app/text-field-keys.ts#isFieldOutsideOutliner`, `app/editor-host.ts#withoutOutliner`,
  `app/CommandLayer.tsx` (3-line hunk). Spec R12b in `docs/spec/commands-and-keymap.md`.
- Tests: `app/text-field-keys.test.ts` (+3), `e2e/tests/keys-in-fields.spec.ts` (7). 5 of the e2e
  tests fail with the dispatch line disabled (checked).
- Suites: web unit 1141/1141, `pnpm -r typecheck` clean, biome clean on touched files. Related e2e
  set (26 spec files) 216 passed / 1 skipped before test 7 was added; keys-in-fields 7/7.
- `6447615` fix + tests + spec R12b + inbox (B-300 existing, B-450 new) + probe.
- Full e2e suite in 3 runs (543 tests, load avg 65–106): 539 passed, 2 skipped, 2 failed — `parity`
  (a different test each of two same-order runs; the spec alone 14/14 twice: load) and
  `review-reactivity` trash Retry (fails alone too, and with the dispatch line disabled → logged as
  B-451, not this branch's). Recorded in the inbox; committed after `6447615`.
- No ops/sync/schema/parser touched → `pnpm nooklet verify` not needed.

## Next steps

1. Return to the coordinator. Open for the owner: B-450 (buttons), B-451 (Retry test race).
