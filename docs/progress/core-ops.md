# M10 progress — core-ops (server, core and data bugs)

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief: B-310 (task block opening with a code fence loses its marker in the mirror / code lines
become children without ids; fix serializer+parser, round-trip test, OUT-14 in
markdown-grammar.md), B-311 (web paste of outline text with a page-properties pre-block drops those
lines), B-322 (`page.backlinks` for an uncreated journal day named by a non-ISO title finds no
linked refs), B-370 (`batch.undo` of rename A→B + create new A fails with page-key-collision; http
test), B-324 (Tasks view row shows one date; show scheduled and deadline when both exist). Then
`pnpm nooklet verify` on a real-graph copy.

Branch `m10/core-ops` from `70c9bb9`, worktree
`<repo>/.claude/worktrees/wf_ced35de1-fb8-3`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m10/core-ops/`
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 13:08; `data/` = NOOKLET_DATA for any
nooklet command; `reimport/` = the mirror re-imported). E2E port 6401. Bugs go to
`docs/bugs-inbox/core-ops.md` (new numbers B-390..B-399), never `docs/BUGS.md`.

## Done (committed) — every item of the brief

- `421a829` B-310 + B-390 (new, found fixing B-310) — `core/outline.ts` parser/serializer; spec
  OUT-14 and OUT-18; tests `core/src/outline.test.ts` (+8) and `server/src/mirror/export.test.ts`
  (+1); probe `tools/probes/mirror-roundtrip-graph.ts`.
- `363f376` B-322 — `server/ops/page-backlinks.ts` keys the missing-page branch by `refKeyOf`. Test
  `server/src/ops/page-backlinks-missing-journal.http.test.ts` (2).
- `5f0e4ac` B-370 — `server/ops/batch-undo.ts` orders page restores so a key is freed before it is
  claimed (DFS: a page claiming key K goes after the batch page that holds K and gives it up). Test
  `server/src/ops/batch-undo-name-order.http.test.ts` (3, incl. a two-page swap: still refused).
- `f565e8a` B-324 — `web/views/taskFilters.ts#taskDateLabels` + `TasksView.tsx` + `styles/views.css`.
  Tests `taskFilters.test.ts` (+2), `e2e/tests/tasks-view-dates.spec.ts` (1).
- `11d9ee2` B-311 — `web/editor/paste.ts#pastedBlocks` keeps a pre-block as an empty block with those
  properties. Tests `paste.test.ts` (+4), `e2e/tests/paste-page-properties.spec.ts` (1).

Each new test was run against the pre-fix code and failed (except guard tests noted in the inbox).

## Suites at the end

- Unit: core 406/406, server 673/673, web 1132/1132. `pnpm -r typecheck` clean. Biome clean on
  every changed file.
- e2e (Chromium, port 6401), two runs after all five fixes: agent-ops, selection, page-export,
  mirror-live, undo-redo, redo, history, history-later-edits, trash, trash-conflict — 61 passed;
  render-views, tasks, tasks-view-dates, paste-page-properties, journal-agenda, references,
  template-undo, editing, block-properties, refactor, page-rename, views — 86 passed. 0 failed.
  The full e2e suite was not run.

## Real-graph checks (copy taken 13:08)

- `tools/probes/mirror-roundtrip-graph.ts` (serialize each page as the mirror does, parse back):
  old parser — 441 of 952 pages differ (578 ids, 598 contents: every empty block `- ^id` → text
  `^id`; plus one `LATER` block with an empty line 1). New — 2 pages, 20 blocks, all pre-B-266 literal
  `SCHEDULED: <…>` lines. Of the exported files 450 hold a `- ^id` line; the 9 not in the 441 are
  OUT-14 fence-first blocks both parsers read alike (checked with a scratch old-vs-new diff).
  0 blocks with marker + fence-first content (B-310 itself is not in the data).
- Walk-away: `nooklet export` of the copy (952 files) → `nooklet import` into `reimport/` (18,628
  blocks). Multiset of (page key, content, marker, priority, collapsed, child count) equal except the
  same 20 `SCHEDULED:` blocks. (The importer mints new ids, so ids are not compared this way.)
- `nooklet serve` on the copy (port 6401), script `<scratch>/realgraph-ops.mjs`, log
  `realgraph-ops.log`: `page.backlinks` for uncreated day 2024-08-23 → 33 linked by ISO, by
  "Aug 23rd, 2024" and by "23.08.2024"; one `batch` renaming "97 poets of Reva" + creating a new page
  under that name → undo 200 (original page back, same id), undo of the undo 200, undo again 200;
  `block.update` of a task to fence-first content → marker/content/property intact, and the live
  mirror wrote `- TODO ^id` / `lang:: js` / fence. Server stopped.
- `nooklet verify --data <scratch>/graph`: OK before any write (20,411 ops) and after (20,443 ops).

## Next steps

None left from the brief. For the coordinator: fold `docs/bugs-inbox/core-ops.md` (B-310, B-311,
B-322, B-324, B-370 existing; B-390 new, fixed) into BUGS.md.
