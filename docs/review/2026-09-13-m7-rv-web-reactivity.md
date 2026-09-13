# Code review — web client reactivity and failure paths (M7 views), 2026-09-13

Part of the M8 review workflow (`docs/progress/coordinator.md`, "Review → skeptic refutes each
finding → fixer per dimension"). A reviewer read the web client for correctness of its reactive
data flow and failure paths; an independent skeptic tried to refute each finding and could not.
This document is the fixer's record: what was found, what was reproduced, what changed, and what
was left. Branch `m8/rv-web-reactivity`, based on `da85cfb`. Bugs are in
`docs/bugs-inbox/rv-web-reactivity.md` (B-130–B-134) for the coordinator to fold into
`docs/BUGS.md`.

## Scope

Dimension: **web client correctness** — does what a view shows track the graph, and does a failure
reach the screen? Weighted to what M7 added (Trash, History, ```query fences, Find & Replace,
journal templates).

Read in full: `apps/web/src/db/{client,db.worker,worker-api}.ts`, `data/{store,history,queries}.ts`,
`views/{TrashView,HistoryView,FindReplaceView,VirtualJournalDay}.tsx`,
`editor/render/QueryFenceView.tsx`; the server's `ops/page-history.ts` for the cursor semantics;
`sync/sync-client.ts#applyLocal` for whether a local write is atomic (it is: one transaction).

Not read line by line: the editor (`BlockTree.tsx`, CodeMirror surface), commands, the shell,
`data/templates.ts` beyond `loadJournalTemplate`'s signature.

Method, per finding: a failing test first (a component or data-layer test over the real module,
only the worker or HTTP call replaced), then the fix, then the test green; where a browser could
drive the failure, an e2e case in the new `e2e/tests/review-reactivity.spec.ts`, and for F1, F4,
F5 and F7 that e2e case was also run against the unfixed source (files temporarily restored from
the parent commit, rebuilt by global-setup) to prove it catches the defect. The reviewer's probes
(`<scratch>/rv-web-reactivity/f1-listener-hijack.probe.ts`, `f2-errored-resources.probe.tsx`,
`f4-history-gap.probe.ts`, `f5-query-nested-cap.probe.ts`) target the main checkout; the tests
below replace them inside the repo.

## Findings, by severity

Line numbers are at `da85cfb`.

| # | Bug | Severity | Where | What |
|---|---|---|---|---|
| F1 | B-130 | high | `data/history.ts:40-53`, `db/client.ts:96-101`, `db/db.worker.ts:144-153`, `data/store.ts:206-217` | The worker holds one change listener and one sync-status listener; `client.ts` forwarded every subscription to that single slot. `history.ts` subscribes on first use of Trash or History, replacing `store.ts`'s listener, which never re-registers: no page tree, journal, sidebar, Tasks, icons, query fence or `((ref))` refreshed again until a reload, and the sync indicator froze. Two `useSyncStatus()` callers (AppShell, DiagnosticsPanel) replaced each other. |
| F2 | B-131 | medium | `views/TrashView.tsx:48,89,93,98`; `data/history.ts:321-322`; `views/HistoryView.tsx:235,238` | Reading an errored Solid resource re-throws; both views read theirs unguarded, so a failed `trash.list`/`page.history` stayed on "Loading…" with an unhandled rejection, and the error line with Retry never rendered. |
| F3 | B-131 | medium | `editor/render/QueryFenceView.tsx:172,183` | `results.latest` re-throws on error, so a rejected evaluation sat on "Running query…"; "Query failed" could never render. |
| F4 | B-132 | medium | `data/history.ts:311-337`; `views/HistoryView.tsx:167` | A first-page refresh landing while "Older changes" was in flight let the stale older page append under the new first page; the seq-based cursor left a hole, and Restore this version skipped undoing the hidden batches. |
| F5 | B-133 | medium | `data/queries.ts:211-215,271-320` | A hit anywhere in an ancestor hit's depth-3 subtree was folded under it, but only 60 descendants render: a TODO subtask after 60 notes under a TODO project was counted and shown nowhere. |
| F6 | B-131 | low | `views/HistoryView.tsx:287`; `data/history.ts:324-337` | A failed "Older changes" re-enabled the button silently (no catch, promise discarded). |
| F7 | B-134 | low | `views/FindReplaceView.tsx:83-98,106,145-148` | Replace all sent the 250 ms-debounced input, and stayed enabled on the old preview while the new one loaded: an edit just before the click was not what got written. |
| F8 | B-131 | low | `views/VirtualJournalDay.tsx:79-125,152,156` | The draft textarea was swapped out before loading the template, the clock and writing; a failure in any of them lost the typed line and left an empty outline for a page that did not exist. |

B-131 carries four findings because this branch had five bug numbers; they share what you see (a
failure that never reaches the screen), which is how `docs/BUGS.md` groups entries.

All eight reproduced. None was refuted.

## Changes

One commit per finding, each with its failing-then-passing tests, the inbox entry and this branch's
progress file:

1. `b75e571` docs: B-130–B-134 logged before any fix.
2. `cdaf63c` **F1 / B-130** — `db/client.ts` registers one Comlink proxy per listener kind and fans
   out to a subscriber set; `onChange`/`onSyncStatus` return an unsubscribe; a throwing subscriber
   is logged and does not starve the rest; `useSyncStatus` unsubscribes on cleanup. Comments in
   `store.ts`, `history.ts` and `worker-api.ts` that said "a second module must not subscribe"
   now say why it is safe. Tests: `db/client.test.ts` (5, over `db/fake-worker.ts`, a
   single-slot fake of the worker), `data/history.test.ts` (3, real `client.ts` + `store.ts` +
   `history.ts`), e2e "after visiting Trash, an open page still picks up a write made elsewhere".
3. `918c0ff` **F2** — `TrashView`'s `list()` and `usePageHistory`'s new `firstPage()` guard every
   read; error lines use `describeError`. Tests: `views/TrashView.test.tsx`,
   `views/HistoryView.test.tsx`, two e2e cases (`page.route` aborts, then Retry).
4. `8651877` **F3** — `QueryFenceView` reads a guarded `latest()`; "Running query…" only without an
   error; `describeError` for the reason. Test: `editor/render/QueryFenceView.test.tsx` (real
   `useQueryResults`, rejecting `queryAs`).
5. `e5a19dc` **F4 / B-132** — a generation counter in `usePageHistory`, bumped when a first page
   lands; a `loadMore` that straddled it drops its answer. Tests: `data/history.test.ts` (server
   model with held responses), e2e case holding the cursor request with `page.route` and writing
   two batches meanwhile — unfixed: two batch ids missing; fixed: all 33 in order.
6. `b7a2b3f` **F5 / B-133** — `toResultBlock` reports what it emitted; hits no rendered subtree
   emitted are listed on their own, outermost first, so nothing is lost or listed twice. Tests: two
   cases in `data/queries.test.ts`, one e2e case (70 notes, then the subtask).
7. `4837d25` **F6** — `HistoryView#loadOlder` catches and shows the reason. Tests: a
   `HistoryView.test.tsx` case, one e2e case.
8. `0294865` **F7 / B-134** — Replace all sends the live fields and is disabled until the preview
   for exactly those fields has landed. Tests: `views/FindReplaceView.test.tsx` (3), one e2e case —
   unfixed: "the wombat smiles" written after typing "numbat"; fixed: "the numbat smiles".
9. `1248892` **F8** — `materialize` catches, restores the placeholder with the draft, clears its
   caret request and shows "Could not start this day: …"; the next blur or Enter retries. Tests: two
   `VirtualJournalDay.test.tsx` cases.

### Verification

- `pnpm -r typecheck`: clean at every commit.
- `apps/web` unit suite: 692 tests at the first fix's commit → **704 passed** at HEAD (78 files).
  One run mid-way (F4, load average 44) had 3 timing failures in files this branch does not touch
  (`page-title.test.ts` 5 s timeout; two `render-seams.test.tsx` query-fence cases whose `waitFor`
  gives the first lazy `import()` of `QueryFenceView` 1 s). Rerun alone: pass, fail, pass; every
  later full run passed.
- `pnpm exec biome check`: no diagnostics on the changed files.
- e2e, port 6472, at HEAD: `review-reactivity` (7) + `trash`, `history`, `query`, `replace`,
  `a-fresh-journal`, `journals`, `templates`, `diagnostics`, `references`, `render` — **54/54**.
  After F1, a broader run (`editing`, `pages`, `tasks`, `views`, `navigation`, `page-icons`,
  `shelf`, `refactor`, `link-unlinked`, `graph`, `settings`, `references-filters`, `focus`):
  **127 passed, 1 failed** — see "Found in passing".
- Real graph (a `.backup` copy of the owner's 952-page graph): a probe ran the branch's `runQuery`
  over it (`<scratch>/rv-web-reactivity/rv/f5-real-graph.probe.ts`) for `DONE`, `LATER`, `NOW`,
  `WAITING` and `DONE limit:1000`, before and after F5: identical counts, every shown hit rendered,
  no id rendered twice. `pnpm nooklet verify` was not run: nothing under ops, sync or schema
  changed.

## Found in passing, and left alone

- **`e2e/tests/views.spec.ts:461` "opening the palette while editing and closing it hands focus
  back to the editor" fails at `da85cfb` too.** After Escape the palette is gone and `.cm-content`
  is present but not focused. Three runs: twice on this branch, once with every changed source file
  restored to `da85cfb` — so it is not this branch. It is B-72's regression test. Load was high
  (≈35), so it may be timing, but it failed all three times. Not logged with a number (this branch's
  five are used); flagged for the coordinator.
- **`render-seams.test.tsx`'s query-fence cases are load-sensitive** (above): the first lazy
  `import()` of `QueryFenceView` can take over the 1 s `waitFor` default on a loaded machine.
  F3 added one small import (`data/api-client.js`) to that chunk. Not changed: not this branch's
  test, and every run under normal load passes.
- **`history.ts` keeps its own version counters** rather than using `store.ts`'s `stampedFor`.
  With the fan-out that is correct, and it also bumps on the push queue draining, which
  `stampedFor` does not. Unifying the two is tidier and not a defect.
- **F4's fix costs a click**: when the first page refreshes during a load-more, the older page is
  dropped and the user presses "Older changes" again. The alternative (derive the cursor from the
  last displayed batch and de-duplicate by seq) avoids the extra click but needs the client to
  construct server cursors, which are opaque in the op's contract.
- **`VirtualJournalDay` ignores `ApplyOpsResult.rejected`.** A write the local `applyOps` refuses
  resolves rather than rejects, so F8's catch does not see it. Whether a first-day batch can be
  refused locally (for example a journal page for that day already created on another device and
  not yet pulled) was not examined.

## Still unverified

- **F3 and F8 have no browser test.** Nothing found makes the worker's `query` or `applyLocalOps`
  reject from Playwright; both are covered at the component level over the real resource or
  component, with the worker call replaced.
- **The sync-status fan-out in a browser.** The change-event half of F1 is e2e-tested; the status
  half (AppShell's indicator staying live after the Diagnostics panel has been opened) is covered by
  `data/history.test.ts` only.
- **F1's claim about `((ref))` text, Tasks and page icons going stale** was reproduced for page trees
  (e2e) and `usePageIcons` (unit); the other consumers share the same listener and were not checked
  one by one.
- **F5 on the owner's graph**: the review said the graph has this shape; the copy checked today has
  no instance of it (686 task markers, no `TODO`s, no hit more than 60 rendered descendants inside
  another hit). The fix is exercised by the fixture tests, not by real data.
