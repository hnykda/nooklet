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
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q3) · **Test:**
`packages/server/src/mirror/export.test.ts` "rewrites a page whose file is gone even though
mirror_file says it is up to date", `packages/server/src/mirror/live.test.ts` "recreates, on
start, a file deleted while the server was down"

Copy a served `graph.sqlite` into an empty directory and run `nooklet export --data <dir>`: it
reports `"exported": 6, "skipped": 966` and `pages/` holds 5 files. After `DELETE FROM
mirror_file` the same command writes all 972. The bookkeeping rows travel with the database, so
export — the walk-away-with-it command — trusts them over the disk. The same holds for the live
mirror: a mirror file deleted by hand, or a data directory restored without `pages/`, is never
recreated.

**Fixed 2026-09-13.** `exportPage` skipped the write when the `mirror_file` row's path and hash
matched the render, without asking whether the file was still there. It now also requires
`existsSync`. Real graph: a `.backup` copy of a served database (952 `mirror_file` rows, no
`pages/`) now exports 952 pages into 127 `pages/` + 825 `journals/` files. The live mirror gets the
same repair on start, because its first sweep renders every page (B-260); a file deleted by hand
while the server runs comes back on that page's next change, not immediately — there is no watcher
(ADR 002's watcher is still unbuilt). Only existence is checked, not the file's hash, so a file
edited by hand is not overwritten until its page changes.

---

### B-263 · Query `tag:task` / `#task` finds nothing, and `not #task` matches every task
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q4) · **Test:**
`e2e/tests/query-task-tag.spec.ts` (2 tests), `packages/core/src/query.test.ts` "a task marker is a
reference to Task, with no #Task in the text" and the prefilter soundness cases `"tag:task"`,
`"#task and (NOW or WAITING)"`, `"marker:open not #task"`, `"not [[Task]]"`

On the real graph a ```` ```query ```` fence with `tag:task` (or `#task and (NOW or WAITING)`)
says "0 blocks", while `page.backlinks {target: "Task"}` lists the 686 task-marked blocks — the
server's `ref` table carries a derived `Task` tag for every block with a marker ("a tag query
finds them", says the comment that adds it). `marker:open not #task` returns every open task.

**Fixed 2026-09-13.** The `Task` tag is derived from `block.marker` on the server
(`apply-ops.ts#rebuildRefRows`), but the client has no `ref` table and the query language read
references from the block text alone (`query.ts#refKeys`), where the tag never is. The name is now
defined once in core (`refs.ts#TASK_TAG`), the server imports it, `refKeys` adds `task` for any
marked block, and the SQL prefilter for a `task` ref also admits `b.marker IS NOT NULL` — without
that the prefilter dropped marked rows with no `#` or `[[` before the exact check ran (the
soundness case `"tag:task"` fails if that half is removed; checked). Real graph (fresh copy, this
build): `tag:task` → 686 blocks (the `ref` table says 686), `#task and (NOW or WAITING)` → 8,
`marker:open not #task` → 0. `nooklet verify` OK (20,417 ops).

---

### B-264 · Display math `$$…$$` renders as inline math wrapped in literal dollar signs
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q5) · **Test:**
`e2e/tests/math-display.spec.ts` (2 tests), `packages/core/src/tokens.test.ts` "tokenizeLine:
display math $$…$$" (4 tests)

`Display math $$\int_0^1 x^2\,dx = \frac{1}{3}$$ end` shows `$`, an inline KaTeX span, and `$`;
no `.katex-display` element exists. `$$…$$` is Logseq's display-math syntax and the owner's graph
uses it (`$$CO_2$$` on "Projects/Science presentation for kids with dry ice"). The grammar spec
("Inline math": a `$` opens math only if the next character is not another `$`) never mentions the
display form, so the second `$` opens inline math and the fourth is left over.

**Fixed 2026-09-13.** The tokenizer had no `$$` form, as the spec said. `core/tokens.ts` now tries
display math at a `$$` before the inline rule — closer on the same line, non-blank tex, the inline
rule's no-digit-after-closer guard — and emits `math` with `display: true`; the rendered view
(`render/tokens.tsx#MathView`) and the editor widget (`livePreview.ts#MathWidget`) pass it to
KaTeX's `displayMode`. Spec updated (`markdown-grammar.md`, "Display math"). Real graph: the
`$$CO_2$$` block renders one `.katex-display`, centred on its own line, with no dollar signs
(screenshot checked). Not done: a `$$` block spanning several lines — the tokenizer works per line.

---

### B-265 · Inserting a collapsed template gives a collapsed copy with its content hidden
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q6) · **Test:**
`e2e/tests/template-collapsed.spec.ts` "a folded template inserts unfolded, keeping folds below its
top", `packages/core/src/templates.test.ts` "hands back the inserted nodes expanded, and leaves folds
below them alone"

