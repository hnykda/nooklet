# Progress — qafix-m8-editor (fix exploratory-QA findings on M8 editor features, Q1-Q6)

Branch `m9/qafix-m8-editor`, worktree `<repo>/.claude/worktrees/wf_e473942f-106-15`,
based on `cf08d19`. E2E port **6460**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/qafix-m8-editor/`.
QA scripts that found these: `.../scratchpad/m9/qa-m8-editor/*.mjs`.

Bugs go to `docs/bugs-inbox/qafix-m8-editor.md` (NOT `docs/BUGS.md`), numbers B-340..B-349.

| QA | Bug | Severity | State |
|---|---|---|---|
| Q1 merge drops marker/dates/properties | B-340 | high | in progress |
| Q2 date chip writes on a read-only page | B-341 | medium | queued |
| Q3 typed `scheduled::` line: DB text, mirror property | B-342 | medium | queued (may be owner decision) |
| Q4 caret before inserted image | B-343 | low | queued |
| Q5 `/mermaid` after text inline, never renders | B-344 | low | queued |
| Q6 Set scheduled date on multi-selection dates one block | B-345 | low | queued |

## 1. Done (committed)

- (nothing yet)

## 2. In flight

- Q1: unit tests in `apps/web/src/editor/commands.test.ts`, fix in `commands.ts` merge functions.

## 3. Next steps, in order

1. Q1, Q2, Q4, Q5, Q6, then assess Q3.

## 4. How to resume

`git switch m9/qafix-m8-editor` in the worktree; read the table above and `git log cf08d19..`.
E2E: `cd e2e && NOOKLET_E2E_PORT=6460 pnpm exec playwright test <spec> --project=chromium`.
