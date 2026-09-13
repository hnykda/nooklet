# Bugs inbox — qafix-views (M8 exploratory QA of the M7 views, real graph)

Entries in `docs/BUGS.md` format, to be merged there by the coordinator. Numbers B-250..B-259.

---

### B-250 · Replace all wrote the replacement from before the last 250 ms of typing
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q1) · **Test:** `e2e/tests/replace-stale.spec.ts`

On `/replace`, type a query and wait for the preview, then type a replacement and click Replace all
straight away. The outcome line says "Replaced 19 occurrences in 19 blocks." and the field shows
"Hloubětín (Praha 9)", but every block got the match replaced with the empty string — the
replacement from before the last keystrokes. `líbí se jí Hloubětín, líbilo by…` became
`líbí se jí , líbilo by…`. Undo restored it. Replace all also stayed enabled while the preview for
a new query was still loading.

**Fixed 2026-09-13.** Replace all is built from the live fields, and is enabled only when the
preview on screen was computed for exactly those fields and is not reloading. The debounced preview
remembers which input it answers. `e2e/tests/replace-stale.spec.ts` — both tests failed before
(the first read back `líbí se jí , líbilo by`; the second found the button enabled mid-typing).

---

### B-251 · History's Restore this version (and Undo) overwrote later edits, on other pages too
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q2) · **Test:** `e2e/tests/history-later-edits.spec.ts`,
`packages/server/src/ops/batch-undo-later-edits.http.test.ts`

Pages A `- word <tag>` and B `- other <tag>`; a `graph.replace` of `<tag>` (one batch over both)
and its undo; then A's block edited to "A: important later edit". On `/history/B`, Restore this
version on the "page created" batch: A's block went back to `word <tag>` — the later edit was gone,
and the only warning was "A change that also touched another page is undone there too." On the
real graph the same walk re-applied old before-images to all 835 blocks a graph-wide replace had
touched, undoing a page merge's 19 `[[Alex]]` → `[[@Alex]]` rewrites and a Turn-into-page link,
and orphaning the page Turn into page had made. Undo of one old batch did the same to its own
blocks. `nooklet verify` stayed OK: the op log was consistent, the loss semantic.

Cause: `batch.undo` writes every before-image last-writer-wins by design (ADR 013), and the
History view's walk calls it once per newer batch, so each step overwrote whatever any other batch
had written to those blocks since.

**Fixed 2026-09-13.** `batch.undo` gains `keep_later_edits` (default false, so the agent-facing
behaviour ADR 013 chose is unchanged) and `ignore_batches`. With `keep_later_edits`, a field that
another batch changed after the one being undone is left as it is now — per field, so a later
collapse does not block restoring the text — and a block the batch created is not deleted if
another batch edited it since; what was left alone comes back in `kept` with its page. A walk
passes its own batches and the undo batches it has made so far as `ignore_batches`, so its own
steps do not count as "later edits". The History view uses both for Undo and for Restore, says in
the confirm that later edits on other pages are kept, and lists what was kept (and where) in the
status line. Tests: `e2e/tests/history-later-edits.spec.ts` (both failed before: A read back
`word zqxhistlater`; Undo reported plain "Undone.") and
`packages/server/src/ops/batch-undo-later-edits.http.test.ts`.

---

### B-252 · `block.update` with `old_str`/`new_str` fails on any block that has a property
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, in passing while writing the B-251
tests · **Test:** none yet

`page.create` `- one`, `block.update {content: "two", properties: {status: "draft"}}`, then
`block.update {old_str: "two", new_str: "two, edited later"}` answers 400 `content must describe
exactly one block`. The same happens after `content: "DONE two"` (the `done::` property). Seen in
a vitest run against `makeTestServer`; not yet reduced further.

Likely cause, unverified: `outline-bridge.ts#renderSingleBlockText` strips the two-space indent
from the property lines, and `parseSingleBlockGrammar` re-parses the replaced text as
`- two, edited later\nstatus:: draft`, where the unindented property line is a second block.
Agents editing any block with properties (every DONE task, 700 on the owner's graph) by
`old_str` hit this.

---

### B-253 · The references panel showed the first 200 linked and 50 unlinked references as if that were all
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q3) · **Test:** `e2e/tests/references-cap.spec.ts`,
`packages/server/src/ops/page-backlinks-totals.http.test.ts`

On `/page/CAMP` the linked heading said 200 (`page.backlinks` paged to the end: 836; "task" 1074,
"@Alex" 816) and the unlinked heading said 50, yet Link all reported "Linked 187 mention(s); left 2
alone". The filter's options and counts came from the first 200 rows only, so a filter could say
"No references match" while matches sat further down. No truncation indicator, no load-more.

Cause: the client asked `page.backlinks` for `limit: 200` and never followed `cursor`; the server
capped unlinked mentions at 50 with nothing in the response saying so, while `mentions.link`
works on up to 500.

