# Bugs inbox — rv-web-reactivity (M8 web-client correctness review)

Entries in `docs/BUGS.md`'s format, to be folded in by the coordinator. The eight review findings
(F1–F8, `docs/review/2026-09-13-m7-rv-web-reactivity.md`) are grouped by what you see, because
this branch has five numbers (B-130–B-134): B-131 collects the four "a failure shows nothing"
findings.

---

### B-130 · After visiting Trash or a page's History, no other view refreshes until a reload
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, web reactivity review (F1) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "after visiting Trash, an open page still picks up
a write made elsewhere (B-130)"; `apps/web/src/db/client.test.ts` "two onChange subscribers both
receive a ChangeEvent" (and four more); `apps/web/src/data/history.test.ts` "a store.ts resource
still refetches on a change after Trash has subscribed", "two useSyncStatus() callers (the shell
and the diagnostics panel) both see a status"

Open `/trash` or any page's History once, then go back to a page and edit, or let another device
write: page trees, the journal stream, the sidebar, Tasks, page icons, ```query fences and `((ref))`
text keep showing the old state until the tab reloads. The sync indicator freezes too, and so does
B-83's backlinks refresh after a push lands. Opening the Diagnostics panel freezes the shell's
sync indicator the same way.

The worker keeps exactly one change listener and one sync-status listener
(`db/db.worker.ts` `changeListener = cb`), and `db/client.ts` forwarded every `onChange` /
`onSyncStatus` call straight to it. `data/history.ts` subscribes on first use, replacing
`data/store.ts`'s listener; `store.ts` never re-registers. `useSyncStatus()` registers once per
call, so AppShell and DiagnosticsPanel replace each other.

**Fixed 2026-09-13.** `db/client.ts` registers one Comlink proxy per listener kind with the worker,
on first use, and fans out to a set of subscribers; `onChange`/`onSyncStatus` return an
unsubscribe, a throwing subscriber is logged and does not starve the others, and `useSyncStatus`
unsubscribes on cleanup. The worker keeps its single slot — `client.ts` is now its only caller.
Reproduced first: the e2e case failed at "after trash" against the unfixed client and passes with
the fix; the `history.test.ts` case failed at the refetch-after-Trash assertion (0 refetches).

---

### B-131 · A failed load shows nothing: Trash and History stay on "Loading…", a query fence on "Running query…"
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, web
reactivity review (F2, F3, F6, F8) · **Tests:** F2 — `e2e/tests/review-reactivity.spec.ts` "a
failed trash load says so and Retry recovers, instead of Loading… forever (B-131)" and "a failed
history load says so…"; `apps/web/src/views/TrashView.test.tsx`, `HistoryView.test.tsx` "shows the
error with Retry instead of Loading…, and Retry recovers". F3 —
`apps/web/src/editor/render/QueryFenceView.test.tsx` 'says "Query failed" with the reason instead
of "Running query…" forever' (unit only: no way found to make the worker's query reject in a real
browser). F6 — `e2e/tests/review-reactivity.spec.ts` "a failed Older changes says so instead of
silently re-enabling the button (B-131)"; `HistoryView.test.tsx` "a failed Older changes says so,
and the button still works afterwards". F8 — `apps/web/src/views/VirtualJournalDay.test.tsx`
"keeps the typed line and says why when the journal template cannot be loaded (B-131)", "keeps the
typed line, drops its caret request, and can try again when the write fails (B-131)" (unit only:
the local worker cannot be made to fail from Playwright)

Four paths where a failure never reaches the screen:

- **Trash / History (F2).** When `trash.list` or `page.history` fails (server unreachable, 401),
  the view stays on "Loading…"; the "Could not load … Retry" line never appears and the error is an
  unhandled rejection. `TrashView` reads `items()` and `usePageHistory` reads `first()` unguarded,
  and reading an errored Solid resource re-throws — the B-10/B-80 lesson, missed in two M7 views.
- **```query fence (F3).** When the evaluation rejects (worker gone, a SQL error) the fence says
  "Running query…" forever; `results.latest` re-throws on error, before `<Show when={results.error}>`
  can render "Query failed".
- **History "Older changes" (F6).** A failed request re-enables the button with no message;
  `loadMore` has no catch and the click handler discards the promise.
- **A new journal day's first line (F8).** `VirtualJournalDay#materialize` swaps the draft
  textarea for the real tree before awaiting the template, the clock and `applyOps`; if any of
  those rejects, the day shows an empty outline for a page that was never written, the typed text
  is gone, and nothing says why.

**Fixed 2026-09-13 — F2 (Trash / History).** Every read of the two resources goes through a guard
that returns `undefined` while the resource is errored: `TrashView`'s `list()`, and
`usePageHistory`'s new `firstPage()` (which `batches`, `hasMore`, `loadMore` and HistoryView's
`when`s read). The error lines render with `describeError`, so a server hint is not lost. The
component tests failed first (stuck on "Loading…", unhandled "could not reach server").

