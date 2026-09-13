# rv-web-reactivity — fix the M8 web-client correctness review findings

Branch `m8/rv-web-reactivity`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-14`, based on
`da85cfb` (the worktree was created at an older `41666ee`; the fresh branch was reset to
`da85cfb` before any work). e2e port **6472**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/rv-web-reactivity/`
(the reviewer's probes are there too: `f1-listener-hijack.probe.ts`, `f2-errored-resources.probe.tsx`,
`f4-history-gap.probe.ts`, `f5-query-nested-cap.probe.ts` — they import from the MAIN checkout).

Findings F1–F8 (high first), one commit each, each with a failing test first. Bugs logged in
`docs/bugs-inbox/rv-web-reactivity.md` as B-130 (F1), B-131 (F2, F3, F6, F8), B-132 (F4),
B-133 (F5), B-134 (F7). Review record: `docs/review/2026-09-13-m7-rv-web-reactivity.md` (last).

## Done

- `b75e571` bugs inbox + this file (bugs logged before fixing).
- F1 / B-130 — listener fan-out in `db/client.ts` (the commit after `b75e571`, subject
  "fix(web): fan the worker's single change listener out…"). Unit repro `data/history.test.ts`
  failed (0 refetches after Trash) before the fix; e2e `review-reactivity.spec.ts` failed against
  the unfixed client (client.ts temporarily reverted; global-setup rebuilds) and passes with it.
  Related e2e after the fix: trash, history, diagnostics, references, query, remote-device,
  connectivity — 33/33. Web unit 692/692 with F1's tests.
- F2 / B-131 (part) — guarded reads in `TrashView.tsx` (`list()`), `history.ts` (`firstPage()`),
  `HistoryView.tsx`; `views/TrashView.test.tsx`, `views/HistoryView.test.tsx` failed first (stuck
  on Loading…, unhandled rejection). e2e: review-reactivity (3) + trash + history — 13/13.
  Web unit 694/694.
- F3 / B-131 (part) — `QueryFenceView.tsx` guarded `latest()`, `describeError`; new
  `editor/render/QueryFenceView.test.tsx` (real resource, rejecting queryAs) failed first. e2e
  query + render — 14/14 (no e2e for the failure itself: nothing found that makes the worker
  query reject in a browser). Web unit 695/695.
- F4 / B-132 — generation counter in `usePageHistory` (`data/history.ts`); unit case in
  `data/history.test.ts` failed first (gaps 27, 26); e2e case in `review-reactivity.spec.ts`
  failed against the unfixed history.ts (2 batch ids missing) and passes with it. e2e
  review-reactivity (4) + history (6) — 10/10. Web unit: 693 + 3 load-flaky failures
  (`page-title.test.ts` 5 s timeout, `render-seams.test.tsx` query-fence `waitFor` 1 s on the
  first lazy import; load average 44) — render-seams rerun 3× alone: pass, fail, pass.

## In flight

- F5: `queries.ts` nested hits only when actually emitted.

## Next steps, in order

1. (done) F1.
2. (done) F2.
3. (done) F3.
4. (done) F4.
5. F5 — `queries.ts` nested hits only when actually emitted; `queries.test.ts`.
6. F6 — catch in Older changes; `HistoryView` test.
7. F7 — `FindReplaceView` live input + disable while stale/loading; component test.
8. F8 — `VirtualJournalDay` catch + restore draft; its test.
9. e2e: trash, history, query, find-replace (if a spec exists), journal specs on port 6472.
10. Review doc, commit last.

## How to resume

`git log --oneline da85cfb..` shows what landed. Before each commit: `pnpm exec biome check
--write <files>`, `pnpm -r typecheck`, `cd apps/web && pnpm exec vitest run`.
