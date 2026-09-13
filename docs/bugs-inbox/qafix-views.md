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