**Fixed 2026-09-13 — F3 (```query fence).** `QueryFenceView` reads `results.latest` through a guard
that returns `undefined` while the resource is errored; "Running query…" shows only while there is
no error, and "Query failed:" renders `describeError(results.error)` (no "Error: " prefix). The
component test ran the real `useQueryResults` over a rejecting `queryAs` and failed first
("Running query…", unhandled "worker gone").

**Fixed 2026-09-13 — F6 (Older changes).** The button calls `HistoryView#loadOlder`, which catches
and shows "Could not load older changes: <reason>" in the view's alert line; the button is
re-enabled and a second click retries. `loadMore` itself still rejects, so any other caller can
tell a failure from "nothing older". The component test failed first (no alert, unhandled
rejection).

**Fixed 2026-09-13 — F8 (new journal day).** `materialize` wraps loading the template, the clock
and `applyOps` in one try; on failure it clears the caret request it made, puts the placeholder back
(`draft()` still holds the text) and shows "Could not start this day: <reason>" under it. The next
blur or Enter tries again. `SyncClient.applyLocal` is one transaction, so a failure there leaves
nothing half-written. The component tests failed first (no alert, textarea gone, unhandled
rejection).

---

### B-132 · A page's History skips changes when the graph changes during "Older changes", and Restore skips them too
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, web reactivity review (F4) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "History lists every batch when the graph changes
while Older changes is loading (B-132)"; `apps/web/src/data/history.test.ts` "a refresh that lands
while an older page is in flight leaves no hole in the timeline"

Click "Older changes" while an agent or another device writes anything: the timeline can come back
with a hole (reviewer's model: `32,31,30,29,28` then `25,24,…` — 27 and 26 never shown, and later
"Older changes" clicks continue below the hole). "Restore this version" below the hole undoes only
the batches it lists, so it skips the hidden ones and still reports "Restored".

`usePageHistory`'s first page refetches on any change and clears the appended pages when it
resolves; an in-flight `loadMore` then appends its page (fetched from the old cursor) on top of the
new first page. The server cursor is "older than seq X", so the k batches between the new first
page's end and the old cursor are lost.

**Fixed 2026-09-13.** `usePageHistory` keeps a generation counter, bumped when a first page lands
(the moment the appended pages are dropped); `loadMore` captures it before its request and drops
its answer if it changed, so the next click pages on from the new first page. Reproduced first in a
real browser: the e2e case holds the cursor request with `page.route`, appends two batches through
the API, lets the refresh land, then releases — against the unfixed client the listed batch ids
were missing exactly the two between the new first page and the old cursor; with the fix all 33
are listed in order. The unit case failed with `gaps = [27, 26]`.

---

### B-133 · A ```query hit nested more than 60 blocks deep into another hit is counted but not shown
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, web reactivity review (F5) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "a query hit nested past the 60 rendered
descendants of another hit is still shown (B-133)"; `apps/web/src/data/queries.test.ts` "lists a
nested hit on its own when its ancestor's rendered subtree was cut before it", "a cut-off hit
brings its own nested hits back with it, each listed once"

A `TODO` project block with 70 child notes and then a `TODO` subtask: the fence header says
"2 blocks on 1 page" but only the project and its first 60 descendants render — the subtask is
nowhere. `runQuery` folds a hit under its ancestor hit whenever it is anywhere in the ancestor's
depth-3 subtree, but `toResultBlock` stops emitting after `QUERY_CHILD_CAP` (60) descendants.

**Fixed 2026-09-13.** `toResultBlock` records every descendant it actually emits; `runQuery`
renders the outermost hits first, then lists on its own any shown hit none of them emitted
(outermost of those first, so a promoted hit's own nested hits stay folded under it and nothing is
listed twice). `nested` now counts hits that are really rendered nested. Both the unit case and the
e2e case failed first (the subtask absent). On a copy of the owner's graph (952 pages, 686 task
markers, no `TODO`s — it uses LATER/NOW/DONE) the shape does not occur today: `DONE`, `LATER`,
`NOW`, `WAITING` and `DONE limit:1000` give identical counts before and after, nothing missing,
no id rendered twice.

---

### B-134 · Replace all can write a replacement or flags other than what the fields show
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, web reactivity review (F7) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "Replace all pressed right after editing the
replacement writes the edited text (B-134)"; `apps/web/src/views/FindReplaceView.test.tsx` "does
not write the debounced replacement when the field changed a moment ago", "does not write a flag
the preview on screen was not computed with", "is disabled while the preview for the current
fields is still loading"

Change the replacement text (or flip Regex / Match case) and press Replace all within 250 ms: the
old replacement or flags are written. Likewise while the new preview is still loading, the button
stays enabled on the old preview's matches. `replaceAll()` sends the debounced `input()` and
`canReplace` ignores `preview.loading` — against the page's promise that the preview is exactly
what the real run writes.

**Fixed 2026-09-13.** `replaceAll` builds its request from the live fields, and `canReplace` —
which `replaceAll` also checks — requires the debounced input to equal the live fields and the
preview not to be loading, so the button is disabled from the edit until the matching preview is on
screen. Reproduced first in a real browser: fill "wombat", wait for its preview, fill "numbat" and
click at once — the unfixed page wrote "the wombat smiles"; with the fix Playwright's click waits
for the button to re-enable and "the numbat smiles" is written.
