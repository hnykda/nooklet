# M11 progress — ref-pages adversarial verification

Resilience log for the verification pass over `m11/ref-pages` (ADR 024). Updated after every step.

Worktree `<repo>/.claude/worktrees/wf_975bcd44-fae-1`, e2e port 6410. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/ref-pages-verify/`
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 19:27; `data/` = NOOKLET_DATA).

## Done

- Read the whole diff `52e5d20..3fbd9de`.
- `src/ref-pages.test.ts`, `ops/ref-pages.http.test.ts`, `ref-pages-migration.test.ts`: 30/30.
- `e2e/tests/ref-pages.spec.ts` on 6410: 5/5.
- Real-graph copy (19:27, 953 live pages, 265 dangling keys / 1,355 rows): `nooklet serve` logged
  "created 259 pages … in 55 ms", dev verify OK over 20,736 ops, 17 keys left dangling (all journal
  days), mirror "wrote 916, removed 37". In Chromium against it: Sprouts/Growing/Sixth Try,
  @Eva Svobodová, Task, quick capture, Sprouts open as normal pages with references; All pages
  and the graph list them; a Czech namespaced link `[[Rajčata …/Pěstování/Šestý pokus]]` typed,
  followed, then Cmd+Z'd leaves no page and nothing in the trash.

## Found

- B-445 (fixed, see commit "fix(server): writing that reaches a junk-deleted page brings it back"):
  a block written onto a linked page while offline, after another device removed the link, landed
  on the page the server deleted — hidden from the trash. 4 server tests + 1 two-replica sync test,
  all failing on `3fbd9de`. Server suite 713/713, typecheck clean.
- Not fixed, noted: page-level property links other than `tags::` (`participants:: [[@Petr Novák]]`)
  make no page (2 names on the owner's graph); `[[Garden / Beds]]` (spaces around `/`) — a later
  removed `[[Garden]]` deletes the ancestor while the child lives; `batch.undo` of the write that
  linked a page deletes that page even after someone typed into it (batch.undo's LWW contract; it
  is in the trash with its block).

- `nooklet import ~/notes-graph` into a fresh scratch dir: 127 pages + 825
  journals + 259 referenced pages, 18,628 blocks, 0 errors, 4.6 s; 1,211 live pages, 17 dangling
  keys (journal days); `verify` OK over 19,839 ops. Real-graph copy after the browser writes:
  `verify` OK over 20,745 ops.
- e2e: B-445 in two Chromium contexts (fails on `3fbd9de`'s server, passes now); a probe of typing
  that continues while B-442's client repair moves a refused page (caret stays, nothing lost) —
  both added to `e2e/tests/ref-pages.spec.ts`, 7/7.

## Next

1. (done) B-445.
2. Rerun unit suites, typecheck, biome, e2e subset; real-graph verify after writes.
