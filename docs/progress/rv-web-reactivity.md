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

(nothing yet)

## In flight

- F1: fan-out of change/sync-status listeners in `apps/web/src/db/client.ts`.

## Next steps, in order

1. F1 — `db/client.ts` fan-out + unsubscribe; `useSyncStatus` onCleanup; comments in store.ts,
   history.ts, worker-api.ts. Tests: `db/client.test.ts`, `data/history.test.ts` (store resource
   still refetches after `useTrash`).
2. F2 — guard errored reads in `TrashView.tsx`, `history.ts`, `HistoryView.tsx`; component tests.
3. F3 — `QueryFenceView.tsx` guarded `latest`, `describeError`; render-seams test.
4. F4 — generation counter in `usePageHistory.loadMore`; `data/history.test.ts`.
5. F5 — `queries.ts` nested hits only when actually emitted; `queries.test.ts`.
6. F6 — catch in Older changes; `HistoryView` test.
7. F7 — `FindReplaceView` live input + disable while stale/loading; component test.
8. F8 — `VirtualJournalDay` catch + restore draft; its test.
9. e2e: trash, history, query, find-replace (if a spec exists), journal specs on port 6472.
10. Review doc, commit last.

## How to resume

`git log --oneline da85cfb..` shows what landed. Before each commit: `pnpm exec biome check
--write <files>`, `pnpm -r typecheck`, `cd apps/web && pnpm exec vitest run`.
