# Bugs inbox — qafix-render-sync

Entries for `docs/BUGS.md`, kept here so a dozen parallel branches do not conflict on it. Format
matches BUGS.md. All nine came from exploratory QA on a copy of the owner's real graph
(`nooklet serve` on 6452, runs A and B; scripts in the QA scratchpad `qa-render-sync/`), and were
logged here before any fix started.

---

### B-260 · The live mirror never picks up renames, moves, marker, indent or property changes
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q1) · **Test:**
`e2e/tests/mirror-live.spec.ts` (3 tests), `packages/server/src/mirror/live.test.ts` "follows a
rename…", "follows page and block properties, markers and indentation", "follows a block moved to
another page…", `packages/server/src/mirror/export.test.ts` "exportAll with sinceSeq (B-260)"

While `nooklet serve` runs, only block text edits, creates and deletes reach `pages/`. Rename a
page (title input or `page.update new_name`) and the old file stays while no new file appears
(polled 8 s). Set a page property (`qaprop:: hello`) or a block property (`status:: x`), choose a
journal template in Settings (`journal-template:: true`), indent a block with Tab or cycle its
marker with Cmd/Ctrl+Enter: none of it shows up in the file. The stored page read
`- one\n  - two\n- three`; the mirror still had `- one\n- two\n- LATER three`. A full
`nooklet export` of a copy of the same DB wrote the right files and `nooklet verify` passed, so
the data is right and only the live mirror is stale. B-95's fix note says the sweep "moves renamed
ones" — true of `exportPage`, but the sweep never offers it the page.

**Fixed 2026-09-13.** The sweep chose pages whose `page.updated_at` or newest `block.updated_at`
was later than `mirror_file.written_at`, and in `core/sync/apply-ops.ts` only `block.text` moves
`updated_at` — rename, `page.prop`, `block.prop` (marker, priority, collapsed, reserved columns)
and `block.place` never did, and a block moved off a page leaves nothing on that page to compare.
Bumping `updated_at` in the reducer was rejected: it would change `if_version` and "recently
updated" semantics for every client and still miss the page a block left. The mirror now follows
the `changes` table instead (`mirror/export.ts#pagesTouchedSince`): a page row written after the
cursor, or any page a written block was on before or after. The cursor is a `changes.seq`, not a
clock, so a commit in the same millisecond as the previous sweep cannot be lost. The first sweep
after `serve` starts renders every live page (952 pages on the real graph: ~200 ms cold, ~85 ms
warm with nothing to write), which catches up writes made while the server was down and repairs a
mirror an older build left stale. Real graph: renaming `Alex/Ideas` with a property reached
`pages/Alex___Ideas QA.md` in 588 ms and removed the old file. The three e2e tests failed on the
unfixed server (new file never appeared, `qaprop:: hello` missing, `  - two` never indented).
Coordinator: B-95's fix note in BUGS.md ("moves renamed ones", `onlyChanged`) describes the
replaced mechanism.

---

### B-261 · Renaming a page from its title in the web UI breaks every link to it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q2) · **Test:**
`e2e/tests/page-rename.spec.ts` "renaming from the title rewrites every link and tag, and keeps the
old name as an alias", "a title rename onto an existing page's name is refused and the title goes
back"

Set a page's title input to a new name and press Enter: backlinks to the new name go from 1 to 0,
the linking block still says `[[Old Name]]` and `#[[Old Name]]`, `page.read` on the old name is a
404 and no alias is created, so clicking the old link opens the "Create" view of a missing page.
The same rename through the API (`page.update new_name`) rewrites every link (`refs_rewritten: 1`)
and keeps the old name as an alias, as its description promises. On the owner's graph (many
`@person` pages, Czech and English) one title edit silently orphans every reference to the page.

