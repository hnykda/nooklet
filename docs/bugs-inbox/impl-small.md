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
