# Bugs inbox — impl-small (M8)

Entries in `docs/BUGS.md` format, for the coordinator to merge. Numbers B-230..B-239 are this
branch's. The audit items these come from are `docs/review/2026-09-12-exposure-audit.md` §2.

---

### B-230 · A block's created/edited time is stored but shown nowhere
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §1.1 ("Block
timestamps … not rendered anywhere") and §2 #15 · **Test:** `e2e/tests/block-timestamps.spec.ts`,
`apps/web/src/app/block-times.test.ts`

Every block row carries `created_at` and `updated_at` in both the server and the client replica
(`BlockRow.createdAt/updatedAt`), but no surface renders them: right-clicking a bullet lists
commands only, and there is no tooltip. "Block Timestamps" has 46 votes on the Logseq forum
(research/13 §3.1).

**Fixed 2026-09-13.** The block context menu ends in a muted, non-clickable line — "Created today
14:03", plus "· Edited 5 minutes ago" once the text changed after creation — with the exact local
times as its tooltip (`app/BlockTimestamps.tsx`, `app/block-times.ts`, `data/block-times.ts`;
one-line hookup in `app/BlockContextMenu.tsx`). Wording reuses `views/historyText.ts#formatWhen`.
Caveats written into `block-times.ts`: an imported block's "Created" is its markdown file's mtime
at import, and "Edited" moves only on a text change (`block.text`), not on marker/collapse/move.
Tests that would have caught it: `e2e/tests/block-timestamps.spec.ts` (both tests; the second
fails with `activeElement is body` when the footer's mousedown guard is removed — checked) and
`apps/web/src/app/block-times.test.ts`.

---

### B-231 · Pressing on a context-menu separator or its padding ends editing while the menu stays open
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-small, while adding B-230 ·
**Test:** none yet

The menu items guard their `mousedown` (B-71), but the menu's other content does not: a press on a
`.ctx-sep` line or on the `.ctx-menu` padding moves focus to `<body>`, which ends editing (B-74),
and the menu's own dismiss listener ignores presses inside the menu, so it stays open over a row
that is no longer being edited. Inferred from the same mechanism the B-230 footer hit (its e2e test
failed with `activeElement is body` without the guard); not separately reproduced on a separator.
Likely fix: `onMouseDown={(e) => e.preventDefault()}` on the `.ctx-menu` container itself in
`app/BlockContextMenu.tsx`, plus an e2e test pressing on a separator.

---

### B-232 · There is no way to search within the page you are on
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §2 #16 · **Test:**
`e2e/tests/page-find.spec.ts`, `apps/web/src/editor/pageFilter.test.ts`

Cmd/Ctrl+F on a page does only what the browser's find does, which cannot see blocks under a
collapsed parent (they are not in the DOM) and matches the rendered text, not what was typed.
"Search inside … page with Ctrl+F" has 78 votes on the Logseq forum (research/13 §3.1) and is done
in Logseq.

**Fixed 2026-09-13.** Cmd/Ctrl+F on a page (`search.findInPage`, `when: pageView` — a new
`WhenContext` key, spec R7 and R44a) opens a find bar above the outline. A non-blank query shows
only matching blocks plus their ancestors, under collapsed parents too, without writing any op;
matches are counted ("1 of 3") and highlighted in the rendered text through the CSS Custom
Highlight API; Enter/Shift+Enter step and scroll; Escape closes and returns the caret to where it
was. Opening the bar ends editing first: without that, Enter typed into the bar split the block
the caret had left ("alpha beta" became "alpha" / " beta" — reproduced by removing the call and
running the e2e test below). On every other view no binding matches, so the browser's find still
opens. Files: `app/page-find.ts`, `views/PageFindBar.tsx` + `page-find.css`,
`editor/pageFilter.ts`, `commands/registrations/page-find.ts`, `requestEditingEnd` and a caret on
`requestBlockFocus` in `editor/focus-request.ts`; hookups in `BlockTree.tsx` (`filter` /
`onFilterMatches` props, a focus request for a row that is not rendered is dropped instead of
editing an invisible row), `BlockRowView.tsx` (match/context classes), `PageView.tsx`,
`CommandLayer.tsx`, `editor-host.ts`, `commands/types.ts`, `registrations/index.ts`.
Tests that would have caught it: `e2e/tests/page-find.spec.ts` (6 tests; with `when: "true"` the
"left to the browser" test fails, and without `requestEditingEnd` the two editing tests fail —
both checked), `apps/web/src/editor/pageFilter.test.ts`, `apps/web/src/app/page-find.test.ts`.
Measured on the owner's biggest page (`OmnivoreSync`: 961 blocks, 1.69 MB, graph copy of
2026-09-13) with `tools/probes/page-find-perf.ts`: the first version folded text per character
and took 21-51 ms per `filterVisible` call and 670-890 ms for the highlight pass's `findRanges` —
per keystroke. After caching folded text per block object and folding only non-ASCII runs per
character: 0.2-1.5 ms and 12-17 ms. Highlights are capped at 2,000 occurrences ("r" matches 78,604
times there; spreading that many ranges into `new Highlight(...)` would overflow the argument
limit); every matching block is still shown and counted. In Chromium against `nooklet serve` on
the same graph copy (production build): typing "r", "e", "k", "a" into the bar on OmnivoreSync took
249/67/132/33 ms per keystroke to count and paint (917 rows rendered for "r"), Escape restored the
57 rows the page shows collapsed.

**Verification follow-up, 2026-09-13 (second agent, adversarial pass).** Numbers B-230..B-239 are
all taken, so what the pass found in this feature is recorded here rather than under new numbers.
- *Fixed:* with the filter on, Backspace at the start of a match merged it into the previous row ON
  SCREEN, which can be many hidden blocks away — "keep me" / "hidden one" / "hidden two" / "keep
  too" became "keep mekeep too" / "hidden one" / "hidden two" (text moved above blocks it never
  touched); Delete at the end did the same forwards. Merges now use the unfiltered reading order
  (`BlockTree.tsx#outlineOrder`). Test: `page-find.spec.ts` "under a filter, Backspace and Delete
  join a block with its neighbour on the page, not the next match" (failed before the fix with the
  merged text above the hidden blocks).
