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

- `f72d70f` logged B-293; `06dac51` fix for page + create rows; `a97a04f` also Navigation commands
  (probe: palette "Follow link under cursor" leaked 1/2 on the branch, 0/2 on base), logged B-294
  (pre-existing walked-into-link Enter corruption) and B-295 (pre-existing Alt+Enter type-ahead
  into the block being left, base 2/2). focus-return --repeat-each=2: 18/18; views+follow-link+
  commands 42 passed; commands unit 409/409; web tsc clean.

- rAF-delayed (150 ms, injected in main.tsx temporarily, reverted) editing + focus + journal-stream
  + selection + editing-row-leaves: HEAD 66-67/68 with `editing.spec` "typing immediately after
  Enter" failing; the same failure with `cf08d19`'s `surface.ts` in `editing.spec` → not the B-290
  guard (combined run with base surface passed once, 68/68; HEAD surface in isolation 10/10 on a
  fresh-name copy). focus.spec + selection delayed: 60/60 twice.
- Real graph copy (Megapage 201 blocks, Balení): palette page pick leaks nothing (fixed),
  /scheduled type-ahead OK, context-menu separator OK; **B-296 found**: palette Escape then text
  without keydown lands at block start (P14: insertText 8/8 at 0, keydown 8/8 right).
- `379bbf9` logged B-296; `11d46b2` fix (`rememberFocus` restores the document selection inside
  the element). e2e caret test failed 2/2 before, focus-return --repeat-each=2 20/20 after; web
  unit 1024/1024; `pnpm -r typecheck` exit 0.

## In flight

- (none)

## Next

1. Re-run real-graph probe on the fixed build (server on 6401 with the graph copy, `e2e/zz-real.config.ts`
   — temporary, uncommitted).
2. Load loop (busy node processes) on views palette test + focus-return.
3. Final covering e2e set; remove temporary probe files; report.
