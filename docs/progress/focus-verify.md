# M9 progress — adversarial verification of m9/focus

Verifier's log for branch `m9/focus` (worktree `.claude/worktrees/wf_e473942f-106-6`, base
`febfc23`, e2e port 6401, scratch `.../scratchpad/m9/focus-verify/`, `NOOKLET_DATA` there).
Bug numbers used: B-293, B-294 (inbox `docs/bugs-inbox/focus.md`).

## Done

- Read the whole diff (7 commits). Web unit 1022/1022; `pnpm -r typecheck` clean; biome on the
  changed files clean.
- e2e focus-return, date-picker-type-ahead, follow-link-popup, follow-link, views, dates,
  context-menu: 64 passed, 1 skipped.
- Probes (first as a temporary `e2e/tests/zz-verify-focus.spec.ts`; what settled a bug is kept as
  `tools/probes/focus-return-verify.spec.ts`):
  - caret/range kept through palette open + Escape: OK (`abcdef`, select `cd`, Escape, `X` → `abXef`).
  - palette "Set scheduled date" + type-ahead: OK.
  - autocomplete/slash open + Cmd+Enter / Alt+Down: commands run, popup stays; no corruption from
    the branch.
  - **B-293 found**: palette page row / Create page row while editing, type at once → text goes into
    the block on the page being left (regression; base keeps it out).
  - Pre-existing (at `febfc23` too): Enter on the autocomplete opened by walking into an existing
    link duplicates the link's tail → B-294, open, not this branch's.

- `8712ede` logged B-293; `86fd7a1` fix for page + create rows; `18d8b41` also Navigation commands
  (probe: palette "Follow link under cursor" leaked 1/2 on the branch, 0/2 on base), logged B-294
  (pre-existing walked-into-link Enter corruption) and B-295 (pre-existing Alt+Enter type-ahead
  into the block being left, base 2/2). focus-return --repeat-each=2: 18/18; views+follow-link+
  commands 42 passed; commands unit 409/409; web tsc clean.

- rAF-delayed (150 ms, injected in main.tsx temporarily, reverted) editing + focus + journal-stream
  + selection + editing-row-leaves: HEAD 66-67/68 with `editing.spec` "typing immediately after
  Enter" failing; the same failure with `febfc23`'s `surface.ts` in `editing.spec` → not the B-290
  guard (combined run with base surface passed once, 68/68; HEAD surface in isolation 10/10 on a
  fresh-name copy). focus.spec + selection delayed: 60/60 twice.
- Real graph copy (Megapage 201 blocks, Balení): palette page pick leaks nothing (fixed),
  /scheduled type-ahead OK, context-menu separator OK; **B-296 found**: palette Escape then text
  without keydown lands at block start (P14: insertText 8/8 at 0, keydown 8/8 right).
- `eb752f9` logged B-296; `df842fa` fix (`rememberFocus` restores the document selection inside
  the element). e2e caret test failed 2/2 before, focus-return --repeat-each=2 20/20 after; web
  unit 1024/1024; `pnpm -r typecheck` exit 0.

- Real graph re-run on the fixed build: palette Escape caret on Megapage kept (Ž at 4), page pick
  leaks nothing, /scheduled type-ahead and ctx-menu separator OK (6/6).
- Load: 12 busy node loops (load 4 → 14): views palette tests + focus-return, `--repeat-each=5`:
  70/70.
- Final e2e on the fixed tree: palette group (commands dates focus-return editing-row-leaves
  page-export parity read-only refactor views pages random-page date-picker-type-ahead follow-link*)
  122 passed; editor group (autocomplete* popups context-menu selection focus editing templates
  template-* shelf phone block-properties block-timestamps undo-redo journal-stream-editing tasks)
  166 passed, 1 skipped, 1 failed — focus.spec "Alt+Up/Down moves the block…" line 296 (editing
  row index read once after a poll, 0 vs 1; snapshot shows the editor in row 1). Rerun: that test
  `--repeat-each=10` 10/10, whole focus.spec 30/30. Not in the diff's path (no popup open;
  `refocusAfterReorder` does not go through `surface.attach`).
- Probe `tools/probes/focus-return-verify.spec.ts` committed (B-293/294/295/296 evidence).

## In flight

- (none)

## Next

- Report. Open for others: B-291 (owner), B-292, B-294, B-295.