- *Fixed:* clicking the bar's close button while typing in a match (not the block the bar was
  opened from) sent the caret back to the opening block. Two causes: the click-away handler (B-74)
  ended the edit on a press on the bar's buttons, and close always restored the opening caret. The
  buttons are now exempt from click-away (they already keep focus with a mousedown guard) and close
  restores only when the keyboard is in the bar. Test: `page-find.spec.ts` "closing the bar with
  its button leaves the caret in the block being edited" (failed before: caret in row 0, not 2).
- *Open:* Cmd/Ctrl+F while the palette is open over a page opens the bar behind the palette and
  moves focus into the bar's input; the palette stays on screen. `when: pageView` has no way to say
  "no modal open" (there is no palette when-key). Probe only, no test.
- *Open:* select-all (Cmd/Ctrl+A in selection mode) under a filter selects the context ancestors
  too; deleting the selection then deletes those ancestors' hidden, non-matching children — the
  same subtree semantics as deleting a collapsed parent, but nothing on screen shows them. Undo
  restores. Probe only: page "parent ctx / match kid / hidden kid / other hidden / match two",
  filter "match", select all, Backspace → only "other hidden" left.
- *Open:* Cmd/Ctrl+F while the page title input holds an uncommitted rename commits it on blur,
  the route follows the new name, and the name change closes the bar it just opened — Cmd+F seems
  to do nothing (probe: title "X" appended, Cmd+F → URL `…%20X`, no bar, focus on body).

---

### B-233 · `editing.spec.ts` "Enter creates a second bullet" fails when run right after `a-fresh-journal.spec.ts`
**Status:** open · **Severity:** low (test harness) · **Found:** 2026-09-13, impl-small · **Test:**
the spec itself

