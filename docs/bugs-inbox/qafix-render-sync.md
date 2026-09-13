# Bugs inbox — qafix-render-sync

Entries for `docs/BUGS.md`, kept here so a dozen parallel branches do not conflict on it. Format
matches BUGS.md. All nine came from exploratory QA on a copy of the owner's real graph
(`nooklet serve` on 6452, runs A and B; scripts in the QA scratchpad `qa-render-sync/`), and were
logged here before any fix started.

---

### B-260 · The live mirror never picks up renames, moves, marker, indent or property changes
**Status:** open · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q1) · **Test:** —

While `nooklet serve` runs, only block text edits, creates and deletes reach `pages/`. Rename a
page (title input or `page.update new_name`) and the old file stays while no new file appears
(polled 8 s). Set a page property (`qaprop:: hello`) or a block property (`status:: x`), choose a
journal template in Settings (`journal-template:: true`), indent a block with Tab or cycle its
marker with Cmd/Ctrl+Enter: none of it shows up in the file. The stored page read
`- one\n  - two\n- three`; the mirror still had `- one\n- two\n- LATER three`. A full
`nooklet export` of a copy of the same DB wrote the right files and `nooklet verify` passed, so
the data is right and only the live mirror is stale. B-95's fix note says the sweep "moves renamed
ones" — true of `exportPage`, but the sweep never offers it the page.

---

### B-261 · Renaming a page from its title in the web UI breaks every link to it
**Status:** open · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q2) · **Test:** —

Set a page's title input to a new name and press Enter: backlinks to the new name go from 1 to 0,
the linking block still says `[[Old Name]]` and `#[[Old Name]]`, `page.read` on the old name is a
404 and no alias is created, so clicking the old link opens the "Create" view of a missing page.
The same rename through the API (`page.update new_name`) rewrites every link (`refs_rewritten: 1`)
and keeps the old name as an alias, as its description promises. On the owner's graph (many
`@person` pages, Czech and English) one title edit silently orphans every reference to the page.

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
