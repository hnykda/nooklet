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
nooklet command). E2E port 6401. Bugs go to `docs/bugs-inbox/core-ops.md` (new numbers
B-390..B-399), never `docs/BUGS.md`.

## Done (committed)

- B-310 + B-390 (new, found fixing B-310) — `core/outline.ts` parser/serializer; spec OUT-14 and
  OUT-18; tests `core/src/outline.test.ts` (8 new) and `server/src/mirror/export.test.ts` (+1);
  probe `tools/probes/mirror-roundtrip-graph.ts`. Core 406, server 668, web 1126 green; typecheck
  clean; `nooklet verify` on the copy OK (20,411 ops). Commit `421a829`.
- B-322 — `server/ops/page-backlinks.ts` keys the missing-page branch by `refKeyOf`. Test
  `server/src/ops/page-backlinks-missing-journal.http.test.ts` (2). Server 670 green. `363f376`.
- B-370 — `server/ops/batch-undo.ts` orders page restores so a key is freed before claimed
  (DFS over "claims key K" → "batch page holding K that gives it up"). Test
  `server/src/ops/batch-undo-name-order.http.test.ts` (3, incl. the swap cycle still refused).
  Server 673 green. `5f0e4ac`. Still to run: e2e undo/history/trash specs.
- B-324 — `web/views/taskFilters.ts#taskDateLabels` + `TasksView.tsx` + `styles/views.css`. Tests
  `taskFilters.test.ts` (+2), `e2e/tests/tasks-view-dates.spec.ts` (1 passed, port 6401).

## Real-graph checks (copy taken 13:08)

- `tools/probes/mirror-roundtrip-graph.ts`: old parser — 441 of 952 pages' mirror text reads back
  differently (578 ids, 598 contents: every empty block `- ^id` → text `^id`; plus the one
  `LATER` block with an empty line 1). New parser — 2 pages, 20 blocks, all pre-B-266 literal
  `SCHEDULED: <…>` lines. 0 blocks with marker + fence-first content (B-310 itself not in the data).

## Next steps

1. (done) B-310 (+B-390).
2. B-322 server `page-backlinks.ts` + http test.
3. B-370 `batch.undo` ordering + http test.
4. B-324 Tasks view both dates + component/e2e test.
5. B-311 web paste pre-block + unit test (+ e2e if cheap).
6. `pnpm nooklet verify --data <scratch>/graph`.