On the real graph, `/template` → "Meeting" inserts one empty bullet. Stored: the root (content
`""`, properties `participants`, `projects`, `type`) with `collapsed: true` and the three children
(Objectives / Agenda / Notes) hidden under it. The template's root is `collapsed:: true` in the
library — collapsed there to keep the library tidy — and the copy inherits it. Not verified:
whether Logseq itself clears `collapsed` on insert.

**Fixed 2026-09-13.** Every node was copied with `collapsed: node.collapsed`. The fold is now
dropped from the nodes an insertion places at the top (`core/templates.ts#templateRoots`, which the
caret insert, the insert-into-empty-bullet path, and both journal-day paths all go through); folds
further down stay, since they are part of the template's shape. The existing unit test that asserted
`collapsed: true` on the copy now asserts `false`. Real graph (fresh copy, this build): `/template`
→ "Meeting" shows `Objectives (What is to goal?):`, `Agenda:`, `Notes / Discussion:` under the new
bullet, stored `collapsed: false`. Still not verified: what Logseq does.

---

### B-266 · `SCHEDULED: <2023-2-17 Fri>` (no zero padding) is not recognised
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q7) · **Test:**
`packages/core/src/outline.test.ts` "reads org timestamps without zero padding, and stores them
padded", `packages/server/src/importer/logseq.test.ts` "imports SCHEDULED/DEADLINE dates and hours
written without zero padding"

20 live blocks on the real graph (19 DONE, 1 unmarked) keep a literal `SCHEDULED: <2023-2-17 Fri>`
line in their content with `scheduled_day` NULL, so `scheduled:any` returns 4 blocks instead of
24. The parser and spec OUT-23 both require `YYYY-MM-DD`; the owner's Logseq data has single-digit
months and days.

**Fixed 2026-09-13.** `outline.ts`'s `TIMESTAMP_INNER_RE` took `\d{4}-\d{2}-\d{2}`. mldoc, which
Logseq writes and reads these with, parses the date with `Scanf.sscanf s "%d-%d-%d"`
(https://raw.githubusercontent.com/logseq/mldoc/master/lib/syntax/timestamp.ml, `parse_date`,
read 2026-09-13; its call site was not located), so one-digit parts are valid Logseq. The regex now
takes them and the branch stores the value zero-padded. Found while fixing: the regex already
allowed a one-digit HOUR (`9:05`), consumed the line, and handed the reducer `2026-09-14 9:05`,
which `SCHEDULED_RE` refuses — and an invalid key in a `block.create` bag is dropped silently, so
the schedule vanished with no trace in content (probe: `deadline_day` NULL, line gone). Padding
covers that too. OUT-23 amended. Real data: all 20 live blocks on the owner's graph that still hold
a literal `SCHEDULED:` line now parse to a schedule when re-read through `parseOutline`.
**Not done — needs the owner:** those 20 blocks in the already-imported database keep the literal
line until the graph is re-imported or a one-off repair re-parses them; nothing here rewrites
existing data.

---

### B-267 · `page_merge` with `dry_run: true` says "merged" in the past tense
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q8) · **Test:**
`packages/server/src/mcp/server.test.ts` "says a dry run wrote nothing, for every write tool, in the
text itself"

MCP `tools/call page_merge {source: "Alex", target: "@Alex", dry_run: true}` answers
`merged Alex into @Alex: 0 block(s) moved, 19 reference(s) rewritten`. Nothing was written (op log
did not advance, "Alex" still live); only `structuredContent.dry_run` says so. An agent reading the
text can believe the merge happened.

**Fixed 2026-09-13.** Not only `page_merge`: every dry-runnable op's `render` is written in the past
tense (`deleted N block(s)`, `created …`, `moved …`) and a dry run executes the same handler inside a
rolled-back savepoint, so all of them read like a real write. `mcp/server.ts` now builds the text
through `ops/dry-run.ts#renderToolText`, which prefixes `dry run, nothing written: ` whenever the
output's `dry_run` is true — one place, so an op added later cannot forget. HTTP returns the JSON
body (with `dry_run`) and was not changed. `mcp-tools.md` §3.1 rule 3 amended.

---

### B-268 · Markdown links render `javascript:` URLs as clickable hrefs
**Status:** open · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q9) · **Test:** —

`click [me](javascript:document.title='PWNED') here` renders
`<a class="vr-link" target="_blank" rel="noopener" href="javascript:…">`. In headless Chromium the
click opened `about:blank` and did not run in the app origin, so it was not exploitable there;
WKWebView (the Tauri app) was not tested. Content arrives from sync and from MCP agents, so the
renderer should not hand an arbitrary scheme to the browser.
