# M8 · verify impl-dates — progress log

Adversarial verification of branch `m8/impl-dates` (worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-8`, e2e port 6400, scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-dates-verify/`).
Verifying the claims in `docs/progress/impl-dates.md` (B-96 picker, B-102 chips, B-143 import).

## Done

- Read the whole diff 61279a2..33b8d8b. `e2e/tests/dates.spec.ts` 6/6 green on a rebuilt client.
- Browser probes (`e2e/tests/zz-verify-probe*.spec.ts`, scratch only, not committed):
  - `+10000y` stored `scheduled:: 1202-60-91`; `+99999999d` threw RangeError in the preview →
    **B-145, fixed in `bee6229`** (parse.ts range check, formatStoredDate throws, arrows clamp).
  - Palette-run commands from edit mode leave focus on `<body>` — for EVERY command (Set priority
    A, Mark DONE too), so pre-existing palette behaviour, not the picker (already B-193/B-246).
  - Keys typed within ~7–25 ms of the slash-menu Enter land in the block (the picker mounts after
    a replica read + lazy chunk). Human-speed typing is slower than the measured gap. B-147.
  - Chip click while editing another block: focus stays, pick lands on the chip's block. OK.
  - 390 px phone: picker 296 px wide, on screen. OK.
  - After a pick, Enter splits the block normally (popup claim released). OK.

## Incident (read this)

09:19:40 I ran `pnpm nooklet serve --help` in the worktree to read its flags. `--help` is ignored
there, so it SERVED `~/.nooklet/default` (migrations applied, mirror rewritten) on port 6100 for
~10 min until I killed it. Full measured diff and the CLI cause: B-146 in
`docs/bugs-inbox/impl-dates.md`. Pre-incident DB copy: scratch `graph/graph.sqlite` (09:19:07).
Nothing further was run against the default dir; every command below passes `--data`.

## Done since

- `bee6229` B-145 fix + 3 unit tests; `c70b71e` e2e "structural keys held… (B-145)" (fails on
  the pre-fix parser); B-146 (CLI `serve --help`), B-147 (type-ahead / keydown-less text), B-148
  (ui_run error surfaces as timeout) logged. Palette-run commands losing editor focus is already
  logged by other branches (B-193, B-246) — not re-logged.
- Real graph copy (pre-incident backup) served on 6400: chips on 2022-12-16 (2, closed), `/deadline`
  `24.12. 18:00 every year` on a Czech DONE block stored `2026-12-24 18:00` + `repeat 1y`; `none`
  via chip cleared it; no page errors; `nooklet verify --data <copy>` OK, 20,416 ops.
- Fresh import of `~/notes-graph` (branch code): 24 `scheduled_day`, 0
  leftover `SCHEDULED:` text; verify OK, 19,580 ops. Source survey: 24 lines, 20 unpadded. B-143 holds.
- ui_run with args writes without a picker (`tomorrow`, `{date}`, `{date:null}`); bad args → B-148.
- e2e (chromium, port 6400): the 14 covering specs in one run 190 passed, 1 skipped; the other 24
  specs in two runs 61 + 43 passed, 1 skipped. Whole suite: 294 passed, 2 skipped, 0 failed.
- Unit: core 336/336, plugin-api 17/17, server 522/522, web 723/723 (twice in a row at load ~12;
  at load ~32 two runs each hit the two B-144 flakes). `pnpm -r typecheck` 0. Biome: only the
  pre-existing BlockRowView `noStaticElementInteractions` (present at 61279a2, checked).

## Next

Verification complete; nothing in flight. Open for owners: B-142, B-146 (CLI, high), B-147, B-148.
