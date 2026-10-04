# M11 progress — ref-pages adversarial verification

Resilience log for the verification pass over `m11/ref-pages` (ADR 024). Updated after every step.

Worktree `<repo>/.claude/worktrees/wf_975bcd44-fae-1`, e2e port 6410. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/ref-pages-verify/`
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 19:27; `data/` = NOOKLET_DATA).

## Done

- Read the whole diff `ac2528e..e160f7e`.
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
  all failing on `e160f7e`. Server suite 713/713, typecheck clean.
- B-446 (fixed, 70ca5a8): the sweep stamped its 259 pages "now" — they topped All pages' default
  "Recently edited" (row 260 was the first real page). Now dated by earliest reference.
- B-447 (open): after `nooklet gc` trims the op log, junk tombstones show in the trash and unlinked
  empty pages stay (probe in the entry).
- B-448 (open): page-level property links other than `tags::` make no page (2 names on the owner's
  graph).
- B-449 (open, low): spaced namespace `[[Garden / Beds]]`; block `alias::` keeps a junk page alive.
- Not a defect, noted: `batch.undo` of the write that linked a page deletes that page even after
  someone typed into it (batch.undo's documented LWW contract; it is in the trash with its block).
  `page.delete` of an empty page something still links answers "deleted" and a new empty page
  takes the name at once. Journal days created on two devices offline now converge through
  `refused_pages` too (scratch two-replica test, both orders, both blocks kept, verify OK).

- `nooklet import ~/notes-graph` into a fresh scratch dir: 127 pages + 825
  journals + 259 referenced pages, 18,628 blocks, 0 errors, 4.6 s; 1,211 live pages, 17 dangling
  keys (journal days); `verify` OK over 19,839 ops. Real-graph copy after the browser writes:
  `verify` OK over 20,745 ops.
- e2e: B-445 in two Chromium contexts (fails on `e160f7e`'s server, passes now); a probe of typing
  that continues while B-442's client repair moves a refused page (caret stays, nothing lost) —
  both added to `e2e/tests/ref-pages.spec.ts`, 7/7.

- Unit, on 70ca5a8: server 714/714 (713 at f3f5f28 + B-446's test), web 1,143/1,143, core
  408/408, plugin-api 17/17; `pnpm -r typecheck` clean; biome clean on every file the branch
  changed (the repo-wide `biome check .` reports older issues in HelpMenu.tsx, DiagnosticsPanel.tsx,
  plugin-api and the Tauri gen schemas, none touched here).
- Full Chromium e2e on 6410 at 65af6b3: 541 passed, 2 skipped, 0 failed (8.5 min).
- Real graph, fresh copy served with 70ca5a8: "created 259 pages … in 52 ms", dev verify OK;
  All pages' "Recently edited" top rows now mix real and minted pages by date (`home`, minted from
  a block written today, first); `graph.overview` recent_pages likewise; the `#` popup offers the
  minted `AcmeCorp`, Enter inserts `#AcmeCorp` and the caret stays; verify after writes OK
  over 20,743 ops. `mirror_file` on the served copy: 916 rows = 916 files, no row for an empty page,
  no non-empty page without one.
- Observation, not fixed: `SyncClient` removes a refused page in one transaction and re-sends its
  content in the next (`reapplyCaptured` after the callbacks) — a crash between the two would lose
  that content. No await between them, so the window is one synchronous task.

## Next

1. (done) B-445.
2. (done) unit suites, typecheck, biome, real-graph verify.
3. (done) Second full Chromium e2e on 70ca5a8 (the last code change): 541 passed, 2 skipped,
   0 failed (8.4 min). Server suite on it: 714/714.

Verification complete. Open for the coordinator: B-443, B-444 (from the branch), B-447, B-448,
B-449 (from this pass).