**Fixed 2026-09-13.** `PageView.tsx` applied a bare local `page.rename`; the link rewrite and the
`alias::` op exist only in the server's `page.update`, because the rewrite needs the `ref` index
the client does not have. The title now calls `page.update` through `data/page-rename.ts` —
push, call, pull, then navigate, the bracket the M7 refactors use (ADR 020 §1). A rename onto a
name another page has used to leave the input showing the rejected name; it now alerts and puts
the real name back. Two `pages.spec.ts` assertions said the old name must be "missing" after a
rename — they encoded the bug and now check that it resolves to the renamed page. Both new tests
failed before the fix (linker text unchanged; title kept the clashing name). Not done: an
offline rename is refused rather than queued, since a local rename cannot rewrite links.

---

### B-262 · `nooklet export` skips pages whose `.md` file is missing
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q3) · **Test:** —

Copy a served `graph.sqlite` into an empty directory and run `nooklet export --data <dir>`: it
reports `"exported": 6, "skipped": 966` and `pages/` holds 5 files. After `DELETE FROM
mirror_file` the same command writes all 972. The bookkeeping rows travel with the database, so
export — the walk-away-with-it command — trusts them over the disk. The same holds for the live
mirror: a mirror file deleted by hand, or a data directory restored without `pages/`, is never
recreated.

---

### B-263 · Query `tag:task` / `#task` finds nothing, and `not #task` matches every task
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q4) · **Test:** —

On the real graph a ```` ```query ```` fence with `tag:task` (or `#task and (NOW or WAITING)`)
says "0 blocks", while `page.backlinks {target: "Task"}` lists the 686 task-marked blocks — the
server's `ref` table carries a derived `Task` tag for every block with a marker ("a tag query
finds them", says the comment that adds it). `marker:open not #task` returns every open task.

---

### B-264 · Display math `$$…$$` renders as inline math wrapped in literal dollar signs
**Status:** open · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q5) · **Test:** —

`Display math $$\int_0^1 x^2\,dx = \frac{1}{3}$$ end` shows `$`, an inline KaTeX span, and `$`;
no `.katex-display` element exists. `$$…$$` is Logseq's display-math syntax and the owner's graph
uses it (`$$CO_2$$` on "Projects/Science presentation for kids with dry ice"). The grammar spec
("Inline math": a `$` opens math only if the next character is not another `$`) never mentions the
display form, so the second `$` opens inline math and the fourth is left over.

---

### B-265 · Inserting a collapsed template gives a collapsed copy with its content hidden
**Status:** open · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q6) · **Test:** —

On the real graph, `/template` → "Meeting" inserts one empty bullet. Stored: the root (content
`""`, properties `participants`, `projects`, `type`) with `collapsed: true` and the three children
(Objectives / Agenda / Notes) hidden under it. The template's root is `collapsed:: true` in the
library — collapsed there to keep the library tidy — and the copy inherits it. Not verified:
whether Logseq itself clears `collapsed` on insert.

---

### B-266 · `SCHEDULED: <2023-2-17 Fri>` (no zero padding) is not recognised
**Status:** open · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q7) · **Test:** —

20 live blocks on the real graph (19 DONE, 1 unmarked) keep a literal `SCHEDULED: <2023-2-17 Fri>`
line in their content with `scheduled_day` NULL, so `scheduled:any` returns 4 blocks instead of
24. The parser and spec OUT-23 both require `YYYY-MM-DD`; the owner's Logseq data has single-digit
months and days.

---

### B-267 · `page_merge` with `dry_run: true` says "merged" in the past tense
**Status:** open · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q8) · **Test:** —

MCP `tools/call page_merge {source: "Alex", target: "@Alex", dry_run: true}` answers
`merged Alex into @Alex: 0 block(s) moved, 19 reference(s) rewritten`. Nothing was written (op log
did not advance, "Alex" still live); only `structuredContent.dry_run` says so. An agent reading the
text can believe the merge happened.

---

### B-268 · Markdown links render `javascript:` URLs as clickable hrefs
**Status:** open · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q9) · **Test:** —

`click [me](javascript:document.title='PWNED') here` renders
`<a class="vr-link" target="_blank" rel="noopener" href="javascript:…">`. In headless Chromium the
click opened `about:blank` and did not run in the app origin, so it was not exploitable there;
WKWebView (the Tauri app) was not tested. Content arrives from sync and from MCP agents, so the
renderer should not hand an arbitrary scheme to the browser.
