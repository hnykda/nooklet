# M8 · verify impl-dates — progress log

Adversarial verification of branch `m8/impl-dates` (worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-8`, e2e port 6400, scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-dates-verify/`).
Verifying the claims in `docs/progress/impl-dates.md` (B-96 picker, B-102 chips, B-143 import).

## Done

- Read the whole diff da85cfb..0c0ffdf. `e2e/tests/dates.spec.ts` 6/6 green on a rebuilt client.
- Browser probes (`e2e/tests/zz-verify-probe*.spec.ts`, scratch only, not committed):
  - `+10000y` stored `scheduled:: 1202-60-91`; `+99999999d` threw RangeError in the preview →
    **B-145, fixed in `e15d983`** (parse.ts range check, formatStoredDate throws, arrows clamp).
  - Palette-run commands from edit mode leave focus on `<body>` — for EVERY command (Set priority
    A, Mark DONE too), so pre-existing palette behaviour, not the picker. To log (B-146).
  - Keys typed within ~7–25 ms of the slash-menu Enter land in the block (the picker mounts after
    a replica read + lazy chunk). Human-speed typing is slower than the measured gap. To log.
  - Chip click while editing another block: focus stays, pick lands on the chip's block. OK.
  - 390 px phone: picker 296 px wide, on screen. OK.
  - After a pick, Enter splits the block normally (popup claim released). OK.

## Incident (read this)

09:19:40 I ran `pnpm nooklet serve --help` in the worktree to read its flags. `--help` is ignored
there, so it SERVED `~/.nooklet/default` (migrations applied, mirror rewritten) on port 6100 for
~10 min until I killed it. Full measured diff and the CLI cause: B-146 in
`docs/bugs-inbox/impl-dates.md`. Pre-incident DB copy: scratch `graph/graph.sqlite` (09:19:07).
Nothing further was run against the default dir; every command below passes `--data`.

## Next

1. Real graph copy: serve, open a journal with dates, pick/remove, then `nooklet verify`.
2. Fresh import of the Logseq graph: count scheduled_day (claim: 24) and leftover SCHEDULED text.
3. Full unit suites + covering e2e specs; commit own e2e test for the riskiest edge.
