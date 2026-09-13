# Bugs inbox — rv-web-reactivity (M8 web-client correctness review)

Entries in `docs/BUGS.md`'s format, to be folded in by the coordinator. The eight review findings
(F1–F8, `docs/review/2026-09-13-m7-rv-web-reactivity.md`) are grouped by what you see, because
this branch has five numbers (B-130–B-134): B-131 collects the four "a failure shows nothing"
findings.

---

### B-130 · After visiting Trash or a page's History, no other view refreshes until a reload
**Status:** open · **Severity:** high · **Found:** 2026-09-13, web reactivity review (F1) ·
**Test:** none yet

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

---

### B-131 · A failed load shows nothing: Trash and History stay on "Loading…", a query fence on "Running query…"
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, web reactivity review (F2, F3,
F6, F8) · **Test:** none yet

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

---

### B-132 · A page's History skips changes when the graph changes during "Older changes", and Restore skips them too
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, web reactivity review (F4) ·
**Test:** none yet

Click "Older changes" while an agent or another device writes anything: the timeline can come back
with a hole (reviewer's model: `32,31,30,29,28` then `25,24,…` — 27 and 26 never shown, and later
"Older changes" clicks continue below the hole). "Restore this version" below the hole undoes only
the batches it lists, so it skips the hidden ones and still reports "Restored".

`usePageHistory`'s first page refetches on any change and clears the appended pages when it
resolves; an in-flight `loadMore` then appends its page (fetched from the old cursor) on top of the
new first page. The server cursor is "older than seq X", so the k batches between the new first
page's end and the old cursor are lost.

---

### B-133 · A ```query hit nested more than 60 blocks deep into another hit is counted but not shown
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, web reactivity review (F5) ·
**Test:** none yet

A `TODO` project block with 70 child notes and then a `TODO` subtask: the fence header says
"2 blocks on 1 page" but only the project and its first 60 descendants render — the subtask is
nowhere. `runQuery` folds a hit under its ancestor hit whenever it is anywhere in the ancestor's
depth-3 subtree, but `toResultBlock` stops emitting after `QUERY_CHILD_CAP` (60) descendants.

---

### B-134 · Replace all can write a replacement or flags other than what the fields show
**Status:** open · **Severity:** low · **Found:** 2026-09-13, web reactivity review (F7) ·
**Test:** none yet

Change the replacement text (or flip Regex / Match case) and press Replace all within 250 ms: the
old replacement or flags are written. Likewise while the new preview is still loading, the button
stays enabled on the old preview's matches. `replaceAll()` sends the debounced `input()` and
`canReplace` ignores `preview.loading` — against the page's promise that the preview is exactly
what the real run writes.
