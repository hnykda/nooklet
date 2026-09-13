# M8 · impl-dates — progress log

Agent task: make dates work end to end. B-96 (`/scheduled`, `/deadline`, "Set scheduled/deadline
date" do nothing — the real command set was handed `createFakeDatePickerHost()`), exposure audit
§2 item 3 (a real, keyboard-first date picker), B-102 / audit §2 item 2 (scheduled/deadline
chips on the row, overdue styled, click opens the picker). Syntax is ADR 011 (`scheduled::
YYYY-MM-DD[ HH:MM]`), picker behaviour is `docs/spec/commands-and-keymap.md` R38.

Branch `m8/impl-dates`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-8`,
started from `da85cfb` (the worktree was created at an older commit, `41666ee`; the fresh branch
was reset to `da85cfb` before any work). e2e port 6400. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-dates/`.

## 1. Done (commit hashes)

(nothing yet)

## 2. In flight

- Reading: `commands/registrations/date-picker-host.ts` (fake), `task.ts` (commands),
  `commands/slash/TemplatePicker.tsx` (the model for a command-opened popup), `popup-keys.ts`,
  `editor/BlockRowView.tsx`, `core/sync/apply-ops.ts` (`block.prop scheduled` → columns).

## 3. Next steps, in order

1. Pure parser `apps/web/src/commands/date-picker/parse.ts` (+ tests): today/tomorrow/yesterday,
   `+3d/-2w/+1m/+1y`, weekday names (next occurrence after today), ISO `YYYY-MM-DD`, optional
   ` HH:MM`, `none`/`clear`.
2. `DatePicker.tsx` popup (mounted into `document.body` like `TemplatePicker`), keys at the
   window capture phase + `claimPopupKeys`; the editor keeps focus.
3. Real host `app/date-picker-host.ts` → swap `createFakeDatePickerHost()` in `CommandLayer.tsx`
   (one line).
4. Chips `editor/DateChips.tsx` + css, one-line hookup in `BlockRowView.tsx`.
5. e2e `e2e/tests/dates.spec.ts`; run with popups/tasks/editing specs.

## 4. Decisions

(none yet)

## 5. How to resume

`git switch m8/impl-dates` in the worktree above; read §3; run
`pnpm --filter @nooklet/web test` and
`cd e2e && NOOKLET_E2E_PORT=6400 pnpm exec playwright test tests/dates.spec.ts --project=chromium`.