`cd e2e && NOOKLET_E2E_PORT=<port> pnpm exec playwright test tests/a-fresh-journal.spec.ts
tests/editing.spec.ts --project=chromium` → "Enter creates a second bullet and both keep their
text" sees 3 rows, not 2. Reproduced on the base commit `da85cfb` (extracted with `git archive`),
so not caused by this branch. All specs share ONE server per run (`global-setup.ts` runs once;
`playwright.config.ts`'s comment "Each spec gets its own server" is wrong), `a-fresh-journal`
leaves two blocks in today's journal, and `editing.spec.ts`'s `openJournal` only seeds a VIRTUAL
day. Presumably passes in the full suite only because of what the specs between them do — not
checked. Fix: give that test its own page (as the next test in the file already does).

---

### B-234 · A page cannot be locked against accidental edits
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §2 #17 · **Test:**
`e2e/tests/read-only.spec.ts`, `apps/web/src/editor/readOnly.test.ts`

"Lock a page as read-only" has 69 votes on the Logseq forum (research/13 §3.1). A reference page
(a checklist template, an imported article) is one stray click and keystroke away from being
changed. `BlockTree` has had a `readOnly` prop since M1, but nothing sets it and it does not cover
the marker click, block selection, or commands that write through the store.

**Fixed 2026-09-13.** `read-only:: true` on a page (only the value `true`) locks it in every
`BlockTree` that shows it — the page view and the journal stream alike, because the tree reads the
page's property itself: no edit mode (click, Enter, focus requests), no block selection, and the
task-marker click, drag and swipe refuse with a toast ("This page is read-only. Remove
read-only:: true from its properties to edit it."). The title input goes `readonly` and a
"Read-only" badge sits in the title row. Collapsing, mouse text selection (the rendered view no
longer cancels the drag on a locked page) and the properties panel stay usable. Locking while a
block is being edited ends the edit and keeps what was typed; unlocking takes effect on the open
page. UI-only by design, written into `docs/spec/markdown-grammar.md` OUT-21a: the API still writes
(a test proves it). Blocking selection is load-bearing: with that one guard removed, a Cmd/Ctrl+
click selection let Tab indent, Backspace delete and Cmd/Ctrl+Enter cycle the marker through the
store (probe run 2026-09-13). Files: `editor/readOnly.ts` (+test), `editor/ReadOnlyNotice.tsx`,
`editor/read-only.css`; hookups in `BlockTree.tsx` (the unused `readOnly` prop now also follows the
property), `BlockRowView.tsx`, `PageView.tsx`. Tests that would have caught it:
`e2e/tests/read-only.spec.ts` (6 tests), `apps/web/src/editor/readOnly.test.ts`. Not covered by a
test: the drag (long-press) and swipe refusals — touch gestures, guarded in the same functions as
the keyboard moves but not driven in a browser.

**Verification follow-up, 2026-09-13 (second agent).** *Fixed:* in the journal stream, a block
selection standing in an unlocked day survived a right-click on a locked day's block (a locked
block takes no caret, so the command context stayed with the other tree), and the menu over the
locked block listed Zoom in, Cycle task state, Move, Duplicate, Delete, Turn into page and Move to
page — all aimed at the other day's selected block. A right-click on a locked block now releases
every tree's editing/selection (`requestEditingEnd`) before the menu opens, so it shows only the
timestamps. Test: `read-only.spec.ts` "right-clicking a locked block offers no command aimed at a
selection in another day" (failed before: 9 items).

---

### B-235 · `page.create` with markdown silently drops a page-properties pre-block
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-small (seeding a locked page) ·
**Test:** none yet

`POST /api/v1/page.create {"name": "X", "markdown": "read-only:: true\n\n- a\n- b"}` creates the
page and both blocks, but no `read-only` page property — the pre-block is neither applied nor
reported. Seen in `e2e/tests/read-only.spec.ts`'s first draft (the page rendered 3 rows, no lock).
`prepareMarkdownInsert` (`packages/server/src/ops/outline-bridge.ts`) calls `parseMarkdownBlocks`,
which by its name takes blocks only; not traced further. An agent that writes outline markdown the
way the mirror does loses its page properties without an error. `page.append` goes through the
same function — presumably the same, not checked. Fix: apply the pre-block's properties as
`page.prop` ops (create), or reject/warn when markdown carries one.

---

### B-236 · `page.update` refuses to set properties on a journal day ("cannot rename a journal day")
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, impl-small · **Test:** none yet

`POST /api/v1/page.update {"page": "<ISO day>", "properties": {"read-only": "true"}}` → 400
`{"code":"invalid","message":"cannot rename a journal day"}` although no `new_name` was given.
`packages/server/src/ops/page-update.ts` throws for any journal page before looking at what was
asked. So an agent cannot favourite, give an icon to, or lock a journal day, while a person can (the
properties panel writes `page.prop` locally). Fix: move the journal check inside the
`new_name !== undefined` branch, plus a server test for a properties-only update on a journal.

---

### B-237 · No way to land on a random page
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §2 #18 · **Test:**
`e2e/tests/random-page.spec.ts`, `apps/web/src/commands/registrations/random-page.test.ts`

Rediscovering old notes by jumping to a random page is a common outliner habit; nooklet has no
command for it. The audit records no vote evidence (research/13) and ranks it "only if it is free".

**Fixed 2026-09-13.** `nav.randomPage` ("Open a random page", palette only, no default key; spec
R44b) opens a random live page that is not a journal day and has at least one live block, never
the page on screen. Journals and empty pages are skipped on purpose: in a copy of the owner's graph
825 of 952 pages are journal days and 41 of the other 127 are empty. Files:
`commands/registrations/random-page.ts` (+test), `data/random-page.ts` (+test against the real
client schema through `WorkerDb`; removing either the journal or the has-a-block condition fails
it — checked); two-line hookups in `registrations/index.ts` and `CommandLayer.tsx`. Tests that
would have caught it: `e2e/tests/random-page.spec.ts` (2 tests),
`apps/web/src/commands/registrations/random-page.test.ts`, `apps/web/src/data/random-page.test.ts`.

---

### B-238 · `search` with `properties: {"marker": "TODO"}` never matches anything
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-small (wiring the Search view's
marker filter, audit §2 #11) · **Test:** `packages/server/src/ops/search-filters.test.ts`

The `search` op's description (and so its MCP tool) offers `properties` as "exact key=value
filters, e.g. `{"marker":"TODO"}`", but the filter only looks in `block_prop`, and a task marker is
stored in the `block.marker` column (ADR 011's reserved keys) — never as a `block_prop` row. In a
copy of the owner's graph `block_prop` has no `marker`, `priority`, `scheduled`, `deadline`,
`repeat` or `done` rows at all, while 686 blocks carry a marker. So every marker or priority filter
silently returns zero hits. Reproduced by the new test before the fix (2 of 3 failing with `[]`).

**Fixed 2026-09-13.** `packages/server/src/ops/search.ts` maps `marker`, `priority` and `repeat` in
`properties` to the `block` columns; other keys still match `block_prop`. `scheduled`, `deadline`
and `done` (day number / time / epoch ms in their columns) are NOT mapped and still match nothing
through `properties` — written into `docs/spec/mcp-tools.md` beside the op, not fixed. Tests that
would have caught it: `packages/server/src/ops/search-filters.test.ts` (failed 2 of 3 before) and
`e2e/tests/search-filters.spec.ts` (its marker test fails with "0 results" when the mapping is
removed — checked). On a fresh copy of the owner's graph served by `nooklet serve`: keyword "a",
blocks, `properties: {marker: "LATER"}` → 8 hits; with `journals_only` → 5.

**Verification follow-up, 2026-09-13 (second agent).**
- *Fixed:* `properties: {"constructor": "x"}` → 500 `near "Object": syntax error`. `constructor`
  passes the key schema (`^[a-z][a-z0-9-]*$`) and `TEXT_COLUMN_PROPS[k]` returned
  `Object.prototype.constructor`, which was spliced into the SQL as a column name. Now
  `Object.hasOwn`. Test: `packages/server/src/ops/search-filters.test.ts` "a key that names an
  Object.prototype member is a property filter, not a column" (failed before with the 500).
- *Open, pre-existing (not this branch):* the same mistake in `packages/core/src/outline.ts`
  `normalizePropertyKey` (`PROPERTY_KEY_REMAP[lower] ?? …`): a block property `constructor:: Stavby`
  is stored and mirrored as `function Object() { [native code] }:: Stavby` (seen through
  `page.create` + `page.read` in a server-test probe); `__proto__::` presumably becomes
  `[object Object]::`, not checked. An imported Logseq graph with such a key would be rewritten.
  Likely fix: `Object.hasOwn(PROPERTY_KEY_REMAP, lower)`, plus a core parser test.

---

### B-239 · The Search view cannot filter by task marker, journals, or pages vs blocks
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §1.1 (`search`:
"`scope`, `properties` (e.g. `marker`), `pages`, `journals_only` have no UI") and §2 #11 ·
**Test:** `e2e/tests/search-filters.spec.ts`, `apps/web/src/views/searchFilters.test.ts`,
`apps/web/src/views/SearchView.test.tsx` ("SearchView filters")

"Search operators / filters for the search box" has 83 votes and "Filters for note body" 140
(research/13 §3.1). The op had the filters; the view's Filters panel offered tag, namespace and
dates only.

**Fixed 2026-09-13.** Three controls in the Filters panel: Task (any, or one of the seven markers →
`properties: {marker}`, and blocks only, since page hits ignore the marker filter), Show (blocks
and pages / blocks only / pages only → `scope`; "pages only" is disabled while a marker is chosen)
and Journals only (→ `journals_only`). Mapping in `views/searchFilters.ts`; `properties` added to
the client's `SearchInput` (`data/api-client.ts`); styles in `views/search-filters.css`. The `pages`
filter (restrict to named pages) is still not exposed — the audit's list for #11 did not ask for
it. Depends on the B-238 server fix: before it, the marker filter would have shown "0 results".
Tests named above.

**Verification follow-up, 2026-09-13 (second agent).** *Fixed:* with Show on "Pages only", choosing a
Task marker searched task blocks (right) but Show kept reading "Pages only" — the option disabled
yet still selected — over a list of blocks. Choosing a marker now moves a pages-only Show to
"Blocks only" (`views/searchFilters.ts#withMarker`). Tests: `e2e/tests/search-filters.spec.ts`
"choosing a task marker from pages only shows blocks only, not a pages-only label over tasks"
(failed before: value "pages") and `views/searchFilters.test.ts` "withMarker".