**Fixed 2026-09-13.** The client follows the cursor (500 per request, up to 5,000 linked
references, with the heading saying "5000+" beyond that). `page.backlinks` takes
`unlinked_limit` (default 50, so agents' payloads are unchanged; the panel asks for 500, the same
ceiling `mentions.link` rewrites) and reports `unlinked_truncated` and `linked_total`. Counts and
filters cover everything fetched; the panel renders 200 rows at a time with a "Show more" button,
since every row re-renders when the graph changes. `e2e/tests/references-cap.spec.ts` — failed
before on the heading (200, expected 205); `packages/server/src/ops/page-backlinks-totals.http.test.ts`.
Real graph copy: CAMP heading 836 (API paged: 836), unlinked 189 = the 187 Link all would link +
2 it skips; @Alex 756 / 465; 200 rows rendered with "Show 200 more"; no console errors.

---

### B-254 · Turn into page kept heading markers and link brackets in the new page's name
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q4) · **Test:** `packages/server/src/ops/block-to-page-name.test.ts`

On Megapage, Turn into page on `## Plánování zahradních úprav` (3 children) created a new
page named `## Plánování zahradních úprav` and left the block as
`[[## Plánování zahradních úprav]]` — although a page `Plánování zahradních úprav` already
existed and should have received the children. `[[Alex]] by chtěl něco jako:` likewise made a
page with that literal name and the block `[[[[Alex]] by chtěl něco jako:]]`.

Cause: `block.to_page` named the page after the raw trimmed first line; only a line that was
exactly one `[[link]]` was special-cased.

**Fixed 2026-09-13.** The name is the first line's text: a leading `#`–`######` heading marker is
dropped (and stays on the block, so `## [[Plánování zahradních úprav]]` is still a heading in
the page's outline), and inline `[[Page]]` / `[[Page|label]]` links are reduced to the text they
show. The existing sole-link rule is applied after the heading marker comes off.
`packages/server/src/ops/block-to-page-name.test.ts` — failed before with the page named
`## Plánování zahradních úprav`.

---

### B-255 · Restoring a trashed page whose name is taken was a dead end in the Trash view
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q5) · **Test:** `e2e/tests/trash-conflict.spec.ts`

Delete `@Sam Example` (4 blocks) through the API, create a new `@Sam Example`, open `/trash`
and click Restore on the deleted row: "Could not restore: a live page is already named
"@Sam Example"" and nothing else — no way to restore under another name, although
`trash.restore` takes `new_name` and its 409 hint says to pass it. The row stayed; the only way
out was to leave, rename or delete the other page, and come back.

**Fixed 2026-09-13.** A `conflict` on a page restore opens a small form on that row: the server's
message, a name field prefilled with "<name> (restored)", Restore under this name (which passes
`new_name`), and Cancel. A second conflict (the new name is taken too) says so in the same form.
`restoreFromTrash` takes the name. The name lives in the view, and unchanged trash rows keep
their objects across refetches: the first version of the fix kept the name in the form, and the
test caught a refetch (from a page created meanwhile) rebuilding the row and restoring under the
suggestion instead of the typed name. `e2e/tests/trash-conflict.spec.ts` — failed before: no form.
Real graph copy: `@Sam Example` (4 blocks) restored as `@Sam Example (restored)` from the
form, content identical, the new live page untouched.
Not changed: two trash rows with the same title are still told apart by block count and deletion
time only.

---

### B-256 · Restoring a merged page from the trash took its name back from the merge target's alias
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA on the real graph
(finding Q6) · **Test:** `packages/server/src/ops/trash-restore-alias.http.test.ts`,
`e2e/tests/trash-conflict.spec.ts`

Merge `Alex` into `@Alex` (19 links rewritten, `alias:: Alex` on `@Alex`), then Restore the `Alex`
row in `/trash`: "Restored "Alex"." `page.read Alex` now returns the empty restored page while
`@Alex` still lists `Alex` as an alias, and since a page's own key wins over an alias, every
`[[Alex]]` link goes to the empty page instead of `@Alex`.

Cause: `trash.restore` checked the restored name against live pages' keys only
(`livePageWithKey`), not against `page_alias`.

**Fixed 2026-09-13.** A name that a live page (other than the one being restored) uses as an
alias is a `conflict` too, for the page's own name and for `new_name`: "a live page, "@Alex", uses
"Alex" as an alias", with a hint to restore under another name or remove the alias. The Trash
view's rename form (B-255) shows it like any other name conflict.
`trash-restore-alias.http.test.ts` failed before (200, restored as "Alex"); the e2e alias case in
`trash-conflict.spec.ts` covers the form. Real graph copy: after merging Alex into @Alex, restoring
Alex answers 409 with that message, `page.read Alex` still gives @Alex, and `new_name: "Alex
(restored)"` succeeds; verify OK (20,434 ops).

Not changed, for the owner: `page.create` does not check aliases either — creating a page named
like another page's alias silently takes that name's links over. Same shape, but a deliberate
create is arguably what the user asked for; left as it is.
