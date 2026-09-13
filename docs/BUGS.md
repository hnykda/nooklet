# Bugs and backlog

Working list. Anything reported from real use lands here first, so it survives a lost session and
is not stuck in a chat transcript.

**Conventions.** Each entry says what you *see*, not what the code does — the diagnosis belongs in
the fix. A fixed entry keeps its commit so the regression test is findable. Anything with a
reproducing test names it; anything without one says so, because "fixed" without a test here means
"believed fixed".

Status: `open` · `fixed` · `wontfix` · `needs-repro`

---

## Open

### B-42 · Typing into the `[[` popup keeps dropping editor focus
**Status:** needs-repro · **Severity:** high · **Reported:** 2026-09-12 (user: "When I type `testing
[[new/page` → then context window open → but when I keep typing then the edit focus keeps
deselecting and I have to click again to type")

Type `[[` in a block, the page autocomplete opens, keep typing the query — and the editor loses
focus, repeatedly, so every few characters need another click.

**Not reproduced, in any of these** (all with a synchronous `document.activeElement` check after
*every* keystroke plus a `focusout` recorder that captures the JS stack of whatever moved focus —
an auto-retrying `toBeFocused()` would wait out a transient loss and pass):

- `e2e/tests/autocomplete.spec.ts`, Chromium, small graph, page view — 0 losses.
- The same string typed into today's journal on a **copy of the real 952-page graph** — 0/19.
- With another "device" appending to that journal every 150 ms while typing — 0/19.
- Imitating a Czech Mac layout (`[` as an Option-modified keydown, `/` as Shift) — 0/19.
- Mouse parked where the popup opens, so its rows get `mouseenter` on every re-render — 0/19.
- 10 ms between keystrokes — 0/19.
- **WebKit** (the Mac app's engine), once B-43's fallback let the app run there — 0/19.

Ruled out by reading: the `/` cannot wake the slash menu (`TRIGGER_RE` requires whitespace before
it); `surface.ts`'s deferred refocus is guarded against stale attaches; the popup never calls
`.focus()`.

What remains is the reporter's runtime: a stale desktop bundle (this is B-15's exact symptom, fixed
on 2026-09-11 and only delivered by a rebuild — see the delivery-path lesson under B-20), or
something about the real WKWebView that Playwright's WebKit does not share. Needs: which app,
which build, and whether it reproduces at `127.0.0.1:6100` after a hard reload.

---

### B-162 · Undoing a collapse ends editing, so redo has no keyboard target
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-commands verification · **Test:**
none yet (reproduced with a throwaway e2e spec, not kept)

Pre-existing, not caused by this branch. Editing a block with children, Cmd/Ctrl+Up collapses it;
Cmd/Ctrl+Z expands it again but also ends editing (`.cm-content` count 0), so the Cmd/Ctrl+Shift+Z
that follows reaches no host and does nothing (3 rows stay 3). "Collapse all" behaves the same way.
Cause, by reading: `BlockTree.commitOne` (and `setAllCollapsed`) record the history entry with
`before`/`after` focus `null`, and `doUndo`/`doRedo` treat a null focus as "detach the surface".
Recording the editing block's caret when the edited row survives would keep editing through undo.
Not fixed here (outside this brief's scope).

---

### B-161 · e2e "opening the palette while editing and closing it hands focus back to the editor" fails
**Status:** needs-repro · **Severity:** low · **Found:** 2026-09-13, impl-commands e2e sweep ·
**Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands focus
back to the editor"

**Seen by five workstreams on 2026-09-13** (B-193, B-226, B-246, B-270 are the same report). In the coordinator's runs it failed inside full-suite runs on a loaded machine (12.2 s timeout) and passed alone twice; treat it as flaky-under-load until someone reproduces it on a quiet machine.

Open a page, click into a block, Cmd/Ctrl+K, Escape: the palette closes but `.cm-content` is not
focused (`toBeFocused` times out, "inactive"), so the `!` typed next goes nowhere. On port 6402 it
passed twice earlier the same morning and then failed three runs in a row — once in a 19-spec sweep
and twice alone (`--repeat-each=2`) — **including with every `apps/web/src` file this branch changed
restored to `da85cfb`**, so this branch did not cause it. Reading the code, nothing hands focus
back to the editor when the palette closes (the palette input takes focus in a microtask on open;
removing it leaves focus on `<body>`), so the test passing at all may depend on timing — e.g. the
input's `focus()` landing before or after the element is attached. Machine load at the time was
heavy (a dozen agents). Not investigated beyond that; logged so it is not mistaken for a
regression from whichever branch merges next.

---

### B-142 · Cmd/Ctrl+Z does not undo a date set with the date picker
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-dates · **Test:** none yet;
probe `tools/probes/picked-date-undo.spec.ts`

`/scheduled`, `tomorrow`, Enter, then Cmd+Z: the chip stays and the server still has
`scheduled:: <tomorrow>` 1.5 s later (probe output: `scheduled after Cmd+Z: 2026-09-14`). The picker
writes through the command `Store` (`app/hosts.ts#setBlockProps` → `applyOps`), and undo is
`BlockTree`'s `EditHistory`, which only records what goes through `BlockTree#commit`. By reading
the code, every `ctx.store` task command has the same gap — `task.setPriorityA/B/C` and the
palette's `task.setMarker*` use `ctx.store.setBlockProp` — but only the date case was run.
Fix needs a seam, not a patch in the picker: an `EditorHost` (or store) method that commits ops
through the active tree's history, used by every store-routed command. `BlockTree.tsx` is a
shared file this milestone, so not done on this branch.

---

### B-144 · Two web unit tests fail under load: the query fence's first render and `page-title`'s first test
**Status:** needs-repro · **Severity:** low · **Found:** 2026-09-13, impl-dates · **Test:** the
tests themselves

On the shared machine, `pnpm -r test` and `apps/web` `vitest run` intermittently failed
`src/editor/render/render-seams.test.tsx` "says what is wrong, and where, for a query that does
not parse" (its `waitFor`, default 1 s, gives up before the lazy `QueryFenceView` import has
resolved — the DOM dump shows the plain `<pre>` fallback) and `src/data/page-title.test.ts`
"renders a journal by its day and an ordinary page by its name" (its first `vi.resetModules()` +
`import()`; message not captured). Both pass alone, every time tried (4/4). Not caused by this
branch: with `editor/BlockRowView.tsx` swapped back to `da85cfb`'s, 3 of 3 full `apps/web` runs
had one or two of these failures; with this branch's, 3 of 8 runs (counting one `pnpm -r test`)
had one, and the last 3 in a row were clean. A timed probe of the
`QueryFenceView` import alone measured 0.9–3.7 s depending on machine load. Likely fix: a longer
`waitFor` timeout on the first lazy render, and a per-test timeout on the first cold import.

---

### B-147 · Text that reaches the page before the picker is listening, or without a keydown, goes into the block behind it
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verify-impl-dates · **Test:** none;
measured with throwaway Playwright probes (numbers below)

Two ways the picker's "keys never reach the block" rule has a hole, both because the editor keeps
DOM focus and the picker takes keys from a window `keydown` listener:

1. **Type-ahead.** `open()` reads the block (`getBlockTaskState`, a replica query) and lazy-loads
   `DatePicker.js` before the listener exists. Enter on the slash menu → picker mounted measured
   25 / 10 / 7 ms on the e2e graph and 6–24 ms (8 opens) on a copy of the owner's graph. A key
   pressed inside that window lands in the block: `" /sched"`, Enter, `tom` typed at once gave
   the block `fast typist t` and a picker holding `om` (invalid, so Enter only showed an error).
   Human keystrokes after Enter are normally slower than the gap, hence low.
2. **No keydown.** Text committed by an IME, a dead-key composition, dictation or a virtual
   keyboard arrives as `beforeinput`/`input` with no `keydown` of its own. Emulated with
   Playwright's `keyboard.type("zítra ěščřžýáíé")` (non-US characters go through `insertText`):
   the picker saw `ztra`, the block got `íěščřžýáíé`. Unverified on a real keyboard: a Czech
   layout's number-row letters (ě š č ř ž ý á í é) should arrive as ordinary keydowns and work;
   letters built with a dead háček/čárka key (ď ť ň, most capitals) should not. The picker's
   vocabulary is English words and digits, so this mostly matters for junk landing in the block. `docs/progress/impl-dates.md` §5 already names the
   mobile half of this.

Fix direction: hold keys from the moment `open()` is called (a capture listener handed to the
picker, replayed on mount), and take `beforeinput` `insertText` while open. Not done here.

---

### B-148 · An agent's bad date through `ui_run` comes back as "window did not respond in time", not the reason
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verify-impl-dates · **Test:** none;
throwaway e2e probe (a `write --ui-control` token minted with `nooklet token create` against the
e2e server's temp data dir, `nooklet.live.controlEnabled` set in localStorage)

`ui.run {command_id: "task.setScheduled", args: "tomorrow"}` → 200 `ran`, stored `2026-09-14`;
`{date: "2026-12-24 09:00"}` and `{date: null}` work too. But `args: "banana"`, `"+10000y"` or `42`
→ **500 `internal`, `window "…" did not respond in time`, hint "the window may be busy … try
again"** after the RPC timeout, nothing stored. The command rejects as designed
(`task.ts#runDateCommand` / `host.ts#set` throw `"banana" is not a date …`), but
`live/message-handler.ts#handleIncomingFrame` just awaits `runCommand`, `live/socket.ts` only
sends a reply in `.then`, so a rejection sends nothing (and is an unhandled rejection in the
window), and `CommandRunResult` has no field for an error anyway. So the agent is told to retry
the very input that will fail again. Not specific to dates — any command that throws over
`ui_run` does this — but these are the first commands that reject an argument on purpose.

Fix direction (not done — the `/ui/live` protocol, client and server, ADR 015): reply
`command.result` with an `error` message when the run throws, and surface it from `ui.run` as an
`invalid` error rather than a timeout.

---

### B-191 · Undo of `/template` into a bullet that already had one of the template's properties removes it
**Status:** open · **Severity:** low · **Found:** 2026-09-13, fixing B-108 · **Test:** none
(not reproduced in the app; from reading `editor/invert.ts`)

`/template` into an empty bullet writes the template's first-block properties onto that bullet,
and since B-108 the whole insertion is one editor undo step. The inverse of a `block.prop` is
computed from the editor's `EditableBlock`, which models only the reserved keys (`marker`,
`priority`, `collapsed`, `scheduled`, `deadline`, `repeat`, `done`); any other key inverts to
`null` (`invert.ts#propValueBefore`). So if the empty bullet already had `type:: a` (set through
the API, for one) and the template sets `type:: b`, Cmd/Ctrl+Z removes `type` instead of restoring
`a`. Fix when it matters: let an `OpBatch` carry the before-values of the properties it overwrites
(`data/templates.ts` would read them from `block_prop` while it builds the batch), or project
generic properties into the page tree, which today (`BlockRow`) has none.

---

### B-192 · A block's text rewritten elsewhere while you edit it stays stale, and your next keystroke reverts it
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, fixing B-88 (probe below) ·
**Test:** none for the editor itself (the probe was a throwaway spec; its steps are here)

Put the caret in a block. Something else rewrites that block's text — another device, an agent's
`block_update`, or this app's own "Turn into page" (server op `block.to_page`, which turns the
text into `[[First line]]`). The rows around it update after the pull; the block being edited
keeps showing its old text. Type one character: the old text plus the character is written back
over the rewrite, last-writer-wins. Probe (2026-09-13, "Turn into page" with its end-editing step
removed): the server had `[[Probe kickoff]]`; after typing ` typed` it had `Probe kickoff typed`.

Cause: `BlockTree`'s tree effect always prefers the live CM6 buffer for the block being edited,
because a refetch that read before one of this tab's own writes looks the same as an external
change (the B-66 note in that effect). `surface.replaceContent` exists for external changes but is
only called for this tab's own undo/redo/merge. "Turn into page" keeps ending editing before its
op (`commands/registrations/refactor.ts#leaveEditing`) for this reason; there is no guard for the
other writers. A fix needs a way to tell a stale read from a newer write — the block's
`content_hlc` against the HLC of the last text op this tab wrote, for one — and a decision on what
to do with unflushed keystrokes when a newer external text arrives (the owner's call: merge,
prefer local, or prefer remote).

---

### B-194 · Cmd/Ctrl+Z after the edited block left the page reverts it out of sight and unmounts the editor
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying `m8/impl-editor` (probe) ·
**Test:** none (the probe was a throwaway spec; its steps are here)

Caret in "goes", type " typed"; another writer moves "goes" to another page
(`block.move_to_page` through the API). The row leaves and " typed" is written to the block on
the destination page (B-88, as intended). Now click into "keep", End, Cmd/Ctrl+Z: the undo takes
" typed" back on the OTHER page, where nobody sees it, and the editor disappears from "keep" —
`editingRowIndex` is -1, `document.activeElement` is `<body>`, and the next keystrokes go
nowhere. Probe on the branch: destination read back `["already here","goes","child"]`, no row
held the editor, typed "Z" landed nowhere.

Not introduced by B-88's fix: the same probe against `apps/web` at `da85cfb` (where the row stays
until the click into "keep", which flushes the same text transaction) ends identically. B-88's
flush only makes it reachable without that click.

Cause: `EditHistory` keeps transactions for blocks that are no longer in this tree, and
`BlockTree#doUndo`/`doRedo` call `attachEditing(res.focus.id, …)` without checking that the tree
has a row for that id — `editingId` then names a block nothing renders. Fix when it matters: skip
(or drop) history entries whose blocks have left the tree, or keep the editor where it is when the
focus target is absent; which one is the owner's call (should an undo reach a block that left?).

---

### B-195 · "Move to page…" onto the block's own page while editing it leaves an unfocused editor
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying `m8/impl-editor` (probe) ·
**Test:** none (throwaway probe)

Caret in the first block, right-click it, "Move to page…", pick the page it is already on. The
block moves to the end of the page (correct), and its row still holds the editor, but focus is on
`<body>` — the picker took it and nothing gives it back — so typing goes nowhere until a click.
Before B-88's fix removed `leaveEditing` from this command, it ended editing first and left the
block selected with the outliner focused (typing did nothing there either, but nothing looked
editable). The row did not leave the page, so the tree's new end-editing path (B-88) does not run.
Same family as B-193: a picker or palette closing without handing focus back to the editor.

---

### B-211 · A ```` ```query ```` result on the same page can be scrolled to instead of the real row
**Status:** open · **Severity:** low · **Found:** 2026-09-13, reading `data-block-id` users while
building embeds · **Test:** —

Not reproduced in a browser — found by reading. `render/QueryFenceView.tsx#HitView` puts
`data-block-id="<id>"` on every result row, the same attribute the outliner's rows carry
(`BlockRowView.tsx`). `shell/Shelf.tsx#revealOnPage` and `live/RemoteFlashOverlay.tsx` both find a
row with `document.querySelector('[data-block-id="…"]')`, which returns the first match in document
order. A query block above its own results on the same page (a page of tasks with a
`TODO` query at the top) therefore makes "reveal this block" from the shelf outline, and an agent's
change flash, land on the result inside the query instead of on the block. Fix: a distinct
attribute on hits (`data-query-hit-id`), as embedded rows use `data-embed-block-id`.

---

### B-224 · A multi-line block renders its lines run together, with no line break
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, screenshot while building the page
export · **Test:** none yet

A block whose content is `Poznámka: **žluťoučký kůň**\nsecond line` (stored exactly so — checked
with `page.read`) renders as "Poznámka: **žluťoučký kůň**second line": one `<p class="vr-paragraph">`
whose spans jump from `data-to="27"` to `data-from="28"` with no `<br>` for offset 27. A plain
`plain first\nplain second` renders "plain firstplain second" the same way. `@nooklet/core`'s
`tokenizeContent` does insert `br` tokens and `render/tokens.tsx` has a `br` case, so the render
path in use is dropping them somewhere between the two. Reproduced on a production build at
`06ed234` + this branch's uncommitted web changes (none of which touch `render/`), Chromium, seeded
through `page.create` markdown with a continuation line. Not fixed here: `render/tokens.tsx` is
another branch's file this round (`m8/impl-render` exists).

---

### B-225 · The page title row's History link and empty icon slot cannot be discovered on a phone
**Status:** open · **Severity:** low · **Found:** 2026-09-13, while placing the page actions in the
same row · **Test:** none

`.page-history-link` and `.page-icon-button-empty` (`styles/views.css`) are `opacity: 0` until the
title row is hovered or the control has keyboard focus. A touch screen has no hover, and unlike
`.all-pages-star` (`views/all-pages.css`) there is no `@media (pointer: coarse)` rule revealing
them, so on a phone the History link is an invisible tap target that still takes ~60px from the
title. The page actions star and "…" button added for B-220–B-222 are always visible on purpose.

---

### B-171 · The Tasks view's due-date window ignores a deadline when the task is also scheduled
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-journal (reading
`views/taskFilters.ts` for reuse) · **Test:** none

`filterTasks`' "Due from / Due to" compares `due_day`, which is `coalesce(scheduled_day,
deadline_day)`. A task scheduled 2026-09-01 with a deadline of 2026-09-20 is invisible to a
2026-09-15..2026-09-25 window even though its deadline falls inside it. Not fixed on this branch
(the Tasks view is outside the task); the journal agenda does not reuse `filterTasks` for this
reason and matches both columns.

---

### B-172 · `block.update` with old_str/new_str rejects any block that has a property line or a second line
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, impl-journal (an e2e spec flipping
`TODO` to `DONE` on a task with `scheduled::` through the API) · **Test:** none yet; reproduced by
`tools/probes/block-update-property-roundtrip.ts`

`POST /api/v1/block.update {id, old_str: "TODO", new_str: "DONE"}` on the block
`- TODO buy milk` / `  scheduled:: 2026-09-13` answers 400 "content must describe exactly one
block". The same happens for a block whose content has two lines. The op's own description tells
agents to use old_str/new_str "for a small edit like flipping a marker", so an agent cannot finish
a dated task that way. Cause (read, and confirmed by the probe): `renderSingleBlockText`
(`packages/server/src/ops/outline-bridge.ts`) strips the two-space indent from continuation and
property lines, and `parseSingleBlockGrammar` prepends `- ` only to the first line, so the edited
text parses as a block followed by stray top-level lines. Probably the same for `content` given
with unindented property lines, which is how the spec describes the grammar. Workaround used in
`e2e/tests/journal-agenda.spec.ts`: `properties: { marker: "DONE" }`. Not fixed here (server op,
outside this branch's task).

---

### B-180 · The desktop app ships no built-in plugins' server halves
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-plugins (by reading, not
reproduced in a built app) · **Test:** none

`packages/server/src/cli.ts#pluginDirsFor` finds the built-in plugins at `plugins/` three levels
above the CLI file, and `apps/desktop/build-sidecar.mjs` copies no `plugins/` directory into the
sidecar. So in the Mac app the `page.wordcount` op and its `page_wordcount` MCP tool do not exist,
and word-count's client half (bundled into the web build since B-103) shows no count there — its
`rpc.call("count")` has no server half to answer. Fix: ship the built-in plugins' server bundles
with the sidecar (or discover them from a resource path the sidecar sets).

---

### B-200 · A page that does not exist yet shows none of its references
**Status:** open · **Severity:** low · **Found:** 2026-09-13, building B-111 · **Test:** none

Open `/page/book` on a graph where pages carry `tags:: book` (the owner's has one) or where blocks
say `[[book]]`, but no `book` page was ever created: the view says "This page doesn't exist yet"
and a Create button, and nothing else. `page.backlinks {target: "book"}` answers with the linked
references and, since B-111, the tagged pages — the server deliberately handles a not-yet-created
target (see the comment in `ops/page-backlinks.ts`) — but `PageView.tsx` only mounts
`ReferencesPanel` inside the `page()` branch. In a wiki a referenced-but-uncreated page is a normal
thing to open, and its references are the reason to open it. Likely fix: mount
`<ReferencesPanel target={props.name()} …>` under the missing-page message too. Not done here:
it changes the missing-page view another branch (`m8/qafix-render-sync`) is editing, and whether an
uncreated page should show references is a product call.

---

### B-203 · Alt+Enter ("Follow link under cursor") did nothing in a Playwright-driven Chromium on macOS
**Status:** open, unconfirmed · **Severity:** unknown · **Found:** 2026-09-13, verifying B-104 ·
**Test:** none

Noticed in passing, not investigated, and not caused by this branch (a plain `[[Taxes]]` behaves
the same as an alias link). Repro on a served graph: a page with one block `alpha [[Taxes]] omega`,
click the end of the block (`.cm-content` focused), `Home`, `ArrowRight` ×9 (the DOM selection then
sits inside `Taxes`), `page.keyboard.press("Alt+Enter")`: the URL stays on the page, and no
navigation follows within 1.5 s. `nav.followLink` (`commands/registrations/nav.ts`, `when:
"editorFocused && caretInLink"`) has no e2e test. Unconfirmed whether the key never matches, the
context's `caretInLink` is false, or Playwright's macOS Alt handling differs from a real keyboard —
try it by hand before spending time on it.

---

### B-151 · A block that opens with a code fence loses its properties when serialized without ids
**Status:** open · **Severity:** low · **Found:** 2026-09-13, writing `core/block-text.ts` (B-101) ·
**Test:** none yet; `tools/probes/serialize-fence-props.ts` reproduces it

`serializeOutline(page, { ids: "none" })` writes a block's property lines straight after its first
line. When that line opens a fence (```` ```js ````), the property lines land inside the fence and
re-parse as code: `- ```js\n  foo:: bar\n  code\n  ```` comes back with `properties: {}` and the
`foo:: bar` line in the code. With ids (the mirror's default) OUT-14 puts `^id` alone on line 1 and
the round trip holds, which is why the mirror never showed it. Callers with `ids: "none"`:
`BlockTree.tsx`'s `block.copySelection` (copy then paste loses the property) and the server's
`outline-bridge.ts#renderSingleBlockText` (the before-text `block.update` matches `old_str`
against). `core/block-text.ts#joinBlockText` avoids the same trap by writing such a block's
properties after the closed fence. Fix: the same placement in `serializeOutline`.

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

### B-247 · An edit queued behind a busy replica worker is lost if the page reloads first
**Status:** open · **Severity:** high (silent data loss; needs a busy worker and a reload within
seconds) · **Found:** 2026-09-13, rerunning QA's `t2.mjs` for B-244 on a copy of the real graph ·
**Test:** — (probe: `tools/probes/busy-replica-reload.mjs`)

On the real graph, `t2.mjs` accepts a `[[` row and reloads the page ~1.9 s later for the next
variant. Twice (ClickNew, EnterExisting) the editor showed `x [[…]]` and the server never got it,
not even after later loads; with 5 s more before each reload, all six variants were stored. The
probe makes it deterministic: keep the replica worker busy for 4 s (a synchronous loop evaluated
in it), type ` queued`, wait 1.2 s (past the 500 ms text debounce), reload. Stored: `x`. The same
with the reload after the busy period: `x queued`. Plain typing with an idle worker and a reload
1.9 s later loses nothing (5/5).

Reading, not verified: `BlockTree.flushPendingEdit` hands the op to `applyOps`, a Comlink message
to the worker; the op only becomes durable (state + `pending_op`, one transaction) when the worker
runs it. A message still queued when the document unloads dies with the worker, and the
`pagehide` flush has the same problem. What keeps the worker busy on a big graph: the cold
bootstrap (measured ~2.2 s blocked on first load) and, plausibly, the `[[` popup's block search
(`LIKE %q%` over every block, re-run on every keystroke). A fix needs a durable hand-off that does
not wait for the worker (e.g. the unflushed edit written synchronously on the main thread and
replayed at start), which is a design decision, not a one-liner.

---

### B-245 · Cmd+X on a block selection does nothing
**Status:** open (feature gap, skipped on this branch) · **Severity:** low · **Found:**
2026-09-13, exploratory QA (Q6) · **Test:** —

Select blocks, Cmd+C copies their markdown (B-84), Cmd+X does nothing: selection, clipboard and
database unchanged. Logseq cuts. Not a regression: `keydown.ts` has no Mod+X mapping in selection
mode and `docs/spec/commands-and-keymap.md` defines no cut command. Needs a spec line (a
`block.cutSelection` = copySelection + deleteSelected as one undo step) before it is built; left
for the owner/coordinator to schedule.

---


## Fixed

### B-213 · e2e "opening the palette while editing and closing it hands focus back to the editor" fails at `da85cfb`
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, running neighbouring specs for
embeds · **Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands
focus back to the editor" (the failing test itself)

**Duplicate of B-161.**

Not diagnosed. On port 6407 the test failed three runs out of three: twice on `m8/impl-embeds`, and
once with every existing web file this branch modifies checked out at `da85cfb` (its new modules
then unreferenced; client rebuilt by the run) — so it is not the embeds work. It fails at `expect(editor(page)).toBeFocused()` after Escape
closes the palette: `.cm-content` is still in the DOM but "inactive" for the full 10 s, so typing
afterwards would go nowhere — the B-72 symptom that test was written for. The other 118 tests in
journals/selection/context-menu/navigation/focus/phone/tasks/views passed in the same run.

*Addendum (verification pass, 2026-09-13):* order-dependent. After `b4ed719` the whole of
`views.spec.ts` passed 29/29 on 6407 — this test included — while the same test run alone
(`-g "opening the palette while editing"`) failed 3/3 with the same "inactive" `.cm-content`. Still
not diagnosed; it does not touch embeds.

---

### B-217 · `nooklet serve --help` does not print help: it opens and serves the default graph
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, verifying `m8/impl-embeds` (by
accident) · **Test:** —

**Duplicate of B-146**, which is fixed (`cli-args.ts#wantsHelp`).

`pnpm exec tsx src/cli.ts serve --help` (from `packages/server`, meaning "show serve's options")
ignored `--help`: it resolved `--data` to its default `~/.nooklet/default`, opened that database with
`migrate: true`, ran the dev-mode rebuild verify over its 20,411 ops, loaded plugins, and died only
because port 6100 was already taken by the owner's running app (`EADDRINUSE`). Had the port been
free it would have served — and started the live markdown mirror on — the owner's real graph. The
directory's mtimes (graph.sqlite, -wal, pages/, journals/ all 09:19:42, the command ran at ~09:26)
show nothing was written this time. `cli.ts#main` only honours `help`/`--help` as the COMMAND (the
`default:` branch); a subcommand never looks at the flag. For a repo whose working rule is "never
open ~/.nooklet/default", a help flag that opens it is a trap. Fix direction: any `--help`/`-h` flag
prints `USAGE` and exits before `dataDir()` is ever called.

---

### B-173 · B-72's "palette closes and hands focus back to the editor" e2e fails on da85cfb
**Status:** duplicate · **Severity:** low · **Found:** 2026-09-13, impl-journal (running
`views.spec.ts` alongside the journal specs) · **Test:** `e2e/tests/views.spec.ts` "opening the
palette while editing and closing it hands focus back to the editor"

**Duplicate of B-161.**

Fails 2 of 2 on this branch and 1 of 1 on a clean `git archive da85cfb` checkout (port 6403,
load average ~17): after Escape closes the palette, `.cm-content` is "inactive" rather than
focused for the whole 10 s. So it predates this branch. Not investigated: whether it is a
regression of B-72 since 2026-09-12 or something about headless focus on a loaded machine.

---

### B-182 · Closing the command palette with Escape leaves the editor unfocused again
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, impl-plugins (regression of a
B-72 fix) · **Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it
hands focus back to the editor" — currently failing

**Duplicate of B-161.**

Edit a block, Cmd/Ctrl+K, Escape: the palette closes but `.cm-content` is no longer focused, so the
next keystroke goes nowhere. The e2e test B-72 added for exactly this fails on `da85cfb` itself
(1 run, port 6404, production build) and on `m8/impl-plugins` (2 runs), each time with
`toBeFocused` → "inactive" after 10 s — so it is not load and not the plugin host. Not
investigated beyond establishing that; which commit between B-72's fix and `da85cfb` broke it is
the next question (`git bisect` over `e2e/tests/views.spec.ts -g "opening the palette"`).

---

### B-252 · `block.update` with `old_str`/`new_str` fails on any block that has a property
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, in passing while writing the B-251
tests · **Test:** none yet

**Duplicate of B-172**, which describes the same failure more broadly (a property line or a second line).

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

### B-193 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails here, on the base commit too
**Status:** duplicate · **Severity:** low · **Found:** 2026-09-13, impl-editor's wider e2e run ·
**Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands focus
back to the editor" (B-72's test)

**Duplicate of B-161.**

Cmd/Ctrl+K while editing, Escape: the palette closes, but `.cm-content` is not focused ("inactive")
for the whole 10 s wait. Failed 3 of 3 runs on `m8/impl-editor` (port 6405), and 1 of 1 with
`apps/web` checked out at `da85cfb`, so this branch did not cause it. Not diagnosed. The
coordinator's full run on `a6c2859` did not list it as failing, and nothing under `apps/web` or
`e2e/` changed between `a6c2859` and `da85cfb` — so either it is load- or machine-dependent (the
machine was running a dozen agents' builds and browsers) or that run passed it by chance. Next
step: run the single test on an idle machine; if it still fails, trace focus on Escape
(`e2e/helpers/focus.ts#installFocusTrace`).

Verification pass, same branch and port, later the same day: `views.spec.ts` passed in full (with
parity, popups, autocomplete, journals, a-fresh-journal, tasks, replace, query and phone: 122 of
122), so the failure is intermittent or load-dependent rather than deterministic.

---

### B-226 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails at `da85cfb`
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, e2e run for
this branch · **Test:** that test

**Duplicate of B-161.**

After Cmd/Ctrl+K and Escape the palette closes but `.cm-content` never regains focus
(`toBeFocused` times out at 10 s; the locator resolves, state "inactive"). Failed 6 of 6 runs on
port 6408, Chromium: in a 12-spec batch; in `views.spec.ts` alone; alone with `-g` on this branch;
alone with the title-row controls removed; alone with the page-action commands and print hookup
also removed; and alone with `apps/web/src`, `packages/core/src` and `packages/server/src`
checked out from `da85cfb` (production build, fresh server) — so it is not caused by this branch. The coordinator's full run at `a6c2859` did not list it among
failures, so either `06fd859`/`da85cfb` or the machine's state since then changed something;
neither was checked. B-72's fix names this test. Nothing in `CommandPalette.tsx` restores focus
explicitly, so whatever used to return it to the editor is worth finding first.

**Note (adversarial verification, 2026-09-13):** order-dependent, not simply broken. On this branch
at `14272fc` it **passed** inside a full `views.spec.ts` run (batch with page-export, pages,
page-icons, phone, navigation, history: 72 passed) and **failed 3 of 3** run alone with
`-g "hands focus back" --repeat-each=3`. The same test is already logged by other branches as
B-161 (`impl-commands`), B-193 (`impl-editor`) and B-246 (`qafix-editor`) — merge as one entry.

---

### B-246 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails at da85cfb
**Status:** duplicate · **Severity:** low (test or focus regression, undiagnosed) · **Found:**
2026-09-13, while regression-running e2e for B-243 · **Test:** the one named

**Duplicate of B-161.**

Mod+K while editing, Escape: the palette closes and `.cm-content` is never focused again
(`toBeFocused` times out, "inactive"). Fails 3/3 on port 6460: twice in the full `views.spec.ts`
with this branch's changes, and once alone and once in the full spec with `apps/web/src` checked
out at `da85cfb`, so it is not caused by this branch. The coordinator's last full run on
`a6c2859` did not list it among failures. Nothing in `apps/web/src` explicitly returns focus to
the editor when the palette closes (no `focus()` call in `CommandPalette`/`palette-controller`),
so whatever made it pass before is worth finding before "fixing" the test. Order matters: it
PASSED once, in a run of context-menu + focus + help + undo-redo + views on one server (views
last), and failed again right after, alone and as the whole views spec. So it depends on what
the server or client went through first, not only on the code. Not investigated further on this
branch.

---

### B-270 · Closing the command palette with Escape leaves the editor unfocused
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, rv-web-reactivity's broader
e2e pass · **Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it
hands focus back to the editor" (B-72's regression test) — failing

**Duplicate of B-161** (the same failing test, seen from the reactivity review).

Edit a block, press Mod+K, press Escape: the palette closes but `.cm-content` is not focused, and
typing goes nowhere. Failed three times in a row on port 6472 at load average ≈35 — twice on this
branch and once with every source file this branch changes restored to `da85cfb`, so it predates
the branch. Not investigated; it may be timing under load, but it did not pass once.

---

### B-146 · `nooklet serve --help` ignores `--help` and serves the owner's real graph — migrating it and rewriting its mirror
**Status:** fixed · **Severity:** high (data safety; every agent on this machine is told never to
open `~/.nooklet/default`) · **Found:** 2026-09-13, verify-impl-dates — by doing it, by accident ·
**Test:** none yet

`pnpm nooklet serve --help`, run to read the flags, printed no usage: `cli-args.ts#parseArgs`
turns `--help` into an ordinary flag nothing reads, `cli.ts` only prints usage for a top-level
`help`/`--help`, and `serve` with no `--data` falls back to `$NOOKLET_DATA`, then
`~/.nooklet/default`. It opened the owner's graph with `migrate: true` and the live mirror on, and
listened on port 6100 until killed (~10 minutes later).

What it changed in `~/.nooklet/default`, measured against a `sqlite3 .backup` taken 33 s before it
started (09:19:07; server wrote from 09:19:40): `schema_migration` 1 → 3 rows (migrations "derive
page_alias … (B-55)" and "add idempotency … (B-58)" applied), `page_alias` 0 → 3 rows, `setting`
+1 row (`refs.pipe_alias`), `mirror_file` 0 → 952 rows, and all 952 `journals/*.md` +
`pages/*.md` files rewritten (mtime 09:19:41). `block`, `page`, `op`, `block_prop`, `page_prop`,
`ref`, `device`, `token`, `changes` are byte-identical to the backup (row dumps hashed). The
mirror is derived from the DB (never read back), so the rewrite loses nothing the DB holds; what
the files said before is not recoverable here. The pre-incident DB copy was kept at
`<verify scratch>/graph/graph.sqlite` (session scratch, not durable).

Fix direction (not done — `cli.ts` is shared): `--help` / `-h` on any subcommand prints that
command's usage and exits 0 before `open()`; arguably unknown flags should be an error for writers.

**Fixed 2026-09-13.** `cli.ts#main` checks `cli-args.ts#wantsHelp` (`--help`, `-h`, or `help` in
any position) before any command runs, prints usage and returns — no graph is opened. Verified by
`NOOKLET_DATA=<scratch> pnpm nooklet serve --help`: usage printed, no data dir created. The owner's
graph content was unchanged by the incident (block 18,628 rows and op max seq 20,411 before and
after; the verifier's row hashes of every content table matched); the pre-incident copy is kept
at `~/.nooklet/backup-2026-09-13-before-accidental-serve.sqlite`. Test:
`packages/server/src/cli-args.test.ts` "--help, -h or help in any position is a request for usage,
never a command (B-146)".

---

### B-138 · Block text reaches the render sinks unchecked: `javascript:` links, app classes, page-sized formulas
**Status:** fixed · **Severity:** low (security hardening) · **Found:** 2026-09-13, web review
(F4, F5, F6) · **Tests:** `e2e/tests/untrusted-content.spec.ts` (one test per sink);
`apps/web/src/editor/render/untrusted-content.test.tsx`; `apps/web/src/app/hosts.test.ts`

**As merged:** the fence info-string and KaTeX size fixes landed. The link-scheme *allowlist* did not: B-268 had already landed a *denylist* of script-capable schemes (`editor/render/safe-href.ts`), which keeps app links such as `zotero://` working; Alt+Enter goes through the same guard.

Block text arrives by sync, import and MCP agents, so anything it can make the renderer do, a
synced device or an agent can do. Three sinks took it as given:

1. **Links (F4).** `[x](javascript:alert(document.domain))` rendered as
   `<a class="vr-link" href="javascript:…">`, and Alt+Enter handed the same href to `window.open`.
   In Chromium and WebKit neither ran script in the app origin (where `localStorage` holds the
   device token), but only because both sinks carry `target=_blank`/`noopener` — the review's
   probe leaked the token from the same anchor without `target`. The SPA sends no CSP, and the
   Tauri WKWebView (`csp: null`) was not tested. Reproduced in the e2e test before the fix: the
   anchor carried `href="javascript:alert(document.domain)"`.

**Fixed 2026-09-13 (links).** `editor/render/asset-url.ts#safeHref` allows http, https, mailto, tel
and relative hrefs, reading the scheme with the WHATWG URL parser so `java\tscript:` or a leading
control character resolve as the browser would; anything else renders its label with no `href`,
and `followLink` opens nothing. The allowlist is exactly what the owner's graph uses (2,298 links:
https/http/relative/mailto/tel — `tools/probes/link-schemes-in-graph.ts`), so no existing link
lost its target; an app scheme added later (`zotero://`) needs adding there.

2. **Code fence classes (F5).** The whole fence info string went into `<code class>`, so
   ```` ```js cmd-overlay ```` gave `class="language-js cmd-overlay hljs"`: any app class, including
   the command palette's fixed full-screen `.cmd-overlay` scrim, from one synced block. Inside the
   outline `.vr-row`'s `content-visibility: auto` contains a fixed descendant to its row; in the
   Shelf, which has no containment, it covers the viewport. Reproduced in the e2e test before the
   fix (`["language-js", "cmd-overlay", "vr-row", "hljs"]`).

**Fixed 2026-09-13 (fence classes).** `editor/render/highlight.ts#languageClass` takes the first
word only — the rule `resolveLanguage` already used for the grammar — reduced to `[\w+-]`; both
branches of `CodeFence` use it. `data-lang` keeps the raw info string (an inert attribute value).
In the owner's graph every fence info string but one is a single language word; the exception is a
log line pasted after the backticks, which now yields `language-Wed`.

3. **Formula sizes (F6).** KaTeX ran with its default `maxSize` of Infinity, so
   `$\rule{99999em}{99999em}$` painted a box 99,999em square: the e2e test measured its row at
   1,574,998 px tall before the fix. `\raisebox{99999em}` and `\hspace{99999em}` did the same.

**Fixed 2026-09-13 (formula sizes).** `editor/render/math.ts#renderTexSync` passes `maxSize: 20`,
which KaTeX applies to `\rule`, `\raisebox` and `\hspace`. `\kern` is not capped by KaTeX; it
shifts content sideways, and the e2e test checks a `\kern99999em` block does not widen the page.
The review also suggested `display: inline-block; overflow: hidden` on `.vr-math-rendered`; not
done: `tools/probes/inline-block-clip-baseline.mjs` shows it lifts every formula 11 px off the text
baseline in Chromium and WebKit, and clipping would not stop a tall box growing its row anyway.
`math.test.ts` (real KaTeX; failed before) and the e2e test above.

---

### B-139 · Alt+Enter on a `((block ref))` does nothing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `app/hosts.ts` for B-137 ·
**Tests:** `e2e/tests/follow-link.spec.ts` "Alt+Enter on a block ref opens the referenced block on
its page"; `apps/web/src/app/hosts.test.ts` "nav.followLink for block refs"

Put the caret inside `((<block id>))` and press Alt+Enter ("Follow link under cursor"): nothing
happens — the URL stays on the current page. Reproduced in the e2e test before the fix (received
`/page/Follow%20Ref%20Source`).

**Fixed 2026-09-13.** `followLink`'s block case resolved the page through
`NavDeps.pageNameForId(link.id)`, but B-82's fix wired `pageNameForId` to
`store.ts#resolvePageName`, which looks the id up in the PAGE table, so a block id never matched and
the navigation was silently skipped. The block case now asks `resolveBlockPageName` (as
`revealBlock` already did) and zooms with `pageZoomRoutePath`.

---

### B-137 · Alt+Enter on an asset link opens a blank app page instead of the file
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, web review (F3) · **Tests:**
`e2e/tests/untrusted-content.spec.ts` "Alt+Enter on an asset link opens the asset from the server
root, not below the page route"; `apps/web/src/app/hosts.test.ts`

Put the caret in `[spec](../assets/x.pdf)` on `/page/Projects/Aurora` and press Alt+Enter ("Follow
link under cursor"): the new tab opens `/page/assets/x.pdf` — the app shell, not the PDF.
Clicking the same rendered link works. B-51 again, on the keyboard path. Reproduced in the e2e
test before the fix ("Received: http://127.0.0.1:6473/page/assets/rv-sec-spec.pdf"). With
`VITE_API_BASE_URL` pointing at another server even a root-relative path went to the wrong origin.

**Fixed 2026-09-13.** `createNavigationHost#followLink` handed the token's raw href to
`window.open`, which resolves a relative URL against the current route; the rendered `<a>` goes
through `editor/render/asset-url.ts#assetUrl`, and now so does this.

---

### B-136 · History, Trash and a query fence sit on "Loading…" forever when their read fails
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, web review (F2) · **Tests:**
`e2e/tests/load-errors.spec.ts` "History says it could not load, and Retry recovers", "Trash says
it could not load, and Retry recovers"; `apps/web/src/views/load-errors.test.tsx` (all three
views)

**Duplicate of B-131.** B-131's fix is what landed.

Open `/history/<page>` or `/trash` while the server is unreachable (or answers 401, or does not
know the page yet): "Loading…" stays indefinitely and the "Could not load … Retry" line never
appears; the error surfaces only as an unhandled rejection in the console. A ```` ```query ````
fence whose evaluation fails stays on "Running query…" and never says "Query failed". B-10 and
B-80 again, in the M7 views. Reproduced in both tests above before the fix.

**Fixed 2026-09-13.** Reading an errored Solid resource — `resource()` and `resource.latest` both —
re-throws, and each view read its resource directly in a `when` or `each`. With no error boundary,
the throw discarded the render pass, so the error branch the views already had was never written.
Every read now goes through a guard that returns `undefined` while the resource is errored:
`usePageHistory` exposes `page` (and derives `batches`/`hasMore`/`loadMore` from it),
`TrashView` reads `list()`, `QueryFenceView` reads `latest()` and drops "Running query…" once the
evaluation has failed. "Older changes" failing now says so too instead of rejecting silently.

---

### B-135 · After opening Trash or History, pages stop updating until a reload
**Status:** duplicate · **Severity:** high · **Found:** 2026-09-13, web review (F1) · **Tests:**
`e2e/tests/change-bus.spec.ts` "a page still picks up an API write after the Trash view was opened
and left"; `apps/web/src/db/client.test.ts`

**Duplicate of B-130** (found by two reviewers the same morning). B-130's fix is what landed; this branch's version of the change-bus fan-out was not merged.

Open a page, open Trash from the sidebar, press Back, then have an agent append a block over the
API: the page keeps showing its old content indefinitely (15 s and counting), although the write
reached this device. The same holds for the journal stream, All Pages, tasks, backlinks, query
fences and `((ref))` text, and the sync indicator stops moving. A reload fixes it until Trash or
History is opened again. Reproduced in the e2e spec above before the fix ("Received string:
first").

**Fixed 2026-09-13.** The worker keeps one change callback and one sync-status callback, each
registration replacing the last, and `db/client.ts` forwarded every subscription straight through.
`data/history.ts` subscribed its own copy of the invalidation bus the first time Trash or History
rendered, which unplugged `data/store.ts`'s — and store's "already wired" flag meant it never
plugged back in. `db/client.ts` now registers with the worker once and fans out to a set of
subscribers (each gets an unsubscribe; one throwing listener cannot starve the rest).
`history.ts` no longer keeps its own counters: it stamps through store's new `serverStampedFor`.
The push-queue-drained bump (B-83) moved from `useSyncStatus` into store's wiring, so it no longer
depends on the sync indicator being mounted and fires once per drain rather than once per mounted
indicator; `useSyncStatus` unsubscribes on cleanup, so Diagnostics opening and closing does not
leak listeners. `client.test.ts` fails against a pass-through client (single-slot fake worker);
`change-bus.spec.ts` fails against the old build.

---

### B-134 · Replace all can write a replacement or flags other than what the fields show
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, web reactivity review (F7) ·
**Tests:** `e2e/tests/review-reactivity.spec.ts` "Replace all pressed right after editing the
replacement writes the edited text (B-134)"; `apps/web/src/views/FindReplaceView.test.tsx` "does
not write the debounced replacement when the field changed a moment ago", "does not write a flag
the preview on screen was not computed with", "is disabled while the preview for the current
fields is still loading"

**Merged as B-250's implementation** (the same bug, found twice). The e2e test named here was kept and passes against B-250's fix.

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

---

## Found in passing — needs a number from the coordinator

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

### B-91 · A deduplicated re-upload of an orphaned asset leaves no trace, so asset GC can collect it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, building orphan-asset GC (ADR 022 §5)
· **Test:** `packages/server/src/gc.test.ts` "a recent audit row for the asset extends its grace"
pins the GC side; the store side: `packages/server/src/ops/asset-upload.http.test.ts` "dedups identical
bytes: a second upload returns the same asset and leaves an audit row"

`storeAssetBytes` (`packages/server/src/assets/store.ts`) returns the existing row when the same
bytes are uploaded again and writes nothing — no `changes` row, no timestamp. If that asset was an
orphan (its last block dropped the link months ago), it is still an orphan the moment the upload
returns; the block op that embeds it again is on the device, not the server, until the next push.
A `nooklet gc` inside that window removes the file, and the push then embeds a link to nothing.
Narrow (identical bytes, previously orphaned, GC run while the device is offline), but it is the
exact case the grace period exists for. Fix: on dedupe, write the same `changes` row a fresh
upload writes — `planAssetGc` already treats a recent audit row as "touched".

**Fixed 2026-09-12.** The dedupe branch of `storeAssetBytes` writes the same kind of `changes` row a
fresh upload writes (before = after = the stored asset's descriptor, so `changes_since` still
reads it as "uploaded"), which `planAssetGc` already counts as "touched within the grace".

A second way asset GC collects an asset something still needs (F10): `referencedAssetIds` scans
current block content and property values only. `batch.undo` — the mechanism `page.history`
tells clients to restore a version with (ADR 022 §3) — rewrites block text from
`changes.before_json`. Remove an image link by editing the block (nothing goes to the trash), run
`nooklet gc` more than 7 days later: the asset row is tombstoned and the file unlinked; undoing
the edit then brings back a link to nothing, recoverable only from the pre-GC backup archive.
Found by reading the code, not probed.

**Fixed 2026-09-13.** `gc.ts#referencedAssetIds` also reads page/block pre- and post-images in
`changes`; an asset mentioned only there is kept and counted as `keptByHistoryOnly` (the CLI line
reports it). Asset rows' own audit entries are excluded. ADR 022 §5 amended with the cost: since
`changes` is never trimmed, an asset any recorded write ever embedded is never collected — the
GC now collects only uploads no write pointed at. That trade (restore fidelity over disk) is the
reviewer's primary suggestion and matches ADR 022's own reasoning, but it narrows what GC does;
the rejected alternatives are recorded there in case the owner prefers the other side. Tests:
`packages/server/src/gc.test.ts` "keeps an asset that only page history still references, so
restoring that version keeps its image" (fails before: the asset was an orphan) and "does not
count an asset's own upload audit row as a reference". The owner's graph copy has no `asset` rows,
so there was nothing real to measure.

---

### B-124 · A query for `[[X]]` misses blocks whose only reference to X is in a property
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M7 server/sync review (F7) ·
**Test:** `packages/core/src/query-prefilter-refs.test.ts` "keeps blocks whose only reference is an
alias:: item or a link in another property"

The SQL prefilter for a `ref` term (`core/query.ts#termSql`) passes only blocks with `#` or `[[`
in the content, or a `tags` property. `extractRefs` — which `matchQuery` and backlinks use — also
reads `alias::` and every other property value. So `date-saved:: [[Sep 7th, 2026]]` on a block with
plain content shows in the day's backlinks but never in `ref:"2026-09-07"`; the prefilter breaks
its own promise to return a superset. Probe: `related:: [[Foo]]` and `alias:: Foo` blocks match in
JS, prefilter returns neither. The owner's graph has 55 live blocks whose only references are in
properties (`date-saved`, `date-published`).

**Fixed 2026-09-13.** The `ref` fragment's property clause now reads the way `extractRefs` does:
a `tags` or `alias` row, or a `#`/`[[` in any property value. The test checks the prefilter is a
superset of `matchQuery` over content-only, `related:: [[Foo]]`, `alias:: Foo` and
`date-saved:: #Foo` blocks, and still excludes a block with no reference syntax; it fails before
(only the content block passed). On the owner's graph copy the new clause admits exactly the 55
blocks (84 page/tag `ref` rows) the old one dropped, and no live block with a non-`Task` `ref` row
is excluded any more. (`Task`, derived from the marker server-side, is not something `extractRefs`
sees either, so the two still agree there.)

---

### B-86 · `[[Page|label]]` links are indexed under the key `page|label` and never resolve
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, probing the reference rewrite ·
**Test:** `packages/core/src/refs.test.ts` "[[Target|label]] refs the target, not 'target|label'
(B-86)"; `packages/server/src/ref-reindex.test.ts`

Write `[[Target|the target]]` in a block: `Target`'s backlinks do not list it, the link is not a
graph edge, and a rename of `Target` does not rewrite it. `ref.dst_page_key` for that block is
`target|the target` with `dst_page_id = NULL`. `packages/core/src/refs.ts#addPageRef` takes the
whole `[[…]]` interior as the page name; `tokens.ts#tryWikilink` already splits the top-level
pipe (`target` + `alias`), so `extractRefs` is the one reader that does not. The M7 reference
rewrite (`data-api.ts#buildRefRewriteOps`) handles the pipe form when it meets one, but it finds
candidate blocks through `ref`, so a block whose only link to a page is a `[[Page|label]]` is not
rewritten by a rename or a merge until this is fixed.

**Fixed 2026-09-13.** `refs.ts#addPageRef` splits on the top-level pipe with `tokens.ts`'s own
`findTopLevelPipe` (now exported), so both readers agree. Graphs indexed before the fix are
re-indexed once by `ref-reindex.ts#reindexPipeAliasRefs` (blocks with a `|` in `dst_page_key`
only; gated by setting `refs.pipe_alias`), run from the writer commands' migrate step. The owner's
graph had zero such rows.

The one-time migration (`ref-reindex.ts#reindexPipeAliasRefs`) rebuilds `ref` only (F6).
`path_ref`, which backlinks and backlink counts read, keeps `page_key = 'target|label'` with
`page_id = NULL` for the block and its descendants, and the migration's done-flag stops it from
ever running again — so a graph indexed before the fix still omits every old `[[Target|label]]`
from `Target`'s backlinks. Probe: after resetting `ref` and `path_ref` to the pre-fix keys and
running the migration (returns 1), `page.backlinks {target: "Target"}` → `linked: []`. The owner's
graph has 0 such rows; other graphs are affected.

**Fixed 2026-09-13.** The re-index rebuilds each candidate block with `reindexBlockAndSubtree`
(now exported from `apply-ops.ts`) — `ref` for the block, `path_ref` for it and every descendant —
and finds candidates through either table (a `|` in `ref.dst_page_key` or `path_ref.page_key`).
Its done-flag is a new key (`refs.pipe_alias.path_ref`), because a graph that already ran the first
version has clean `ref` rows and stale `path_ref` rows, and must run once more. Tests:
`packages/server/src/ref-reindex.test.ts` "rebuilds path_ref too, so the old links show in
backlinks again, children included" (fails on the old code: stale `path_ref` rows remain) and "runs
again on a graph whose first re-index fixed ref but left path_ref stale". The owner's graph copy:
0 rows with `|` in either table.

---

### B-123 · `nooklet verify` reports divergence after a late push loses a page-name collision
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F5) ·
**Test:** `packages/server/src/verify-rejected.test.ts` "a late un-delete that lost its page name to
a newer page is not a divergence" and "an offline laptop's journal day that lost to an agent's
page_append is not a divergence"

`verifyRebuildParity` replays every logged op, rejected ones included, and core re-sorts by HLC.
Whether a `page.create`, `page.rename` or un-delete is rejected depends on state, so a late push
carrying an older HLC wins the name on replay although the server rejected it. Pull never ships
rejected ops, so no client sees them. Realistic case: a laptop offline since before today's journal
existed creates the day and types into it; an agent `page_append`s to today; the laptop pushes and
its `page.create` and `block.create` are rejected → `verify` reports 4 divergences. (That the
laptop's typed text is rejected at all is a separate sync-protocol question — see sql-schema.md
open issue 2.)

**Fixed 2026-09-13.** `verify.ts#loadOps` replays only ops not logged `rejected`, in `seq` order;
the report counts what it left out (`rejectedSkipped`, "N rejected, not replayed" in the CLI
line). The server has already decided those ops, pull never ships them, and a cycle rejection's
effect is its own logged corrective op, so replaying them can only disagree with the server.
sql-schema.md rule 26 says so. Both tests fail before (3 and 4 divergences); they pin the HLC
order with `hlc.receive` rather than a sleep. Still open, and not this fix: the laptop's typed
block is rejected (`no-such-page`) rather than re-homed onto the surviving day.

---

### B-90 · Core accepts an un-delete whose page name is now taken by a live page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, building `trash.restore` (ADR 022)
· **Test:** `packages/core/src/sync/apply-ops.test.ts` "rejects an un-delete whose name a live
page has taken meanwhile (B-90)"; `trash.restore`'s own guard: `trash-restore.http.test.ts` "is
conflict when a live page now has the name"

Delete page "Dup", create a new live page "Dup", then apply `page.delete {deletedAt: null}` to the
old one — through `batch_undo` of the deletion, or as an op arriving in a sync push from a device
that undid it locally. `applyPageDelete` in `packages/core/src/sync/apply-ops.ts` clears the
tombstone without re-checking the live-name unique index (`page_key … WHERE deleted_at IS NULL`),
so SQLite raises a constraint error mid-transaction and the whole `serverApplyOps` call — the
entire push, for a sync — fails. `applyPageRename` and `applyPageCreate` both reject with
`page-key-collision`; the un-delete should too, so the client converges (the page stays deleted)
instead of the push dying. `trash.restore` checks first and returns `conflict` with a `new_name`
escape hatch, but that only covers its own door.

**Fixed 2026-09-12.** `applyPageDelete` now runs the same `pageKeyCollision` check as create and
rename when `deletedAt` is `null`, and answers `rejected / page-key-collision` instead of letting
SQLite raise mid-transaction. A device that undid the deletion locally converges (the server's
rejection tells it the page stays deleted) rather than losing every later push; the sanctioned way
out is rename-then-restore, which the test also exercises.

After the B-90 fix, `batch.undo` and `trash.restore` report success when the page un-delete is
rejected (F4). The rejection used to be a thrown constraint error, which rolled the whole batch
back; now only the `page.delete {deletedAt: null}` is rejected while the `block.delete
{deletedAt: null}` ops in the same batch apply, and neither handler looks at rejected results.
`batch.undo` of a page delete after a new page took the name: 200 `restored page "Dup"`, the page
still deleted, its blocks un-deleted onto it. `trash.restore {new_name}` on a journal page: core
coerces the rename back to the ISO date, rename and un-delete are both rejected, blocks
un-deleted, 200. `trash-restore.ts`'s header still says core does not re-check the name.

**Fixed 2026-09-13.** `batch.undo` checks, before minting anything, that every page it would bring
back (or rename back) still has its name free, and answers `conflict` with
`details.live_page_id` otherwise. `trash.restore` refuses `new_name` for a journal day (`invalid`:
its name is its date). Both now apply through `ops/apply-all-or-nothing.ts` (B-122), so anything
core still rejects rolls the whole call back. Header and mcp-tools.md §4.3.17/§4.3.30 updated.
Tests: `packages/server/src/ops/undelete-collision.http.test.ts` "batch.undo of a page delete,
after a new page took the name, is conflict" and "trash.restore refuses new_name for a journal
day, whose name is its date" (both fail before: 200); the savepoint guard:
`packages/server/src/ops/refactor-atomicity.test.ts` "batch.undo writes nothing when core rejects
any op of it" and "trash.restore writes nothing when core rejects any op of it" (fail without it).

---

### B-122 · `block.to_page`, `block.move_to_page` and `page.merge` commit their writes, then answer 400
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M7 server/sync review (F3) ·
**Test:** `packages/server/src/ops/refactor-atomicity.test.ts` "block.to_page onto an ordinary page
named like a date extends that page", and "… writes nothing when any op of its batch is rejected"
for each of the three ops

`ctx.applyOps` commits immediately; these three handlers look for a rejected result only
afterwards and throw, so the caller gets an error with no `batch_id` while part of the batch has
landed. Trigger: an ordinary page named like an ISO date (`2026-09-07`, e.g. imported from
`pages/2026-09-07.md`). `resolvePageRef` sends a wire date to `pages.journal()`, which does not see
the ordinary page, so `resolveOrMintPage` mints a journal `page.create` whose key collides. The
create is rejected, the continuation-line `block.create` is rejected (no such page), the child
moves are rejected — and the `block.text` replacing the block with `[[2026-09-07]]` is applied.
Block `2026-09-07\nmore text` with a child: `block.to_page` → 400 `rejected: page-key-collision`;
the block now reads `[[2026-09-07]]` and `more text` exists nowhere. `verify` is clean.

**Fixed 2026-09-13.** Both halves. `resolveOrMintPage` (`ops/block-move-to-page.ts`) looks for a
live page under the key the new page would be stored with, whatever its `journal_day`, before
minting a create — the ordinary `2026-09-07` page is the target. And all three handlers apply
their batch through `ops/apply-all-or-nothing.ts`: inside a savepoint, rolled back before the
`invalid` error is thrown, so a rejected op leaves nothing behind. The three rollback tests inject
the rejection with a `beforeWrite` hook that points one move at a missing page, and assert the
`op` and `changes` row counts are unchanged. All four tests fail without the fix. mcp-tools.md
§4.3.25–27 errors updated.

**Still open, found while fixing (same root cause as the trigger):** an ordinary page named like an
ISO date is unreachable by that name over the wire. `resolvePageRef` step 1 routes a wire date to
`DataApi.pages.journal`, which looks for a journal row only: `page.read {page: "2026-09-07"}` → 404,
and `page.append` → **500** `journal: failed to read back created page`, because its journal
`page.create` is rejected as a key collision. Probed with a throwaway test on this branch; not
fixed (the refactor ops now look the page up by stored key, the read/append door is
`ops/resolve.ts` and `DataApi.pages.journal`, shared by many ops). A fix would try the stored key
before minting, as `resolveOrMintPage` now does, and decide whether a date-named ordinary page
should shadow the journal day or be reported as a conflict.

---

### B-121 · A page deleted by a plugin comes back from the trash without its blocks
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M7 server/sync review (F9) ·
**Test:** `packages/server/src/data-api-delete-instant.test.ts` "a page deleted through ctx.data
comes back from the trash with all its blocks" and "a subtree deleted through ctx.data comes back
whole"

`DataApi.pages.delete` and `DataApi.blocks.delete` (what plugins reach through `ctx.data`) call
`Date.now()` for every op they mint. `trash.restore` brings back a page's blocks — and a block's
descendants — only when their `deleted_at` equals the root's, which is how it recognises one delete
action. A plugin delete that spans a millisecond therefore restores a page with no blocks; the
blocks become separate trash entries. Probe: `Date.now` advancing 1 ms per call,
`api.pages.delete` on a 3-block page, then `trash.restore` → 1 entity restored, page empty.
`ops/page-delete.ts` and `ops/block-delete.ts` already take one `now`.

**Fixed 2026-09-13.** `DataApi.pages.delete` and `DataApi.blocks.delete` (both modes) take one
`now` per call and stamp it on every op. Both tests run the delete with `Date.now` advancing a
millisecond per call and fail before (1 of 4 entities restored; three trash entries instead of
one).

---

### B-120 · A block moved to another page loses its children when a second device reorders it on the old page
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, M7 server/sync review (F1, F2) ·
**Test:** `packages/server/src/subtree-page-repair.test.ts` "a later device reorder on the old page
wins, and the subtree comes back with it" and "a deleted child follows a cross-page move and
restores onto the parent's page, grandchild attached" (plus three more there, and
`packages/core/src/sync/apply-ops.test.ts` "block.place keeps a tombstoned parent it already has
(B-120)")

Device B has page `Src` synced and reorders block `x` on `Src` (offline, or just before its next
pull). Meanwhile an agent or the menu moves `x` to `Dst` with `block.move_to_page`, which moves the
whole subtree (B-85). B's `block.place` for `x` carries the later HLC, so it wins and `x` goes back
to `Src` — but its children stay on `Dst` with `parent_id = x`. Neither page's tree query finds
them, they are not in the trash, and `verify` is clean because the op log is self-consistent.
Probe: `Src '- a / - x / - c1 / - g / - c2'`, move `x` to `Dst` (4 moved), then a later-HLC device
`block.place x {Src, null}`: applied, 0 corrections; `Src` reads `[x, a]`, `Dst` reads `[d]`.

B-85's fix lives in the op layer (`data-api.ts#subtreePlaceOps`) and so covers only moves the
server itself plans; any `block.place` arriving by sync that changes a block's page leaves the
same orphans.

The same walk also skipped **tombstoned descendants** (F2): `subtreePlaceOps` reads children
through `siblingRows`, which filters `deleted_at IS NULL`. Delete `c1` under `p`, move `p` to
`Dst`: `c1` keeps `page_id = Src` with `parent_id = p` (on `Dst`). `trash.list` still offers it
(its page and parent are live); `trash.restore c1` answers 200 `{page: "Src"}`, and `c1` is then on
neither page and no longer in the trash. Same for `block.move`, `block.to_page`, `page.merge`.

**Fixed 2026-09-13.** A second server repair pass in `serverApplyOps`, next to rule 24's cycle
correction (`packages/server/src/subtree-page-repair.ts`): for every block that changed page in
the batch (an applied `block.place` whose page differs from the block's pre-batch page — which
also catches a batch that moves a block away and back), each descendant, tombstoned ones included,
that sits on a different page than its parent gets a server-HLC `block.place` keeping its parent
and order and taking the parent's page, minted parent-first. They apply in the same transaction,
are logged (replay parity holds), recorded in `changes` with the batch (so `batch.undo` of the move
reverses them) and returned as `corrections` (so the pushing device converges). For the tombstoned
half, core's `resolvePlace` now keeps a tombstoned parent when it is the parent the block already
has (research/03-sync.md: "descendants stay attached and hidden"); without that, a deleted
grandchild's repair op fell back to the top level. A move under a *different* deleted parent still
falls back. sql-schema.md rule 24 updated. Every server test named above fails without the pass.
Real graph (copy): 0 rows whose page differs from their parent's (no migration needed); moving the
largest subtree (961 blocks, a 6-block tombstoned child) away and back with device ops leaves 0
mismatches and `verify` clean (`tools/probes/subtree-page-repair-real-graph.ts`); `verify` clean
over the owner's 20,411 ops with the new `resolvePlace`.

---

### B-109 · `--no-mirror` never did anything
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream — served `docs/wiki`
with the flag and found 21 files in `pages/` · **Test:** `packages/server/src/cli.test.ts`
"parseArgs: --no-<flag> sets <flag> to false"

`parseArgs` knew `--flag` and `--flag value`; `--no-mirror` became a key called `no-mirror` that
nothing read, while `config.mirror.enabled` tested `flags.get("mirror") !== false`. Harmless while
`serve` never wrote the mirror; the moment B-95 made it write, the documented way to turn it off
was a no-op. `--no-<x>` now sets `x` to `false`.

**Status:** fixed (a regression of the B-109 fix, fixed again) · **Severity:** low · **Found:**
2026-09-13, server security review (F6) · **Test:** `packages/server/src/cli-args.test.ts`
"parseGcFlags (B-109 follow-up …)", "--flag=value is the flag with that value, split at the first
=", "checkFlags"

Follow-up: B-109's fix (`--no-x` becomes `flags.x = false`) left `nooklet gc` reading
`flags.get("no-backup")`, a key that no longer exists, so the documented `--no-backup` silently did
nothing (fails safe: a backup was always taken). The grammar also never split `--flag=value`, so
`nooklet gc --dry-run=true` became a flag named `dry-run=true`, `dryRun` was false, and gc dropped
ops and unlinked orphan assets — the flag meant to make gc safe ran the destructive action.

**Fixed 2026-09-13.** `cli-args.ts`: `parseArgs` splits `--flag=value` at the first `=`;
`parseGcFlags` maps gc's flags (`noBackup` is `backup === false`) and lives beside the grammar so
the wiring is tested, not buried in `cli.ts`'s module body; `checkFlags` makes `gc` and `restore`
refuse any flag they do not know; `booleanFlag` accepts bare, `--no-x` and `=true|false|yes|no|1|0`
and rejects anything else. Reproduced first on a copy of the owner's graph with the old code:
`nooklet gc --no-backup` wrote `backups/nooklet-backup-….tar.gz`, and `nooklet gc --dry-run=true`
dropped 20,404 of 20,411 ops. With the fix, on a fresh copy: `--dry-run=true` says "would drop" and
the op table keeps 20,411 rows, `--dryrun` stops with `nooklet: unknown flag --dryrun`, and
`--no-backup` takes no backup. `docs/OPERATIONS.md` §5 says so. Tests: `cli-args.test.ts`
"parseGcFlags (B-109 follow-up: gc's flags went through a grammar that changed under them)" (3),
"--flag=value is the flag with that value, split at the first =", "checkFlags".

---

### B-129 · A deeply nested or very long query fence throws out of `parseQuery` or breaks the SQL prefilter
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, server security review (F7) ·
**Test:** `packages/core/src/query.test.ts` "refuses a query nested too deeply or with too many
filters, in words, without throwing (B-129)"; `e2e/tests/query-limits.spec.ts`

`query.ts` promises "never throws", but `Parser.parseUnary` recurses once per `(` and `not` with no
depth cap: 20,000 nested parentheses or 30,000 `not`s overflow the stack, and `parseQuery` re-throws
the `RangeError` instead of returning `{ ok: false }`. `joinSql` emits a flat `a AND b AND …`, so
1,001 `not`s or ~1,000 juxtaposed words produce SQL that SQLite refuses ("Expression tree is too
large (maximum depth 1000)"). Query fences are block content, sync to every device, and any writer
(an MCP agent included) can author one; the client parses them in a `createMemo`
(`QueryFenceView.tsx`).

What it looked like in the app (seen in Chromium against the real server before the fix, via
`e2e/tests/query-limits.spec.ts`): the page itself survived, but both fences — 5,000 nested
parentheses, and 1,000 words — rendered as raw code with no query view and no error, so the
reader was never told why the query did nothing.

**Fixed 2026-09-13.** `query.ts`'s `Parser` counts nesting (`(` and `not`/`-`) and filters, and
refuses past 32 levels or 100 filters with a `ParseError` in words ("query is nested too deeply
(more than 32 levels of parentheses and "not")", "query has too many filters (more than 100)"),
checked before recursing so the stack is never at risk. At those limits the prefilter's SQL stays
far inside SQLite's depth of 1,000. ADR 011 records the limits. Tests: `query.test.ts` "refuses a
query nested too deeply or with too many filters, in words, without throwing (B-129)" (threw
`RangeError` before), "the largest query the parser accepts compiles to SQL that SQLite accepts
(B-129)"; `e2e/tests/query-limits.spec.ts` (2 — both failed before, `.vr-query-error` not found;
pass after, with `query.spec.ts` 9/9 alongside).

---

### B-128 · `graph.replace` regexes are compiled without the `u` flag, so Unicode classes silently match nothing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, server security review (F8) ·
**Test:** `packages/server/src/ops/graph-replace.test.ts` "regexes run in Unicode mode, so \p{…}
classes and whole-word lookarounds work on Czech (B-128)"; `e2e/tests/replace-unicode.spec.ts`

Flags are `g`/`gi`. Without `u`, `\p{Lu}` is an identity escape for the literal text `p{Lu}`, so
`\p{Lu}\p{Ll}+` previews zero matches on "Schůzka s Alešem: Černá kniha" with no error. `\w` and
`\b` are ASCII-only either way, so `Ale\w+` misses "Alešem" and `\bAleš\b` matches inside it — a
real run would rewrite part of a longer word — and the op description does not say so.
`FindReplaceView`'s highlight matcher uses the same flags.

**Fixed 2026-09-13.** `compileQuery` compiles with `gu`/`giu`, and `FindReplaceView`'s highlight
matcher uses the same flags so the marks agree with the preview. The op description (and
`mcp-tools.md` §4.3.28) now says the regex is in Unicode mode, that `\w`/`\b` are still ASCII-only,
and gives the whole-word form `(?<![\p{L}\p{N}_])word(?![\p{L}\p{N}_])` that `page.link_unlinked`
already uses. A pattern that was only valid without `u` (`\-`, a lone `{`) is now `invalid` with
the engine's message. On the copy of the owner's graph `Č\p{Ll}+` (case-sensitive) matched 0
blocks before and 17 after; a literal `TODO` still matches 437. Tests: `graph-replace.test.ts`
"regexes run in Unicode mode, so \p{…} classes and whole-word lookarounds work on Czech (B-128)"
(0 matches before); `e2e/tests/replace-unicode.spec.ts` (showed "No matches." before; passes after,
with `replace.spec.ts` 3/3).

---

### B-127 · The Logseq importer follows symlinks in `assets/` out of the graph, and one dangling symlink aborts the import
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, server security review (F3) ·
**Test:** `packages/server/src/importer/logseq.test.ts` "does not follow a symlink in assets/ out of
the graph (B-127)", "a dangling symlink in assets/ is a warning, not an aborted import (B-127)",
"does not follow assets/ itself when it is a symlink (B-127)"

`importAssets` checks `statSync(path).isFile()`, which follows symlinks, then reads the target. A
symlink in a graph's `assets/` pointing anywhere (say `~/.ssh/id_ed25519`) is stored as an asset,
served without authentication at `/assets/:id` (unauthenticated by design, `http/assets.ts`) and
synced to every device. A graph received from someone else is where such a link would come from.
Separately, the `statSync` sits outside the `try`, so a broken symlink (common in synced folders)
throws `ENOENT` out of `importLogseqGraph` after some assets were already stored.

**Fixed 2026-09-13.** `importAssets` lists `assets/` with `withFileTypes` (Dirent types come from
lstat) and skips a symbolic link with the warning `assets/<name>: a symbolic link, not followed`,
so a dangling one no longer throws; an `assets/` directory that is itself a link is not followed
either (warning, nothing imported). Pages and journals were already listed by Dirent and so never
followed links. The owner's Logseq graph has no symlinks in `assets/` (180 entries, 0 links):
importing it into a scratch data dir gave 127 pages, 825 journals, 18,628 blocks, 171 assets,
0 dangling asset links, no symlink warnings. Tests: `importer/logseq.test.ts` "does not follow a
symlink in assets/ out of the graph (B-127)", "a dangling symlink in assets/ is a warning, not an
aborted import (B-127)", "does not follow assets/ itself when it is a symlink (B-127)" — the first
and third failed on the old code with an asset row created, the second with `ENOENT … stat`.

---

### B-126 · A page name longer than NAME_MAX stalls the live mirror, leaks a temp file per sweep, and makes `nooklet export` throw
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, server security review (F2) ·
**Test:** `packages/server/src/mirror/export.test.ts` "pages whose file cannot be written as named
(B-126)"; `mirror/live.test.ts` "a page name past NAME_MAX neither stalls later sweeps nor leaves
temp files behind (B-126)"

`pageFilePath` names the file `pageNameToFileName(name) + ".md"` with no byte limit. Page names
may be 512 characters, Czech letters take 2 UTF-8 bytes and unsafe characters become 3-byte
`%XX`, so a name easily exceeds the filesystem's 255-byte limit. `exportPage` writes the temp file,
`renameSync` throws `ENAMETOOLONG`, and the temp file is never removed. The error escapes
`exportAll`'s loop, so every page after it in the loop is not written and the stale-file prune
never runs (deleted pages keep their `.md`). The live mirror (B-95) sweeps after every commit and
the failing page never gets a `mirror_file` row, so each sweep leaves another `.xxxx.tmp` in
`pages/`; `nooklet export` aborts. `block.to_page` names a page after a block's first line, and
921 live blocks on the owner's graph have a first line over 252 bytes.

**Fixed 2026-09-13.** Three changes in `mirror/export.ts`. `pageFilePath` shortens a file-name base
past 200 UTF-8 bytes to a prefix cut on a code-point boundary (never inside a `%XX` escape) plus
`~<8 hex of sha256(name)>`, and `exportPage` then writes the full name into the file as `title::`
(what the Logseq importer reads a page name from), so the mirror stays lossless. `exportAll`
catches per page, reports `failed: [{ pageId, error }]` and still runs the prune; the live mirror
logs failures, `nooklet export` exits 1 when there were any. `exportPage` unlinks its temp file
when the rename throws. The new tests fail on the old code with `ENAMETOOLONG`, `EISDIR` and a
leaked `.tmp`. On a copy of the owner's graph (longest page name 111 bytes) `nooklet export` wrote
all 952 pages with `failed: []` and no shortened names. Tests: `mirror/export.test.ts` "pages whose
file cannot be written as named (B-126)" (3); `mirror/live.test.ts` "a page name past NAME_MAX
neither stalls later sweeps nor leaves temp files behind (B-126)".

---

### B-125 · `graph.replace` does unbounded work on the server's only thread: a backtracking regex freezes it, a long replacement balloons memory
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, server security review (F1, F5) ·
**Test:** `packages/server/src/ops/graph-replace.test.ts` (the four B-125 cases),
`graph-replace.race.test.ts`, `replace-scan.test.ts`

**Time (F1).** `compileQuery` rejects only invalid patterns and patterns that match the empty
string. The handler then runs `matchAll`/`replace` synchronously over every live block (18.6k on
the owner's graph). A pattern with nested quantifiers backtracks exponentially on ordinary text,
and while it does, the one Node process answers nothing: not `/healthz`, `/sync`, the web UI, or
MCP. `(a+)+$` over one block of 24 `a`s and a `!` took 2.3 s and `/healthz` was answered only
after it; `(\w+\s?)+:` against a copy of the real graph was killed after 60 s (`\w` is ASCII-only,
so every Czech letter is a backtracking point). `FindReplaceView` sends a `dry_run` 250 ms after
typing stops, so a half-typed pattern is enough; `dry_run` runs the same scan.

**Memory (F5).** The handler builds the replaced text of EVERY matching block before comparing the
count with `max_blocks`. A one-letter query with a 2,000-char replacement on the real graph built
about 1 GB of strings (rss 1,074 MB) to answer 413 `too_large`, even with `dry_run`. When
`max_blocks` is raised and the call goes through, the rewritten text is written with no size
check (`block.update` caps content at 100,000 chars; `graph.replace` checked nothing).

**Fixed 2026-09-13 (time).** The scan — literal and regex alike — runs in a `worker_threads`
Worker (`ops/replace-scan.ts`) that is terminated after 2 s; a regex timeout is 400 `invalid`
("the pattern took too long to run"). The worker body is an eval'd JavaScript string: tsx injects
`__name` helpers into a TS function's `toString()`, and a worker file would not survive the
desktop sidecar's single-file bundle. Awaiting the worker opened a gap between the SELECT and
`applyOps` in which a `/sync/push` (which does not take `writeLock`) could edit a matched block, so
the real run re-reads the matched blocks just before writing and answers 409 `conflict` if any
changed. Before the fix the new test, at 25 `a`s, saw `/healthz` answered after 5,010 ms; after,
the 40-`a` case is refused in ~2 s with `/healthz` answered at once. On a copy of the owner's graph
`(\w+\s?)+:`, `(\S+\s*)+\?` and `^(.*?,)*x$` (each killed after 60 s before) return `invalid` in
2.1–2.3 s. Cost: a `TODO` dry run went from ~75 ms to ~120–250 ms with the machine at load 24
(~20 ms of worker overhead idle). Tests: `graph-replace.test.ts` "a backtracking pattern is refused
within the time budget, and the server answers meanwhile (B-125)"; `graph-replace.race.test.ts`
(fails with 200 instead of 409 when the re-check is disabled).

**Fixed 2026-09-13 (memory).** The worker (`ops/replace-scan.ts`) now takes limits: past
`max_blocks` it stops holding replaced text but keeps counting (the error's `blocks_matched` stays
exact); it stops outright past 20 M characters of held text; it refuses a block the replacement
grows past 100,000 characters — `block.update`'s cap — while still allowing an edit that does not
grow an already longer block (the owner's graph has a 120,016-character block); and its heap was
capped at 256 MB (wrongly — see the correction below). All of it applies to
`dry_run` as well. On a copy of the owner's graph (`scratchpad/.../p10-replace-memory.mts`), a
query `e` with a 2,000-character replacement peaked at 1,091 MB rss before and 209 MB after; with
`max_blocks: 20000` it used to succeed at 2,001 MB and would have written blocks of up to 250,949
characters, and is now 413. Tests: `graph-replace.test.ts` "refuses a replacement that would grow
a block past the content cap, even in a dry run (B-125)" (200 before), "still edits a block that is
already past the cap, as long as the edit does not grow it", "a replacement too large to even
build is too_large, and the server carries on (B-125)" (200 before); `replace-scan.test.ts` (4).

**Corrected 2026-09-13 — the heap cap in that fix aborted the process.** Found while checking which
limit the last test above actually hit (`scratchpad/.../p12-explode-path.mts`): it was the
per-block cap, after a 200 M-character string had been built in 39 ms. One block of 199,000
characters (page.create allows 200,000) times a 2,000-character replacement is ~398 M characters,
and at `resourceLimits.maxOldGenerationSizeMb: 256` V8 did not end the worker with
`ERR_WORKER_OUT_OF_MEMORY` — it aborted the whole process ("FATAL ERROR: Reached heap limit",
SIGABRT, exit 134), over plain HTTP. `tools/probes/worker-heap-cap-abort.mjs one` reproduces it
(many small allocations, `many`, do end only the worker; the replace alone, without the scan's
preceding `matchAll`, survives — whether it aborts depends on what else is on the heap). The heap cap is gone (it would also have aborted the server
on a graph whose text alone outgrew 256 MB). Instead the worker computes each block's replaced
length from its matches before building it — `replacement.length − match` for literal text, and
ECMA-262 GetSubstitution lengths (`` $$ $& $` $' $n $nn $<name> ``) for templates — refuses an
oversized block unbuilt, and throws if a built string ever disagrees with the computed length.
With it, 199,000 and 280,000-character blocks (398 M and 560 M characters) are `block_too_long` in
~25 ms, and the owner's-graph probes are unchanged (peak rss 225–271 MB). Tests: `graph-replace.test.ts`
"a block the replacement would blow up to hundreds of megabytes is refused unbuilt, and the process
lives (B-125)" (aborted the vitest worker with SIGABRT before), `replace-scan.test.ts` "computes
every block's replaced length before building it, exactly, for every $-template form" (fails with
"computed 70 characters but built 72" when the two-digit `$nn` rule is removed).

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

### B-268 · Markdown links render `javascript:` URLs as clickable hrefs
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q9) · **Test:**
`e2e/tests/link-scheme.spec.ts` "a javascript: link renders without an href; web and mail links
keep theirs", `apps/web/src/editor/render/safe-href.test.ts` (3 tests),
`apps/web/src/app/follow-link.test.ts` "opens web links and refuses javascript: ones"

`click [me](javascript:document.title='PWNED') here` renders
`<a class="vr-link" target="_blank" rel="noopener" href="javascript:…">`. In headless Chromium the
click opened `about:blank` and did not run in the app origin, so it was not exploitable there;
WKWebView (the Tauri app) was not tested. Content arrives from sync and from MCP agents, so the
renderer should not hand an arbitrary scheme to the browser.

**Fixed 2026-09-13.** `render/tokens.tsx`'s `link` case passed the URL through `assetUrl` and
straight into `href`; the "follow link at caret" command (`app/hosts.ts#followLink`) likewise gave
any `url` link to `window.open`. Both now go through `editor/render/safe-href.ts`: a blocked scheme
leaves the `<a>` with no `href` (the label stays, inert) and the command does nothing. Blocked:
`javascript`, `vbscript`, `data`, `blob`, `filesystem`, read the way the URL standard reads a
scheme (edge C0/space stripped, tabs and newlines removed, case folded), so `" JaVa\tscript:"` is
caught too. A denylist rather than the http/https/mailto allowlist QA suggested: every other scheme
only hands off to the OS, and note-takers link to apps (`zotero://`, `obsidian://`); an allowlist
would break those silently. The owner's graph uses only `https` (2,114), `http` (338), `mailto` (12)
and `tel` (5), all still live. Autolinks were already safe — the tokenizer only makes them from
`http://`/`https://`. Images were left alone (`javascript:` in `img src` does not run). The e2e
test failed before the fix (`href="javascript:document.title='PWNED'"`). WKWebView still not tested.

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

### B-266 · `SCHEDULED: <2023-2-17 Fri>` (no zero padding) is not recognised
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exploratory QA (Q7) · **Test:**
`packages/core/src/outline.test.ts` "reads org timestamps without zero padding, and stores them
padded", `packages/server/src/importer/logseq.test.ts` "imports SCHEDULED/DEADLINE dates and hours
written without zero padding"

**Superseded by B-143's implementation**, which also rejects impossible dates and times; both tests were kept.

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
Real graph (fresh copy, this build): renaming `Alex/Notes` (11 backlinks) from its title kept all
11 under the new name, `page.read "Alex/Notes"` resolves to `Alex/Notes QA`, and the mirror file
moved. That run also showed the "doesn't exist yet" view for one ~100 ms sample right after the
navigation: the guard was reset in a `finally` before the new name's lookup had started. It is now
cleared when the page resolves; a rerun sampled no flash (timing-based, one run — no test pins it).

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

### B-244 · `[[` "New page" on a client still pulling its first sync writes `]]` to the database but not the editor
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q5) · **Tests:**
`e2e/tests/autocomplete-busy-replica.spec.ts` "New page links at once and keeps what is typed next,
even while the replica is busy (B-244)"; `apps/web/src/commands/autocomplete/AutocompletePopup.test.tsx`
"New page links and dismisses at once, without waiting for the page to be created (B-244)"

Fresh browser profile on the real graph, within the first seconds after load: type ` [[new/page`
and accept the "New page" row (Enter, Tab or click). The page is created and the server briefly
stores `x [[new/page]]`, but the editor still shows `x [[new/page` and the popup stays open. The
next keystroke commits the editor's buffer over it: stored `...testing [[new/pages/child after`,
an unclosed link. Accepting an existing page works; a warm client works (0/4). The owner's B-42
report was exactly `testing [[new/page`, so this may be what they hit.

**Fixed 2026-09-13.** Reproduced on a copy of the real graph with QA's `t2.mjs` against this
branch's build: EnterNew and ClickNew left `x [[qa-new/…/a` with the popup open. A timeline probe
showed why: `selectRow` awaited `pages.createPage()` before inserting the link, and that call is a
round trip to the replica worker, which answered after ~3.3 s while busy (a cold bootstrap, and
the popup's own per-keystroke block search over 18.6k blocks); after the worker went idle the same
accept took one frame. Nothing about the link needs the page to exist first (refs are keyed by
page name, `ref.dst_page_key`), so the popup now inserts `[[title]]` and dismisses synchronously
and creates the page in the background (failure is logged; a link to a missing page is an
ordinary state). The e2e test keeps the worker busy for 3 s with a synchronous loop evaluated in
it (`worker.evaluate`), presses Enter, and requires the link within 1.5 s: it failed before
("x [[busy-replica/…" after 1.5 s) and passes 3/3 after. Rerun of `t2.mjs` on the real graph after
the fix: EnterNew, TabNew, ClickNew, EnterExisting all show `x [[…]]` with the popup closed. The
same rerun is what exposed B-247 below. Whether this is what the owner saw as B-42 (focus loss) is
not established: focus stayed in the editor in every run here.

---

### B-243 · On a fresh client, text typed into today's journal draft vanishes when sync says today exists
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q4) · **Tests:**
`e2e/tests/journal-draft-sync.spec.ts` "text typed into today's draft survives the first sync
saying today already exists (B-243)"; `apps/web/src/views/VirtualJournalDay.test.tsx` "torn down
with text nobody committed (B-243)" (4 tests)

The server already has today's journal with blocks. A fresh browser (empty OPFS) opens
`/journals`, the local replica does not have today yet, so the virtual draft shows; click it and
type. When the initial pull lands, the draft is replaced by the real outliner and what was typed is
in neither the UI nor the server. Focus falls to `<body>`; the sync indicator says "synced".

**Fixed 2026-09-13.** The stream picks draft or outliner from the local replica, and the draft
committed only on blur or Enter. When the snapshot flipped today to "exists", `<Show>` disposed
the draft with its text uncommitted, and nothing else looked at it. `VirtualJournalDay`'s cleanup
now keeps a non-empty uncommitted draft: it appends it as the last top-level block of the day's
page the replica now has (`data/journal-day.ts#appendToJournalDay`, an ordinary `block.create`
through `applyOps`) and, if the draft held the caret, requests focus there so typing continues at
its end. With no page for the day (unmounted for another reason) it commits the normal way. The
blur that removing a focused textarea can fire is ignored after disposal, so there is one writer.
The e2e test holds `/sync/snapshot` with `page.route` (the route reaches the sync worker's fetch)
to open the same window the 952-page graph opens by being big; it failed before (text not stored)
and passes after, 3/3 with `--repeat-each=3`.

Not covered, and not verified either way: (a) the draft committed (blur/Enter) *before* the
snapshot lands, which creates a second page for a day the server already has; core rejects a
`page.create` whose key is taken, so the typed blocks likely fail on push. (b) QA's `t7.mjs` saw
text typed immediately after Enter on a just-materialised day lost (second block stayed empty);
`a-fresh-journal.spec.ts` covers Enter-then-type but waits for focus first.

---

### B-242 · Undoing Alt+Up/Down drops editor focus; the next keystrokes are lost
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exploratory QA (Q3) · **Test:**
`e2e/tests/undo-redo.spec.ts` "typing right after undoing or redoing Alt+ArrowDown lands in the
moved block (B-242)" (and the Alt+ArrowUp variant)

Editing `one` on `one, two, three`: Alt+Down moves it (focus kept, B-68), Cmd+Z moves it back and
the row still shows the editor, but `document.activeElement` is `<body>`. Typing `X` goes nowhere.
Undoing a Tab indent keeps focus.

**Fixed 2026-09-13.** Undo and redo of a move reorder the edited row exactly like the move itself:
the keyed `<For>` moves the row's DOM node, which blurs it. B-68's deferred refocus lived only in
`doMoveStep`; when undo/redo target the block already being edited, `doUndo`/`doRedo` just placed
the caret. The refocus is now `BlockTree.tsx#refocusAfterReorder`, called from all three. Undo of
an indent kept focus because a depth change updates the row in place. Both e2e variants fail
without the change (the X is never stored) and pass with it.

**Second cause, fixed the same day.** The Alt+ArrowUp variant then failed 2 of 2 inside a loaded
15-spec run. A focus/MutationObserver trace around the undo showed the rest of it: 10-50 ms after
the undo, a page-tree refetch that had read before the undo resolved and put the old order back,
and the next refetch restored the new one. Two more DOM moves, a `focusout` each, no `focusin`
(5 of 6 traced runs). A keystroke in that window was lost; under load the window is where the
next keystroke lands. The refetch effect now refocuses the edited block after it replaces the
rows, when the editor had focus going in (`refocusAfterReorder` again, so a real click-away is
never fought). The test now also waits 400 ms after the undo and after the redo, checks focus
synchronously, and types again: without this change Alt+ArrowUp fails there ("activeElement is
body"), with it the spec passed 6/6 in three separate runs. The flicker itself (rows jumping for
a frame) is still there; only its focus loss is fixed.

---

### B-241 · Cmd+Z does nothing after deleting a block selection; the undo fires later instead
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q2) · **Tests:**
`e2e/tests/undo-redo.spec.ts` "Cmd/Ctrl+Z right after Delete on a block selection brings the blocks
back (B-241)" (and the Backspace variant), "Cmd/Ctrl+Z after clicking away still undoes the last
edit on the page (B-241)"; `apps/web/src/app/editor-host.test.ts` "undo/redo after the editing
session ends (B-241)"

Select two blocks (Escape, Shift+Down), press Delete or Backspace: both go. Cmd+Z does nothing,
and focus is on `<body>` or the outliner. Much later, Cmd+Z while editing a different block brings
the deleted blocks back, which is the wrong moment. A user who deletes a selection by mistake sees
undo do nothing. Same cause, found while writing the test: type into a block, click away (which
ends editing since B-74), Cmd+Z: nothing.

**Fixed 2026-09-13.** `edit.undo` reaches the tree through the active `EditorHost`, and a tree
withdraws as the active host as soon as nothing in it is edited or selected, which is exactly what
deleting a selection, clicking away, or an undo that leaves nothing focused do. The keystroke went
to the inert no-op host while the tree's history kept the step. Undo and redo now fall back to the
tree whose session ended most recently (`editor-host.ts#historyEditorHost`), cleared when that
tree unmounts (`releaseEditorHost`, which also stops an unmounting tree from nulling another tree's
active registration). The fallback does not take Cmd+Z typed into an `<input>`/`<textarea>`
outside the outliner. The tree runs `edit.undo`/`edit.redo` arriving with neither an edit nor a
selection. The e2e tests fail without the change (3/3) and pass with it.

---

### B-240 · Redo of an undone new block shows it on screen, but the server never gets it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, exploratory QA (Q1) · **Tests:**
`e2e/tests/undo-redo.spec.ts` "redo of an undone Enter puts the block back on the server, not just
on screen (B-240)"; `apps/web/src/editor/history.test.ts` "create -> undo -> redo leaves the block
alive in a real database, every time (B-240)"

On `- one` / `- two`: Enter after `one`, type `mid`, Cmd+Z twice (the text, then the split: the
block goes), Cmd+Shift+Z twice. The screen shows `one, mid, two`; `page.read` returns `one, two`;
a reload shows `one, two`, so `mid` is lost. No console error. The op log for the block: create,
text, text, delete (the undo), then the redo's `block.create` logged as **noop**, then its text
applied to a block that is still a tombstone.

**Fixed 2026-09-13.** Redo re-minted the transaction's forward ops verbatim, so it re-sent the
original `block.create` for an id that already existed as the undo's tombstone; `applyOps` inserts
with `INSERT OR IGNORE`, so server and local replica did nothing while `optimistic.ts` put the row
back on screen. Redo now sends a create in its undelete form (`block.delete` with `deletedAt:
null`, `invert.ts#redoRecipe`), the op that actually reverses the undo. The existing unit test
asserted the redo was a `block.create`, i.e. it pinned the bug; it now asserts the undelete, and a
new one round-trips create/undo/redo twice through core `applyOps` on real SQLite. The e2e test
checks the server and a reload, which is what would have caught it.

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

### B-154 · `/template` in an empty block that has properties inserts the template after it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, same verification · **Test:**
`apps/web/src/commands/registrations/templates.test.ts` "an empty block with properties still takes
the template into itself (B-154)"

`templates.ts` decides "apply into this block" by `content.trim() === ""` on the editing text. An
empty numbered item's buffer is `\nlist:: number`, so it counted as non-empty and the template's
blocks went in after it, leaving an empty numbered bullet behind (browser: rows `1. first`, `2.`,
`Standup`, …).

**Fixed 2026-09-13.** The emptiness check reads the content part of the editing text
(`splitBlockText`), and the template's text replaces that content through `onContent` (B-153), so
the block keeps its own properties and the caret ends after the text. The unit test was red before
the fix; in the browser the scratch check now gives rows `1. first`, `2. Standup`, `yesterday`,
`today`.

---

### B-153 · `/code`, `/query` and `/h1`–`/h3` treat a block's property lines as its text
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-render` · **Test:** `e2e/tests/block-properties.spec.ts` "/code, /query and /h1 change the
text and leave the properties alone (B-153)"

Since B-101 the editor host's `getSelection().content` is the block's editing text, property lines
included, and three commands transform that whole string (`insert-logic.ts`). Seen in the browser
before the fix: `/code` on a numbered item stored `` ```\nnpm install \nlist:: number\n``` `` with
no properties (the numbering was gone, its line was code); `/query` on a block with `owner:: Dan`
stored `` ```query\nowner:: Dan\n``` ``; `/h1` on a numbered item left the caret at the end of the
buffer — the end of the `list:: number` line — so the next word typed was stored as
`list:: numbermore` and the item stopped being numbered.

**Fixed 2026-09-13.** `commands/registrations/insert-logic.ts#onContent` splits the editing text,
runs the command's transform on the content alone, writes the property lines back in their
canonical place (`joinBlockText` — after the fence for a fenced block) and maps the caret from
content into the result; `insert.ts` wraps the three commands in it. A text without property lines
passes straight through. The e2e test was red before the fix (`list:: number` inside the fence, no
properties); unit: `insert-logic.test.ts` "onContent (B-153)".

---

### B-152 · Editing a block whose property value has a line break moves the value's tail into the text
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-render` · **Test:** `e2e/tests/block-properties.spec.ts` "a property value the buffer
cannot show as one line survives editing the block (B-152)"

Since B-101 the editor's buffer writes every generic property as a `key:: value` line and splits the
buffer back with the parser's line rules on flush. A value that does not survive that trip as the
same property is corrupted by the first keystroke. `block.update` accepts any string as a value
(`schemas.ts#PropertiesPatch`), so an agent can set `summary:: line1\nline2`; the buffer then reads
`title\nsummary:: line1\nline2`, the split takes `line2` as content, and typing one character wrote
`block.text "title!\nline2"`. Seen in a real browser before the fix: `page.read` after one `!`
returned `content: "title!\nline2"`. (The `summary` value itself was not rewritten only because a
refetch had already folded the truncated value into the local tree, so the diff saw no change.)
A value with leading/trailing whitespace is silently trimmed the same way, and a key the line regex
cannot read back (an imported `_foo`, normalized to `-foo`) is moved into the text and deleted.

**Fixed 2026-09-13.** `core/block-text.ts#showsInEditText(key, value)`: a property goes into the
buffer only if its `key:: value` line reads back as exactly that key and value. The others are
treated like `heading` — left out of `joinBlockText`, carried over untouched by
`editText.ts#withEditText`, and never deleted by `blockTextPayloads`. Typing a `summary:: x` line
still overrides one. The e2e test was red before the fix (the buffer read
`title\nsummary:: line1\nline2`); unit: `block-text.test.ts` "properties whose line would not read
back as themselves (B-152)", `editText.test.ts` "keeps a multi-line value out of the buffer".

---

### B-150 · Image paste uploads without a credential, so it cannot work in the served app
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, reading `editor/paste.ts` while
wiring `/image` (B-99) · **Test:** `e2e/tests/image-insert.spec.ts` "pasting an image uploads it
with the client's credential and inserts it (B-150)"

`editor/paste.ts#uploadImageAsset` calls `fetch("/api/v1/asset.upload")` with no `authorization`
header. Every `/api/v1/*` route sits behind `bearerAuth` (`packages/server/src/http/app.ts`), so
the served app gets a 401 and the paste is silently dropped (the catch only logs to the console).
Nothing covered it: no e2e test pastes an image, and `assets.spec.ts` uploads through its own
authenticated helper. Same class of defect as the "client has no API credential" bug the e2e suite
was created for.

Confirmed at runtime before the fix: a synthetic image paste in the served app produced
`asset.upload -> 401` with no `authorization` header, and the block kept only its text.

**Fixed 2026-09-13.** `uploadImageAsset` goes through `data/api-client.ts#callOp`, which sends this
device's token and turns failures into `ApiError`. The e2e test pastes a PNG through a real
`ClipboardEvent` and reads the stored markdown back through `page.read`; it was red before the fix.

---

### B-99 · `/image` does nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D5)

`block.insertImage` is registered and delegated to the editor host, but `BlockTree.tsx` has no
case for it — no file chooser, text unchanged. The paste path (`editor/paste.ts#uploadImageAsset`)
already uploads; the slash item should open a file picker and reuse it.

`/image` does nothing. **Test:** `e2e/tests/image-insert.spec.ts` "/image opens a file chooser and
inserts the uploaded image at the caret (B-99)"; `apps/web/src/editor/imagePicker.test.ts`

**Fixed 2026-09-13.** `block.insertImage` is now handled where it is delegated
(`BlockTree.tsx`'s editor host `runStructural`): `editor/imagePicker.ts#pickImageFile` opens the
platform's own chooser through a hidden, connected `<input type="file" accept="image/*">` (no
Tauri/Capacitor-specific host needed), and the picked file goes through the paste path's
`uploadImageAsset` and the new `insertUploadedImage`, which inserts at the live caret — or, if the
editor moved to another block while the upload ran, into the original block at the caret it had
(paste used to drop the image into whichever block was being edited when the upload landed).
The e2e test was red before the fix (`page.waitForEvent("filechooser")` timed out). Not done:
drag-and-drop of an image file onto a block (the audit's "can follow").

---

### B-101 · Block properties are invisible in the UI, and `/property` writes literal text
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D7)

A block with `foo:: bar` renders only its first line; the editor buffer has no property; and
`/property` inserts `key:: bar` into the CONTENT, which never becomes a property (`page.read`
shows it inside `content`, `properties` empty). Two halves: render property chips on the row and
make the editor's flush route `key:: value` lines through the outline parser's property handling.

Block properties are invisible in the UI, and `/property` writes literal text. **Test:**
`e2e/tests/block-properties.spec.ts` "show as chips under the block, and as key:: value lines while
it is edited", "a typed key:: value line is stored as a property, not as text", "/property inserts a
line that becomes a real property (the audit's D7 repro)", "editing a value and deleting a line
change and remove properties; undo restores"; unit `packages/core/src/block-text.test.ts`,
`apps/web/src/editor/editText.test.ts`, `commands/registrations/insert-logic.test.ts`

**Fixed 2026-09-13.** Both halves, on the seam B-100 opened (`EditableBlock.properties`):
- *Seeing them.* `editor/BlockProperties.tsx` renders a block's properties as compact muted
  `key: value` chips under its rendered content (values through `InlineContent`, so `[[links]]`
  navigate; clicking elsewhere on the chips enters edit mode). Hidden: `list` (the ordinal says it)
  and the keys Logseq's own `hidden-built-in-properties` hides (`hl-*`, `ls-type`, `query-*`,
  timestamps). Chips sit under the *whole* content, not between line 1 and line 2 as in Logseq —
  the rendered view's click-to-caret mapping needs one view over the whole content.
- *Editing them.* While a block is edited its buffer is its editing text — content plus
  `key:: value` lines (new `markdown-grammar.md` OUT-22a, `packages/core/src/block-text.ts`). On
  flush the buffer is split back with the outline parser's own line rules and written as a
  `block.text` if the text moved plus one `block.prop` per property added, changed or removed,
  diffed against the block as the edit began (so a property set elsewhere meanwhile survives).
  `BlockTree.tsx` maps carets between buffer and content at the surface boundary (split at the
  caret, history carets, attach). Undo works on properties: `invert.ts` reads the prior value from
  `properties` (it inverted generic keys to `null`), `optimistic.ts` models generic `block.prop`,
  and `history.ts` merges coalesced transactions per field (replacing wholesale lost a property
  written earlier in the same typing burst).
- `/property` inserts `:: ` under line 1 and the existing property lines with the caret before it
  (type the key, End, the value); a `key` placeholder would itself be written as a property.
Reserved keys (`scheduled::` etc.) and `heading::` typed in the buffer stay text, as before (B-96/
B-102 own dates). Literal `key:: value` lines already sitting in some block's content (the old
`/property` output) become real properties the first time that block is edited — which is what the
same text in a file means. Also: Enter in a numbered item continues the list, and duplicate copies
generic properties (`commands.test.ts`).

---

### B-100 · Numbered lists never render
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D6)

`list:: number` is parsed and stored, but `BlockTree.tsx` hard-codes `listNumber: false` and the
client `BlockRow` carries no generic properties, so `numbering.ts` always has nothing to number.
Fix: project the property through the client row shape.

Numbered lists never render. **Test:** `e2e/tests/block-properties.spec.ts` "list:: number
siblings render 1, 2 and restart after a plain bullet"; `apps/web/src/db/worker-core.test.ts`
"carries each block's generic properties, not tombstones or reserved keys (B-100)"

**Fixed 2026-09-13.** The worker's page tree (`db/worker-core.ts#pageBlockTree`) now reads every
live block's non-null `block_prop` rows for the page in one query and hangs them on
`BlockTreeNode.properties`; `EditableBlock.listNumber` (always `false`) became
`EditableBlock.properties`, and `numbering.ts#isNumbered` reads `properties.list === "number"`.
Core's `BlockRow` is unchanged — the server shares it and reads properties its own way. The e2e
test would have caught it: before the fix a page seeded with `list:: number` blocks rendered zero
`.vr-list-number` (the audit's runtime check, D6). Side effect: Cmd+C on selected blocks now copies
their properties too (it wrote `properties: {}`).

Real graph (copy of the owner's, 952 pages): `tools/probes/real-graph-properties.mjs` opened the six
pages with the most numbered blocks plus three property-heavy ones in a real browser against
`nooklet serve`, and compared every rendered row with the database — ordinals recomputed from
`block_prop` and sibling order independently of the client, chips counted per block. 177 visible
numbered rows (Claude code queue 55, zahradni-domek 43, 2026-01-11 31, 2025-04-06 21, Megapage
21, a PDF-highlights page 6) and 70 rows with chips: 0 wrong. (OmnivoreSync's 357 numbered
blocks sit under collapsed parents, so none were visible.) A property typed into a real block
through the UI wrote exactly one
`block.prop` op; `nooklet verify` afterwards: OK, 20,412 ops.

Creating one in the UI: Enter in a numbered item continues the list (`commands.ts#splitBlock`), and
a "Numbered list" command (slash item and palette, `commands/registrations/numbered-list.ts`)
toggles `list:: number` — **Test:** `block-properties.spec.ts` "Enter at the end of a numbered
item makes the next item numbered too", "the Numbered list slash item numbers a block, and a second
use stops it"; `numbered-list.test.ts`. Not done: Enter on an *empty* numbered item does not end
the list (Logseq does); `popups.spec.ts`'s slash order gained the item.

---

### B-202 · An open tag page's "Pages tagged X" does not follow a `tags::` change made elsewhere
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying B-111 on a copy of the real
graph · **Test:** `e2e/tests/tagged-pages.spec.ts` "an open tag page follows another device
untagging and re-tagging a page (B-202)"

With `VerifyTag`'s page open, an agent's `page.update {page: "Remote Tagger", properties: {tags:
null}}` left "Remote Tagger" listed under "Pages tagged VerifyTag" for the 15 s the probe waited
(and indefinitely: nothing else on the page changed), while a `page.create` carrying the same tag
appeared in ~25 ms. Cause: the panel's `page.backlinks` resource (`data/store.ts#
useLinkedReferences`) is stamped on the `block` and `page` tables plus the local-push signal, and a
pulled `page.prop` op only bumps `page_prop` (`db/worker-core.ts#notifyFromOps`). Until B-111 the
panel showed nothing a page property could change except linked references through an `alias::`
edit, which had the same gap unnoticed.

**Fixed 2026-09-13.** `useLinkedReferences` is also stamped on `page_prop`, so a pulled `tags::` or
`alias::` change refetches the panel like a block edit does. Costs one `page.backlinks` call (8–14 ms
on the real graph for `journal`) per page-property write while a page is open. The e2e test failed
before the change (the untagged page stayed listed) and passes after; the references, link-unlinked,
page-icons, pages, tagged-pages, page-identity and page-title-draft specs pass with it (38).

---

### B-201 · A half-typed page title reverts when any other page changes
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, reviewing B-104's change to what
`usePageByName` listens to · **Test:** `e2e/tests/page-title-draft.spec.ts` "a half-typed page
title survives other pages being created and edited (B-201)"

Click a page's title, type " renamed" without leaving the field, and let anything create or rename
a page anywhere (sync, an agent, another tab): the input snaps back to the stored name and the
typing is gone. Measured with the e2e test before any fix: with the lookup listening to `page` only
(as on `da85cfb`), a `page.create` of an unrelated page reverted it; with B-104's lookup — which
also listens to `page_prop`, so an alias added elsewhere resolves — setting an icon on an unrelated
page reverted it too. So the bug predates this branch, and B-104 widened it. Cause: `PageView`'s
`createEffect(() => setTitleDraft(page()?.name …))` re-runs whenever the resource value changes, and
`usePageByName` returned a freshly built row object on every refetch, so every refetch looked like a
change.

**Fixed 2026-09-13.** `data/store.ts#usePageByName` hands back the previous row object when every
field of the refetched row is equal (`samePageRow`), so Solid's value signal does not notify and
nothing downstream re-runs; the lookup itself moved into `findPageRowByName`, unchanged. Fixed in the
store rather than in `PageView`'s effect so every reader (the shelf too) stops re-rendering on
unrelated writes, and so the fix does not touch the lines `m8/qafix-render-sync` edits. The e2e test
fails with the reuse disabled (checked) and passes with it. Believed still open, narrower (from
reading the code, not tested): a remote change to THIS page's row (e.g. its `updated_at`) while its
title is being typed would still reset the draft — guarding the effect on `page()?.name` in
`PageView` would close that.

---

### B-111 · ADR 017's `tagged_pages` group was never built
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream (doc-vs-code drift) ·
**Test:** none yet

ADR 017 says `page.backlinks` gains a `tagged_pages` group so that `Person` or `Journal` lists the
pages carrying that tag. Neither the op nor the References panel does; the `page_tag` index exists
and `page.list({tag})` reads it, so the gap is the op output and one panel section.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream (doc-vs-code
drift) · **Tests:** `e2e/tests/tagged-pages.spec.ts` "a tag's page lists the pages tagged with it,
above linked references (B-111)", "a page with tagged pages but no linked references still shows
the panel (B-111)", "a page tagged later, by a property update, appears on the tag's page (B-111)";
`packages/server/src/ops/page-backlinks-tagged.http.test.ts` (7: property tags by name, `Journal`
intrinsic newest-first after named pages, alias-written tags and self-exclusion, shared
limit/cursor, tag removal and block targets, MCP description + `tools/call`, and — added by the
verification pass — "follows the tagged page through delete and undo, and answers the same for an
alias target");
`apps/web/src/views/TaggedPages.test.tsx`

**Fixed 2026-09-13.** Server: `page-tags.ts#pagesTaggedWith` reads `page_tag` for the target's own
key plus alias keys (the set linked references already match), one row per page (`intrinsic` wins),
never the target itself, named pages by key then journal days newest first. `page.backlinks` returns
`tagged_pages: [{id, page, source}]` and `tagged_total`; `limit`/`cursor` window `linked` and
`tagged_pages` together (the cursor stays while either has more). A target with no page of its own
(`Journal` on most graphs) still answers from the index. The MCP description names the group, the
render line adds "N page(s) tagged X", `docs/spec/mcp-tools.md` §4.3.6 has the schema and example,
ADR 017's "not built" note and the three wiki pages that said so are updated. Client:
`views/TaggedPages.tsx` (own CSS file) renders "Pages tagged X" with the total as its count, a
wrapped list of page names, collapsible, and "Showing N of M." when the panel's 200-row request
returned fewer than exist; hooked into `ReferencesPanel` above linked references, which now also
shows when tagged pages are all there is. All three e2e tests fail against `da85cfb`'s
`ReferencesPanel.tsx`/`page-backlinks.ts` (checked). Not built: ADR 017's "a `property` tag is
removable, an `intrinsic` one is not" control — the list marks `data-source` but offers no remove.

Real graph (`tools/probes/refs-real-graph.mjs`): the owner's lowercase `journal` page shows "Pages
tagged journal" with count 825, 200 names shown newest first in the reader's format ("Mon,
07.09.2026", …), "Showing 200 of 825.", then Linked and Unlinked references, ~110–220 ms from
`goto`. `page.backlinks {target: "journal", limit: 500}`: `tagged_total` 825, 500 rows, cursor
present, 8–14 ms. `{target: "book"}` (no `book` page exists): the one highlights page carrying
`tags:: book, design`, source `property` — which the UI cannot show, see B-200.

---

### B-104 · `/page/<alias>` says the page does not exist
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D10)

`alias::` is indexed server-side since B-55, but `usePageByName` resolves by `page.key` only, so
a route naming an alias 404s in the UI while `page_read` resolves it. Fix: fall back to
`page_alias` in the client lookup (the table exists in the replica).

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D10) · **Tests:** `e2e/tests/page-identity.spec.ts`
(all seven: "/page/<alias> opens the page and replaces the URL with its own name", "a [[wrapped]]
alias with a comma resolves, and a zoomed block stays zoomed", "following [[alias]] lands on the
page, and links onward from it do not bounce back", "an alias added while its URL is open turns
'does not exist' into the page", "a page renamed over the API still opens from its old URL"; and two
added by the verification pass: "renaming a page from its title after an alias redirect stays on
it, and the alias still finds it", "an alias two pages claim moves to the survivor when its page is
deleted, without bouncing the open view");
`apps/web/src/data/page-alias.test.ts`; `apps/web/src/views/canonicalPageRoute.test.ts`;
`packages/core/src/page-alias.test.ts`

The client replica has no `page_alias` table (sql-schema.md rule 1: derived tables are
server-only), contrary to the BUGS.md entry's "the table exists in the replica"; the fallback has to
read `page_prop` `alias` rows and parse them the way `packages/server/src/page-aliases.ts` does.
It also bit every page renamed through `page.update` (which keeps the old name as an alias): its
old URL and bookmarks said the page did not exist.

**Fixed 2026-09-13.** Three parts. (1) The `alias::` parser (`aliasKeysOf`, with `[[…]]`/`#`
unwrapping and journal-date canonicalisation) moved from `server/src/page-aliases.ts` to
`packages/core/src/page-alias.ts`, so the client reads a value exactly as the server's index does;
the server module re-exports it. (2) `apps/web/src/data/page-alias.ts#findPageByAlias` scans live
pages' `alias` rows in the replica; `store.ts#usePageByName` tries it last (after the key and the
journal day, so an alias never shadows a real name) and is now also stamped on `page_prop`, so an
alias added while its URL is open resolves without a reload. (3) `views/canonicalPageRoute.ts`
(one hook call in `PageView`) replaces an alias URL with the page's own name, keeping `?block=`.
Journal days are not redirected (they have always been addressable by any title format). The
redirect waits for the resource to finish loading: while a new route loads, a Solid resource still
returns the previous page, and comparing that with the new name bounced every link-follow back —
the "links onward" e2e test fails with the guard removed (checked). All five e2e tests fail against
`da85cfb`'s `store.ts`/`PageView.tsx` (checked). Known limit, unchanged: when two pages claim the
same alias the client picks the older page, the server (`resolvePageIdForKey`) whichever row SQLite
returns first.

Real graph (`tools/probes/refs-real-graph.mjs`, a copy of the owner's graph served on 6406):
`/page/daně` → `/page/Taxes`, `/page/zahrada` → `/page/Garden`, and the `[[…]]`-wrapped alias with
commas → the `hls__The_Logic_of_Experimental_Tests…` page, each in ~230–275 ms from `goto`;
`/page/GARDEN` resolves by its own key without a redirect. `pnpm nooklet verify` on the copy
afterwards: 20,411 ops, OK.

---

### B-89 · `marker`/`priority`/`collapsed` in a `block.create` properties bag are silently dropped
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, seeding a server test for ADR 019 ·
**Test:** none yet (a `packages/core/src/sync/apply-ops.test.ts` case creating a block with
`properties: { marker: "TODO" }` and reading `marker` back would catch it)

`data.blocks.insert({ content: "x", properties: { marker: "TODO" } })` creates the block with
`marker = NULL`; the same bag with `scheduled` or `repeat` works. `applyBlockCreate` INSERTs the
row with `marker_hlc = op.hlc`, then routes each bag entry through `writeBlockField`, whose
`lwwSetColumns` refuses a write whose HLC is not newer than the column's — a tie with the very
op that created the row. The columns the INSERT leaves `NULL` (`scheduled_hlc`, `deadline_hlc`,
`repeat_hlc`, `done_hlc`) accept the write; the three it stamps do not. The top-level
`marker`/`priority`/`collapsed` fields of `block.create` are the working path and every core
caller uses them, so this only bites an API/plugin caller who puts a reserved key in the bag.
Fix: in `applyBlockCreate`, fold bag values for those three keys into the INSERT itself (or
stamp their `_hlc` columns `NULL` on insert and let `writeBlockField` set them).

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, seeding a server test for ADR 019 ·
**Tests:** `packages/core/src/sync/apply-ops.test.ts` "marker/priority/collapsed in the properties
bag land in their columns (B-89)", "a set top-level field wins over the bag; an unset one takes the
bag's value (B-89)", "an invalid reserved value in the bag is dropped, the block is still created
(B-89)"; `packages/server/src/block-create-bag.test.ts` "writes marker, priority and collapsed, and
the block becomes a Task"

Reproduced as described in BUGS.md before fixing: the first core test and the server test both
failed against `da85cfb`'s reducer (`expected null to be 'TODO'`). The owner's op log (a copy taken
2026-09-13, 20,411 ops) has no `block.create` carrying a reserved key in its bag — 870 creates carry
a bag, 0 of them `marker`/`priority`/`collapsed` — so changing what such an op replays to changes
nothing `nooklet verify` compares on that graph.

**Fixed 2026-09-13.** `packages/core/src/sync/apply-ops.ts#applyBlockCreate` folds bag
`marker`/`priority`/`collapsed` into the row INSERT and skips those three keys in the bag loop. A
set top-level field wins; an unset one (`null`, or `collapsed: false` — the model cannot tell false
from unset, and core producers such as `templates.ts` always send both defaults next to a bag) takes
the bag's value; an invalid bag value is dropped without failing the create, like any other invalid
inline property (a top-level invalid marker/priority still rejects). `docs/spec/sql-schema.md` rule
24's `block.create` paragraph says so. The server test checks the derived `#Task` ref too, since a
dropped marker also meant the block was not a task. `pnpm nooklet verify` on the real-graph copy
afterwards: 20,411 ops replayed, OK.

---

### B-186 · A client half that fails to bundle is re-bundled on every unauthenticated request
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `packages/server/src/plugins/bundler.test.ts` "is bundled once per activation, however
often its unauthenticated URL is requested"

Since client halves are bundled on first request (`PluginHost.clientBundle`, B-103 work), a failed
bundle reset the cached promise so "a later request retries". The route that asks,
`GET /plugins/:id/:file`, is mounted before the auth gate, so anyone who could reach the server
could make it run esbuild once per request for any plugin whose client half does not build (3
requests → 3 esbuild runs and 3 error logs in the test before the fix), and the 500 body echoed
esbuild's message, absolute paths included.

**Fixed 2026-09-13.** The rejection stays cached until the plugin is reloaded (a reload activates a
fresh entry, which bundles again); the 500 body says to see the server log.

---

### B-185 · `/mermaid` leaves the caret after the closing fence
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "/mermaid is in the slash menu and inserts a diagram that
renders" (types " --> C" straight after inserting); `apps/web/src/plugins/host.test.ts` "/mermaid
inserts the starter diagram at the caret through the editor host" (asserts the caret)

The starter was inserted with the caret after "```", so the next keystroke produced "```X" — no
longer a closing fence — and the diagram became a parse error. Core "Code block" puts the caret
inside its fence.

**Fixed 2026-09-13.** The slash command passes `insertText(STARTER, { cursor })` to land at the end
of "  A --> B". `EditorApi.insertText`'s `cursor` is now documented as an offset into the inserted
text, which is what the host already implemented.

---

### B-184 · A mermaid fence that fails to parse leaves a "Syntax error" drawing under <body>
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "a broken mermaid fence says why instead of rendering nothing"
(now also asserts no `body > [id^="dnooklet-mermaid-"]`)

`mermaid.render` appends a temp `div#d<id>` to `document.body`; on a parse error it draws its
"Syntax error in text" bomb there and throws without removing it (mermaid 12.0.0
`renderDiagram`: `removeTempElements()` runs on that path only with `suppressErrorRendering`).
Three broken fences left three such divs; with B-183 every edit to the page added more. Hidden by
`body { overflow: hidden }` but in the DOM and the accessibility tree.

**Fixed 2026-09-13.** `plugins/mermaid/src/client.ts` initialises mermaid with
`suppressErrorRendering: true`; the error still reaches the plugin's catch and is shown in the fence.

---

### B-183 · Diagrams drop back to their source and re-draw on every edit anywhere on their page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "a diagram stays drawn while another block on its page is
edited (B-183)"; `apps/web/src/editor/render/PluginFence.test.tsx` "a fence re-created for the same
source shows the last drawing at once, not its source (B-183)"

Every write to a page (one coalesced op per typing pause in any block, a sync pull) re-creates the
rendered content of every row on it — rows survive, their `.vr-block-view` children do not
(pre-existing; probed by marking a paragraph, a code `<pre>` and the diagram in untouched rows,
typing in a fourth: all three were new nodes). For synchronous content that is invisible. For a
plugin fence it is not: `PluginFence` starts from the `<pre>` source and mermaid draws
asynchronously, so each write flashed every diagram on the page back to its source. Measured with
a `requestAnimationFrame` sampler: 4 flashes of 14–52 ms, 328 px → 95 px → 328 px, typing three
words in a sibling row; on the owner's graph copy (journal 2022-12-15) 9 frames without the
diagram, 452 px → 134 px, everything below it jumping.

**Fixed 2026-09-13.** `PluginFence` remembers the last thing each renderer drew per language +
source (`WeakMap` per renderer, 64 entries) and puts it into a re-created fence synchronously,
before the renderer runs again, so no frame paints the source. The rows re-creating their content
is not changed. Without the fix the e2e test saw 8 frames without the diagram.

---

### B-181 · Every server start leaks a temp directory per plugin client half
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-plugins · **Test:**
`packages/server/src/plugins/bundler.test.ts` "writes into the plugin's own .nooklet-build,
content-addressed, never a temp dir per call"

`packages/server/src/plugins/bundler.ts#bundleClientEntry` bundles into a fresh
`mkdtemp(tmpdir(), "nooklet-plugin-client-")` on every activation and nothing ever removes it. On
this machine `$TMPDIR` held **2,063** `nooklet-plugin-client-*` directories (counted 2026-09-13 with
`readdirSync(os.tmpdir())`) — every `nooklet serve`, every e2e run and every server unit test that
loads plugins adds two. Harmless at ~2 KB each; not once mermaid is bundled rather than fetched
from a CDN (B-103), which makes each one 12 MB.

**Fixed 2026-09-13.** The client bundle is built in memory (`write: false`), hashed, and written
once to `<pluginDir>/.nooklet-build/client.<hash>.js` (already gitignored, where the server half's
bundle lives) through a per-process temp name and a rename, so concurrent servers on one checkout
write identical bytes safely and a restart with unchanged source writes nothing. The directories
already in `$TMPDIR` are not cleaned up by this. The test that would have caught it:
`bundler.test.ts` "writes into the plugin's own .nooklet-build, content-addressed, never a temp dir
per call" (bundles twice, asserts one file inside the plugin dir).

---

### B-103 · Client plugin halves never load
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D9)

`apps/web` has no plugin host: the browser makes zero requests to `/plugins/*` or
`/api/v1/plugins`, so the client halves of the built-in plugins (Mermaid, Word count) are
unreachable even though the server lists them with a `client_url`. research/13 §4.1 marks both as
"have"; they are not. Fix: build the host (a day) or move mermaid rendering into core (an hour).

Found independently the same day by the templates workstream while deciding plugin-vs-core (ADR 019
§"Core, not plugin"): `/mermaid` and every `registerSlashCommand` are dead on arrival because
nothing in `apps/web` implements `ClientPluginContext` and `SlashMenu` ranks a static list. Its
duplicate entry (briefly numbered B-87, colliding with the refactors workstream's B-87) was folded
in here.

**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit · **Test:**
`e2e/tests/plugins.spec.ts` (all six), `apps/web/src/plugins/host.test.ts`,
`apps/web/src/editor/render/PluginFence.test.tsx`, `apps/web/src/commands/slash/SlashMenu.test.tsx`
"shows a row contributed while it is open…"

Client plugin halves never load: nothing in `apps/web` implements `ClientPluginContext`, so
`/mermaid`, the mermaid fence renderer and word-count's status item are unreachable.

**Fixed 2026-09-13.** A client plugin host (ADR 023): the built-in client halves are compiled into
the web build (`apps/web/src/plugins/builtins.ts`) and activated at startup inside the command
layer. `registerSlashCommand` registers a registry command and contributes a slash row — the menu
now ranks a signal (`commands/slash/contributed.ts`), not the module constant that made any
runtime row impossible; `registerCodeBlockRenderer` feeds a registry `tokens.tsx`'s fence case
consults (`editor/render/PluginFence.tsx`); `registerStatusItem` mounts into a top-bar strip.
Unimplemented context members throw with their name. mermaid is now the plugin's own dependency,
lazily loaded, instead of a jsdelivr fetch; word-count listens to a new client-only
`page.changed`. Compiling word-count's client half with the app found a type error esbuild had
been stripping since M4 (`CountResult` as an `interface` is not `Json`), fixed in the same commit.
The tests that would have caught it: `plugins.spec.ts` "/mermaid is in the slash menu and
inserts a diagram that renders", "a mermaid fence renders as a diagram, not as code", "word count
shows the open page's words and follows edits (audit item 14)"; `host.test.ts` "activate and
register /mermaid, the mermaid fence renderer and the word-count status item".

---

### B-178 · `journal-stream-editing.spec.ts` types into another spec's block when the whole suite runs
**Status:** fixed · **Severity:** low (test only) · **Found:** 2026-09-13, verifying impl-journal
(full chromium e2e run on port 6403) · **Test:** the spec itself

The B-174 spec wrote to the journal day nine days back, "a past day no other spec writes to" — but
`graph.spec.ts` appends `journal mentions [[Graph Leaf]]` to that same day, and sorts first. In a
full run the spec clicked the section's FIRST block (graph's), typed there, and failed waiting for
`["earlier day baseabc"]` (got `["journal mentions [[Graph Leaf]]abc", "earlier day base"]`). It
passed whenever it ran without `graph.spec.ts`, which is how it was verified. **Fixed 2026-09-13:**
an unused day (-8), a click on the spec's own block by its text, and a `toContain` on the stored
blocks. Still fails on `da85cfb`'s `JournalStreamView.tsx` (editor focus lost), so it still guards
B-174.

---

### B-177 · After midnight, a day pinned from the calendar can be Today too, rendered twice
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying impl-journal (B-170's
rollover with Playwright's fake clock) · **Test:** `apps/web/src/views/JournalStreamView.test.tsx`
"drops a calendar pin once midnight makes the pinned day Today, so the day is not rendered twice
(B-177)"

At 23:59 pin tomorrow from the stream's calendar (allowed: it is not today). At 00:00 B-170 moves
Today to that day, and the pinned section stays — the same journal page is rendered by two
editable `BlockTree`s one above the other (seen: Today and "Back to stream" sections both listing
block `1m2cv41ffra8gm`). Before B-170 "today" never changed while the view was mounted, so a pin
could never equal it.

**Fixed 2026-09-13.** `JournalStreamView` clears the pin when Today becomes the pinned day — the
pin's whole meaning was "a day that is not Today". The test fails without the fix (the "Jumped-to
day" region is still there after the fake clock moves to the pinned day).

---

### B-176 · Any write rebuilds every "Scheduled and deadline" row, dropping keyboard focus on one
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying impl-journal · **Test:**
`apps/web/src/views/JournalAgenda.test.tsx` "keeps every row across a refetch, updating a changed
one in place (B-176)"

Reproduced in real Chromium on a copy of the owner's graph: Tab-focus an agenda row on today's
journal, then let any write land (here `page.append` to an unrelated page through the API — a sync
pull or an agent does the same) — `document.activeElement` becomes `<body>`. Marking the rows'
DOM nodes and typing one character anywhere in the stream replaced 5 of 5 rows; on a stress copy
(686 dated open tasks) 587 of 587 on every debounced write (~800 DOM mutations each; no frame over
50 ms on this machine, so it is a focus/selection defect rather than a speed one). Cause: the agenda
resource refetches on every `block` write and `agendaForDay` builds new group and entry objects;
`<For>` is keyed by reference, so each row is torn down and rebuilt — the B-174 pattern, one level
down.

**Fixed 2026-09-13.** `JournalAgenda` iterates page ids and, per group, task ids (string-array memos
with an element-wise `equals`), reading each group and entry from a map; a row lives as long as its
task is listed and updates in place when the task changes. The test fails without the fix (new row
elements after a refetch of equal data, focus lost).

---

### B-175 · A web link inside a "Scheduled and deadline" row opens the task instead of the link
**Status:** fixed (agenda) / open (query fence, unverified) · **Severity:** low · **Found:**
2026-09-13, verifying impl-journal (real Chromium against `nooklet serve` on a copy of the owner's
graph plus seeded dated tasks) · **Test:** `apps/web/src/views/JournalAgenda.test.tsx` "a web link
inside a task opens the link, not the task (B-175)"

A task `TODO zavolat [[@Robin]] kvůli dárku https://example.com/darek` scheduled for today: in
today's agenda, clicking the `https://…` link opened no tab; the app navigated to
`/page/Úkoly — Čeština?block=…` instead. The `[[@Robin]]` link in the same row works (its handler
stops the event). Cause (read): `JournalAgenda.tsx`'s row `onClick` calls `preventDefault()` on
every click that bubbles up to it, and plain web links (`link`/`autolink` tokens in
`render/tokens.tsx`) have no handler of their own, so the browser's "open in new tab" is cancelled
and the row navigates. `QueryFenceView.tsx`'s hit rows have the same shape (`stop(e)` on the row)
and so very likely the same defect — not reproduced, not touched here.

**Fixed 2026-09-13 (agenda only).** The row's click/Enter handler returns early when the event came
from an `a[href]` inside the row, so the browser follows the link. The test fails without the fix
(`dispatchEvent` answers false: the click was cancelled).

---

### B-174 · Typing in an earlier day of the journal stream drops out of editing after the first write
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, impl-journal (the real-graph
performance probe's typing step kept "losing" its editor) · **Test:**
`e2e/tests/journal-stream-editing.spec.ts`, `apps/web/src/views/JournalStreamView.test.tsx`

On `/journals`, click a block on any day below Today and type: about half a second later (the
editor's debounced write) the caret is gone — focus drops to `<body>`, and further keys go nowhere.
Today's own section is not affected. Reproduced on a clean `git archive da85cfb` build against a
copy of the owner's graph: marking every `.journal-day` element, typing one character into the
first earlier day, and waiting 1.5 s left 1 of 29 sections as the same DOM element (Today's);
the other 28 had been replaced, and `.cm-content` no longer existed
(`scratchpad` probe `debug-remount.mjs`; the kept probe is `tools/probes/journal-agenda-perf.mjs`,
whose typing step failed the same way). Cause: `JournalStreamView` renders earlier and upcoming
days with `<For each={earlierDays()}>` over `JournalDayEntry` objects; every write refetches
`useJournalStream`, which builds new entry objects, and `<For>` is keyed by reference — so every
section, with its `BlockTree` and the editor inside it, is torn down and rebuilt on each write.
Today's section is a non-keyed `<Show>`, which is why it survives.

**Fixed 2026-09-13.** `JournalStreamView` iterates day NUMBERS (`laterDays`/`earlierDays` are
`number[]` memos with an element-wise `equals`) and reads each day's entry from an `entryByDay`
map inside the section, through a non-keyed `<Show>`. Numbers compare by value, so a section — and
the `BlockTree` and editor in it — lives as long as its day is in the stream. Tests that would have
caught it: `journal-stream-editing.spec.ts` "typing in an earlier day keeps editing across the
write, and every key lands (B-174)" (fails on a clean `da85cfb` build: the editor is gone after the
first write), and `JournalStreamView.test.tsx` "keeps every day's outline mounted when a write
refetches the stream (B-174)" (old view: 13 `BlockTree` mounts after three refetches instead of 4).

---

### B-170 · The journal stream keeps yesterday as "Today" after midnight
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-journal (reading
`views/JournalStreamView.tsx` while adding the "Scheduled and deadline" section) ·
**Test:** `apps/web/src/views/streamToday.test.ts`, `apps/web/src/views/JournalStreamView.test.tsx`

`JournalStreamView` reads `todayJournalDay()` once, when it mounts. A tab left open overnight —
the normal state of a desktop outliner — still shows yesterday under "Today" the next morning, with
no virtual row for the real today; typing lands on yesterday's page. Only navigating away and back
fixes it. Same root cause as B-94 (no signal for "the local day changed"); it matters more once the
day carries a "Scheduled and deadline" list, which would show yesterday's agenda as today's.

**Fixed 2026-09-13.** `views/streamToday.ts#createStreamToday` gives the stream a "Today" that
follows `data/day-clock.ts#currentDay()` (midnight timer, visibility, focus — see B-94). It holds
back only while input in the stream is less than two seconds old: moving "Today" unmounts the
`BlockTree` showing yesterday's page, and a typed edit still inside that tree's 500 ms debounce is
not flushed on unmount, so switching mid-sentence at 00:00 could drop keystrokes. An idle caret
does not hold the day back. Tests that would have caught it: `JournalStreamView.test.tsx` "moves
Today to the new day when the local day changes (B-170)" (fails on the old view: the virtual row
stays on the old day); `streamToday.test.ts` — midnight, visible-after-sleep, "waits for typing in
the stream to pause before moving, then moves", "does not wait on an idle caret". Not covered by
e2e: Playwright's clock could fake it, but the stream would need a page open across a fake
midnight; the unit tests drive the same signal. **Update (verification pass):** now covered —
`e2e/tests/journal-midnight.spec.ts` opens `/journals` at a fake 23:59:45 and fast-forwards past
midnight (Today's agenda moves to the new day), and does the same for a `deadline:today` query
fence (B-94). Both fail when `day-clock.ts#check` stops moving the day.

---

### B-94 · A ```query fence keeps yesterday's "today" after midnight until something else changes
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12 while building the fence (ADR 011
amendment, "Deferred") · **Test:** none — a real clock would have to cross midnight

Leave a page with `scheduled:<=today` open across midnight: the results still reflect the
previous day, because the fence re-runs only when `block`/`block_prop`/`page` change
(`data/queries.ts`, stamped on the change bus) and `today` is read at evaluation time. Any edit,
pull, or navigation fixes it. A timer that bumps the version at local midnight (and on
`visibilitychange`, for a phone that slept through it) is the fix; it belongs next to
`stampedFor` in `data/store.ts` so the Tasks view's "today" grouping benefits too.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12 while building the fence ·
**Test:** `apps/web/src/data/queries.today.test.ts`, `apps/web/src/data/day-clock.test.ts`

Unchanged from `docs/BUGS.md`: `useQueryResults` (`data/queries.ts`) re-runs only when
`block`/`block_prop`/`page` change, and `today` is read at evaluation time, so a page with
`scheduled:<=today` left open across midnight lists the previous day's results.

**Fixed 2026-09-13.** New `apps/web/src/data/day-clock.ts`: the local day as a Solid signal
(`currentDay()`), kept by a timer aimed just past local midnight (capped at five minutes, because
browser timers stop while a machine sleeps), `visibilitychange` to visible, and window `focus`.
`useQueryResults` puts `{ query, today: currentDay() }` in the resource source and passes that
`today` to `runQuery`, so a rollover re-evaluates with no table change. Put in its own module
rather than next to `stampedFor` in `store.ts` (as the entry suggested) so the journal views can
use it too without widening the store seam. Tests that would have caught it:
`queries.today.test.ts` — "re-evaluates `today` at local midnight without any table changing" and
"re-evaluates when the page becomes visible after sleeping through midnight" (both fail on the old
`queries.ts`: `expected [ 20260912 ] to deeply equal [ 20260912, 20260913 ]`); the clock itself in
`day-clock.test.ts` (midnight, visibility, focus, a sleep-paused timer, DST-safe midnight, one
notification per rollover).

---

### B-229 · Double-clicking the favourite star leaves the page favourited
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of
`m8/impl-export` · **Test:** `e2e/tests/page-export.spec.ts` "double-clicking the star toggles twice
and leaves the page as it was"

Two toggles in quick succession should cancel out; they do not. `app/page-actions.ts#togglePageFavorite`
reads the stored `favorite` value, then writes its opposite through the worker. The second click's
read runs before the first click's write has landed, so both read "not a favourite" and both write
`true`. Measured (Chromium, production build): `dblclick()` on `.page-favorite-button` ends with
`aria-pressed="true"` and `page.read` reporting `favorite: "true"`.

**Fixed 2026-09-13.** `togglePageFavorite` queues behind the toggle in flight (one module-level
promise chain; a rejected toggle does not block later ones), so the second read sees the first
write. The named test failed before the change (the star still pressed after `dblclick()`) and
passes after. The All Pages star (`views/AllPagesView.tsx`) toggles from its rendered state instead
and was not changed or measured here.

---

### B-228 · An agent with live UI control can overwrite the person's clipboard, start downloads and open the print dialog
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of
`m8/impl-export` · **Test:** `apps/web/src/commands/registrations/page-actions.test.ts` "copy, export
and print refuse ui_run; toggling a favourite does not"

`app.copyPageMarkdown`, `app.exportPageMarkdown` and `app.printPage` are ordinary registered
commands with no `remoteInvocable` flag, so `ui_run` (ADR 015 §2.4, `live/command-runner.ts`) runs
them in the person's window: `runRemoteCommand(deps, "app.copyPageMarkdown", { page })` returns
`ran` and calls the host. Chromium lets a focused document write the clipboard without a gesture,
so an agent silently replaces whatever the person had copied; `window.print()` puts a modal dialog
over their window (and in Chromium blocks the page's script until it is dismissed, so the remote
call hangs with it); Export drops a file into their Downloads. `Command.remoteInvocable`'s own doc
(`commands/types.ts`) reserves `false` for exactly this — commands "that act outside the document
model entirely" — and an agent that wants a page's text already has `page.read`.

**Fixed 2026-09-13.** The three commands carry `remoteInvocable: false`, so `runRemoteCommand`
answers `not_permitted` without calling the host. `app.toggleFavorite` is unchanged — a synced page
property, which an agent may set like any other. The named test runs the real registrations through
the real `runRemoteCommand` and failed before the flags (`app.copyPageMarkdown: expected
{ when_result: 'ran' }`). R52a in `docs/spec/commands-and-keymap.md` says so.

---

### B-227 · A printed page's title is cut off after one line
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, adversarial verification of
`m8/impl-export` (PDF of a long-titled page) · **Test:** `e2e/tests/page-export.spec.ts` "a page
title too long for one printed line prints whole"

An ordinary page's title is an `<input class="page-title-input">` (`views/PageView.tsx`), and an
input cannot wrap. B-221's print stylesheet puts the page on paper but leaves the title in that
input, so a name longer than one printed line is clipped at the sheet's edge with nothing to say
so: `page.pdf({ format: "A4" })` of "Projekty/Velmi dlouhý název stránky, který se na papír nevejde
celý do jednoho řádku" printed "…nevejde cel" and stopped (input 794px wide, `scrollWidth` 1030).
Journals are unaffected — their title is already an `<h1>`. The owner's graph copy has 8 page names
over 45 characters (the `hls__…` and `hypothesis__/…` pages), which is about where an A4 line of
the title font runs out.

**Fixed 2026-09-13.** `PageView.tsx` renders the title a second time as `<h1 class="page-title-print">`
(from the same draft signal the input shows); `styles/print.css` keeps it `display: none` on screen
and, in print, hides `input.page-title-input` and shows the heading with the input's type and
`overflow-wrap: anywhere` (the `hls__…` names have no spaces to break at). The named test failed
before the change (the input was still visible in print media) and passes after; a PDF of the
owner's longest name, `hls__The_Logic_of_Experimental_Tests,_…_1670184390828_0`, now prints on two
lines.

---

### B-223 · The mirror orders siblings with the same order key by insertion order, not by id
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `mirror/export.ts` while
sharing its renderer with the client (B-220) · **Test:** `packages/core/src/sync/page-outline.test.ts`
"orders siblings with the same order key by id, whatever order they were inserted in"

`renderPageToOutline` sorted blocks `ORDER BY order_key` alone. Two devices inserting at the same
spot mint the same fractional key and nothing on the server rewrites a collision, so a tie is
reachable; SQLite then returns the tied rows in rowid (insertion) order. That order is different
on the server and on every replica, and different from what the editor shows, which breaks ties
by id (`apps/web/src/editor/tree.ts#sortSiblings`; core's `listChildren` does `ORDER BY order_key,
id` too). Consequence: the mirror file can list two siblings in the opposite order from the page
on screen, and a page exported from the browser would not match its mirror file.

**Fixed 2026-09-13.** The renderer moved to `packages/core/src/sync/page-outline.ts` (shared with
the web export, B-220) and sorts `ORDER BY order_key, id`. The named test fails with the old
`ORDER BY order_key` (checked by reverting the clause: 1 failed / 5 passed) and passes with the
fix. The owner's graph (copy of 2026-09-13: 952 pages, 18,628 live blocks) has zero tied
`(page_id, parent_id, order_key)` groups, so no mirror file there changes.

**Note (adversarial verification, 2026-09-13):** the mirror and the browser export now agree with
the editor, but `page.read` does not: `packages/server/src/data-api.ts` (the two child queries near
line 162) still sorts `ORDER BY order_key` alone, and so do `embeddings/units.ts` and
`ops/graph-overview.ts`. On a tie an agent reading the page sees the siblings in insertion order.
Not changed here (outside this branch's files); no number left in B-220..B-229 to log it under.

---

### B-222 · Favourites can only be set from /pages; the sidebar's recent list is labelled "Pages"
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, exposure audit §1.7 and §2 #13 ·
**Tests:** `e2e/tests/page-export.spec.ts` "the star in the title row favourites and unfavourites
the page, and the sidebar follows", "Toggle favourite from the palette stars the routed page; the
sidebar's recent list reads Recent"; `apps/web/src/data/page-export.test.ts` `isFavoriteValue`

The only favourite control is the star column in `views/AllPagesView.tsx`. The page itself and
the palette have none, so on a fresh graph the sidebar's Favourites section never appears and
nothing hints that it could. The sidebar section under it is titled "Pages" but lists the twelve
most recently edited pages — a second "Pages" right under the nav link of the same name that
opens the full list.

**Fixed 2026-09-13.** A star in the page title row (always visible, filled when favourited) and a
"Toggle favourite" palette command (`app.toggleFavorite`), both writing the synced `favorite`
page property through the existing `setPageFavorite`. The star's state uses `isFavoriteValue`,
the sidebar query's exact test (`value NOT IN ('', 'false')`), so the two cannot disagree. The
sidebar's recent section is headed "Recent"; `pages.spec.ts` and `page-icons.spec.ts` located it
by the text "Pages" and now locate it by its heading.

---

### B-221 · Printing a page prints the app chrome and silently drops collapsed children
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exposure audit §2 #10 · **Tests:**
`e2e/tests/page-export.spec.ts` "printing a long page prints all of it — without the chrome,
collapsed children expanded, in light ink", "Print page from the palette closes the palette and
opens the print dialog"; `apps/web/src/editor/tree.test.ts` "expandAll (print, B-221)…"

There is no print stylesheet and no print command. Cmd/Ctrl+P prints the top bar, the sidebar,
the shelf and the help button around the page, and a collapsed block's children are not in the
DOM at all (`editor/tree.ts#flattenVisible` skips them), so a printed or PDF'd page loses content
with no mark that anything is missing.

Worse than the audit said: **everything below the first screen is cut off.** The shell is
`position: fixed` over a `height: 100%; overflow: hidden` body, with `.page-scroll` as the only
scroller, so print layout sees one viewport. Measured at `da85cfb` (Playwright, Chromium, print
media, `page.pdf()`): a 120-block page produced a **1-page** PDF with `.app-topbar` visible and the
collapsed block's child absent. The same run showed `page.pdf()` fires `beforeprint`/`afterprint`,
which is what lets a test observe the print-time DOM.

**Fixed 2026-09-13.** `apps/web/src/styles/print.css` (`@media print`): the shell back to normal
flow, chrome/page controls/references hidden, the light palette forced (a dark-theme screen printed
light-grey ink), `print-color-adjust: exact` on the outline (a first PDF had no bullets or guides —
they are backgrounds), `content-visibility` off for rows. `apps/web/src/app/print.ts` flips a signal
on `beforeprint`/`afterprint` that `BlockTree`'s rows memo passes to `flattenVisible` as
`expandAll`, so collapsed children are in the DOM for exactly the print and nothing is written.
"Print page" (`app.printPage`) in the palette and the title-row menu calls `window.print()`. The
named e2e test asserts ≥3 PDF sheets for the same 120-block page, the hidden child and the last
line in the print-time DOM, chrome hidden, light ink, exact colour, and the page still collapsed
afterwards (also in `page.read`). Not checked: Safari/WKWebView print, page breaks inside very long
blocks.

---

### B-220 · A page cannot be copied or exported as markdown from the app
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, exposure audit §2 #9 · **Tests:**
`e2e/tests/page-export.spec.ts` "Export as markdown downloads exactly the file the mirror wrote for
the page", "Copy as markdown puts the page on the clipboard without ids, including a just-typed
edit", "Export from the palette acts on the page the route shows"

Portability is the #1 reason people leave Logseq (research/13 §3.5) and the markdown mirror is
nooklet's answer — but inside the app there is no way to get a page's text out. `block.copySelection`
copies selected blocks only; `nooklet export` and the mirror directory are server-side and
invisible to a person in the browser or on a phone. No palette command, no control on the page.

**Fixed 2026-09-13.** Palette commands "Copy page as markdown" (`app.copyPageMarkdown`) and
"Export page as markdown" (`app.exportPageMarkdown`), and the same two in a new "…" menu in the
page title row (`views/PageActions.tsx`), which runs the registered commands with the page in
`args`. The text is rendered in the browser from the local replica by the mirror's own renderer,
moved to `packages/core/src/sync/page-outline.ts` for this (SQL + a pure row -> tree build; the
server's `mirror/export.ts` now calls it too), so it works offline and includes unpushed edits.
Export = the mirror file byte for byte, `^id`s included, under the mirror's file name; Copy = the
same render with ids off. The first named test compares the download with the file the real
server's mirror wrote to disk. Copy starts `navigator.clipboard.write` with a promised
`ClipboardItem` inside the click/key, which is what WebKit requires — verified on Chromium only.

---

### B-216 · A web link inside an embedded row does not open; the click goes to the block instead
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-embeds` on a copy of the owner's graph · **Test:** `e2e/tests/embeds.spec.ts` "a web link
inside an embedded row opens the link, not the block (B-216)" and `apps/web/src/editor/render/embed.test.tsx` "a web link in a row keeps its own default…"

The owner's 2024-09-29 embed carries a row that is just a Mattermost URL. Clicking that link on its
own page (2024-09-26, zoomed to the block) opens it in a new tab; clicking the same link inside the
embed opened no tab and navigated the app to `/page/2024-09-26?block=…` (probe
`tools/probes/embeds-external-link.mjs`, external requests fulfilled locally). `EmbedRow`'s row
handler calls `preventDefault()` on every click that bubbles up to it, which cancels an `<a
href target=_blank>`'s own navigation; only `[[page]]` links survived, because `NavLink` stops the
click first. Enter on a focused link inside a row had the same fate through the row's `keydown`.
The query fence's result rows (`QueryFenceView.tsx#HitView`) have the identical handler, so their
links are presumably dead too — not reproduced, not fixed here.

**Fixed 2026-09-13.** `EmbedRow#go` returns early for a click or Enter whose target is inside an
`a[href]`, stopping propagation (so the host does not enter edit mode) without `preventDefault`. Both
tests failed before the change (the e2e test timed out waiting for the tab; the component test's
`fireEvent.click` returned `false`) and pass after.

---

### B-215 · Shift+click on an embedded row shelves a card that says "This block is gone."
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-embeds` (reading `BlockTree.tsx#onShelfOpen`, then reproduced in Chromium) · **Test:**
`e2e/tests/embeds.spec.ts` "Shift+click on an embedded row shelves that block, from its own page
(B-215)"

B-210's summary promises "Shift+click puts it on the shelf". `EmbedRow` calls
`ctx.onShelfOpen({ kind: "block", id })`, and the only provider, `BlockTree.tsx#onShelfOpen`, fills
in the page id as `props.pageId` — the page the tree is showing, which for an embedded row is the
HOST page, not the page the block lives on. `Shelf.tsx#BlockCard` then reads the host page's tree,
does not find the block, and the card is titled with the host page and reads "This block is gone."
(seen in the e2e test: `" Embed Host Shelf RowThis block is gone."`). The component test only
checked the call's `{ kind, id }` against a mock, so it passed.

**Fixed 2026-09-13.** `render/tokens.tsx#NavigateTarget`'s block kind takes an optional `pageId`;
`EmbedRow` passes the embedded page's id (`EmbedData.page.id`) and `BlockTree#onShelfOpen` uses it
before falling back to its own `props.pageId`. The e2e test failed before (card text above) and
passes after; `embed.test.tsx`'s Shift+click case now asserts the page id too.

---

### B-214 · Typing anywhere on a page collapses its embeds to the placeholder and back, and resets their expand toggles
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-embeds` on a copy of the owner's graph · **Test:** `e2e/tests/embeds.spec.ts` "typing
elsewhere on the page leaves an embed in place, unfolded rows included (B-214)"

On the owner's 2024-09-29 journal (an embed of 27 rows), one keystroke in the day's first block
made the embed's host row measure 775 → 51 → 775 → 51 → 775 px (a `ResizeObserver` on the row):
the embed is torn down and rebuilt twice per keystroke, and each rebuild shows the one-line
"Embed: ((id))" Suspense fallback until the new resource's first read lands. Typing in a block
*below* an embed (a page with `{{embed [[2024-09-29]]}}` above it) moved the editor on screen
between y=309, 875 and 1233 while typing six characters. A row unfolded with the embed's own toggle
folds again on the next keystroke anywhere on the page. Probes:
`tools/probes/embeds-typing-remount.mjs`, `embeds-typing-flash.mjs`,
`embeds-toggle-survives-typing.mjs`.

Cause (verified by tagging DOM nodes): `BlockTree` hands every row a new `block` object whenever the
page tree re-reads (every write), and `BlockRowView`'s `content` memo and its `ctx.source` both read
`props.block.content` — so the row's `.vr-block-view` survives but everything rendered inside it is
rebuilt, including a fresh `EmbedView` whose `useEmbed` resource starts unresolved and suspends. The
same rebuild is what makes a ```` ```query ```` block flicker 78 → 45 → 78 px (pre-existing, same
cause); for plain text it was invisible.

**Fixed 2026-09-13.** `BlockRowView` memoizes `props.block.content` as a string and both the
classification and `ctx.source` read that memo, so the rendered view is rebuilt only when the row's
text changes. The e2e test (an unfolded embedded row, a tag on the outline element, the host row's
minimum height) failed before the change — "about the car" folded away — and passes after. Re-run
on the graph copy: the embed row's height stays 775 / 942 px through typing, the editor stays at one
y, the unfolded row stays open, and the query block's 78 → 45 px flicker is gone with it.

---

### B-212 · A finished task inside a query result strikes through the whole query block
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, rendering the owner's embeds on a
copy of the real graph · **Test:** `e2e/tests/embeds.spec.ts` "a finished task inside an embed or a
query result does not strike through its host (B-212)"

A ```` ```query ```` block whose results include a DONE or CANCELED task renders struck through
and dimmed from its first line to its last — the query text, the count, every open result. The
same happened to the new embeds on the owner's 2024-09-29 journal: one checked item in the
embedded list struck through the source line and every open item around it. The rule is
`editor/editor.css` `.vr-row:has(.vr-marker-DONE) .vr-block-view`: `:has()` with a descendant
combinator matches a marker anywhere inside the row, including the rendered results and embedded
rows nested in its content, not just the row's own marker pill. `shell/shelf.css`
`.shelf-block:has(.vr-marker-DONE) .shelf-block-text` has the same shape (a shelved block holding
an embed or a query).

**Fixed 2026-09-13.** Both rules now look only at the block's own marker through child combinators:
`.vr-row:has(> .vr-row-main > .vr-marker-DONE) .vr-block-view` and
`.shelf-block:has(> .shelf-marker.vr-marker-DONE) .shelf-block-text` (CANCELED likewise). The test
reads computed `text-decoration-line` on the host row of an embed, the host row of a query, and a
shelf card holding the embed; before the fix each of the three read `line-through` (checked one at a
time by reordering/reverting), after it `none`, while the finished item itself is still struck.
`tasks.spec.ts`'s own-marker strike test still passes.

---

### B-210 · `{{embed [[Page]]}}` and `{{embed ((id))}}` show a box with the target's name, never its content
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md` §1.9 and §2 item 8) · **Tests:** `e2e/tests/embeds.spec.ts`
(nine tests, from "a block embed shows the block and its children, read-only, root unfolded" to
"an embed of a block that does not exist says so", including "on the shelf, a self-embedding block
shows the notice rather than a copy of its page"); `apps/web/src/editor/render/embed.test.tsx`;
`apps/web/src/editor/render/embedRows.test.ts`; `apps/web/src/data/embeds.test.ts`

Write `{{embed ((id))}}` in a block (or pick "Embed block" from the slash menu): the rendered
block is a dashed box reading `Embed: ((1m287mdbkcaggj))` — the id, not the embedded block or its
children. `{{embed [[Page]]}}` likewise reads `Embed: [[Page]]`. The owner's graph has six embeds,
each a journal day carrying forward an earlier day's task list (6–60 blocks); every one of them
reads as an opaque id. `editor/render/tokens.tsx#EmbedView` is a placeholder with no data seam
behind it (its header lists it under "Known gaps"), and `docs/spec/markdown-grammar.md` §4 promises
the target's blocks.

**Fixed 2026-09-13.** Read-only, as the audit proposed; editable transclusion is not built.
`data/embeds.ts#loadEmbed` reads the target through the worker's `getPageTree` (a block embed finds
its node in its page's tree; a page resolves by key, then by journal day), `useEmbed` re-reads on any
page/block/block_prop change and never rejects. `editor/render/EmbedView.tsx`, lazy behind its own
Suspense in `tokens.tsx`, renders an outline: a row click navigates to the block (Shift shelves it),
the source line opens the page, a click on the frame still edits the host. The embedded root always
shows its children (two of the owner's five working embeds point at a block collapsed on its own
day); deeper collapsed blocks stay folded with a view-local toggle; 250 rows at most. Termination:
`MAX_REF_DEPTH` (2, shared with block refs) and `RenderCtx.embedPath` — `BlockRowView` passes the row's
id (so does the shelf's `ShelfOutline`, whose card otherwise painted the page inside itself once —
seen failing with 2 rows before that line), each embedded row adds its own, and an embed whose
target tree contains one of them shows a notice (`embedRows.ts#embedReachesPath`). Rows carry `data-embed-block-id`, not `data-block-id`
(see B-211). On a copy of the owner's graph (`tools/probes/embeds-real-graph.mjs`) all five
well-formed embeds render (6, 12, 27, 27 and 31 rows, no page errors); the sixth, written
`{{embed ((id))}` with one closing brace, is not an embed to the tokenizer and still renders as text
plus a block reference. The e2e tests would have caught it: on `da85cfb` there is no `.vr-embed-item`.

---

### B-190 · Redo of an undone Enter, paste or duplicate shows the block but never writes it
**Status:** duplicate · **Severity:** medium · **Found:** 2026-09-13, writing the redo half of
B-108's test · **Test:** `e2e/tests/redo.spec.ts` "redo after undoing Enter brings the new block
back in the database, not only on screen"; `apps/web/src/editor/history.test.ts` "undoing a split
(block.create) deletes the new block; redoing revives it"

**Duplicate of B-240** (the QA fixer and the editor workstream fixed it in parallel). B-240's fix is what landed — the redo re-sends a revive instead of the create, with a round trip against real SQLite; this entry's create-plus-revive variant was not merged.

Press Enter in a block (a new bullet), Cmd/Ctrl+Z (it goes), Cmd/Ctrl+Shift+Z: the bullet is
back on screen, but `page_read` does not list it, and a reload loses it along with anything typed
into it since. Same for any undone structural command that created blocks — split, multi-line
paste, duplicate, and now `/template`. `EditHistory.redo` re-mints the transaction's forward ops,
so the redo of a create is another `block.create` for the same id; the reducer's
`applyBlockCreate` is `INSERT OR IGNORE`, and the row the undo tombstoned is still there, so the
redo is a no-op in the database. The optimistic tree does not know that and shows the block.

Verified before the fix: the e2e failed on the API read (`["first"]`), and with that assertion
taken out, on the reload (`["first"]` again) — so the loss is real, not a slow sync. The unit test
of the same name existed and passed: it asserted only that the redo re-emitted a `block.create`.

**Fixed 2026-09-13.** `editor/history.ts#redoRecipes`: a redo follows each forward `block.create`
with a revive (`block.delete`, `deletedAt: null`) for the same id, minted after the undo's
tombstone so the reducer does not call it stale. Editor-side on purpose: making `block.create`
revive a tombstoned row in `@nooklet/core` would change what replaying the op log means, for every
device and `nooklet verify`. The unit test now asserts the revive and its ordering; the e2e above
would have caught it (it failed before the fix, passes after).

---

### B-88 · The row being edited stays on screen after its block leaves the page
**Status:** fixed · **Severity:** low · **Found:**
2026-09-12, `e2e/tests/refactor.spec.ts` "Move to page… asks for a page and moves the subtree to
its end" · **Test:** none for the editor itself; the spec covers the workaround

Right-click a block, *Move to page…*, pick a page: its children vanish from the source page at
once (the pull lands and the tree refetches), but the block itself — the row holding the
editor — stays, showing its old text, until you click elsewhere. Then it is gone. Same shape for
a block another device moves or deletes while you have the caret in it. `BlockTree` renders rows
from the tree but keeps the `editingId` row mounted regardless of whether that id is still in
the tree. A first diagnosis blamed the worker's change event (`notifyFromOps` naming only the new
page); a probe that read the rows after a click-away disproved it — `usePageTree` stamps on the
`block` table and did refetch.

Workaround in `commands/registrations/refactor.ts`: "Turn into page" and "Move to page…" end
editing (`block.selectBlock`) before the server op, so the row re-renders from the tree. The
proper fix is in `editor/BlockTree.tsx` (drop `editingId` when the tree no longer contains it),
which belongs to another owner this session.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, `e2e/tests/refactor.spec.ts` ·
**Test:** `e2e/tests/editing-row-leaves.spec.ts` "a block deleted elsewhere while the caret is in it
leaves the page", "a block moved to another page while the caret is in it leaves, and what was
typed goes with it", "Move to page… on the row being edited takes the row away and the text typed
just before" and "a block brought back by undo keeps its row while typing straight away" (the last
two added by the verification pass, below); `apps/web/src/editor/unseen-creations.test.ts`

Unchanged from `docs/BUGS.md`: the row holding the editor stays on screen, showing the old text,
after its block is moved to another page or deleted elsewhere. Before the fix both e2e tests
failed the same way: the pull landed (the block's child row went) and the edited row was still
there, editor and all, ten seconds later.

**Fixed 2026-09-13.** The cause was the `else` branch of `BlockTree`'s tree effect: any refetch
without the block being edited was taken for an optimistic creation not yet committed, and the
local row was kept. The tree now remembers which blocks it created or revived that no refetch has
returned yet (`editor/unseen-creations.ts`, fed from `commit`, `doUndo`, `doRedo`); only those keep
their row. A block the database had, missing from a later refetch, has left: the tree flushes
pending keystrokes (written to the block by id, wherever it went — the move test checks
`"goes typed"` arrives on the destination page), detaches the editor and ends editing. The "Move
to page…" workaround in `commands/registrations/refactor.ts` is gone. "Turn into page" still ends
editing before its op, for a different reason found while removing it: the block is rewritten,
not moved, and the editor keeps a stale buffer over an external rewrite — logged as B-192.

Not covered: a block created in this tab and removed elsewhere before any refetch has returned it
keeps its row until editing ends (a window one refetch long). Also not covered, found by the
verification pass (probe, 2026-09-13): another writer moving the edited block under a COLLAPSED
parent on the same page. The block stays on the page, so this path does not run; its row stops
rendering, the editor goes with it and focus drops to `<body>` — the same screen B-88's fix gives,
and the text typed before the move is saved (`"edited one"`), but `editingId` still names the
hidden block.

---

### B-108 · A template inserted with `/template` cannot be undone with Cmd/Ctrl+Z
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, building it (ADR 019) · **Test:**
none yet (an `e2e/tests/templates.spec.ts` case pressing Cmd/Ctrl+Z after an insertion would
catch it)

Insert a template, press Cmd/Ctrl+Z: the blocks stay. The editor's undo history is
`BlockTree`'s `commit` (`EditHistory.record`), which only sees ops that go through the tree's own
`runStructural`; `block.insertTemplate` writes its `block.create` ops through `data/store.ts`
directly, because a command outside the tree has no way to hand ops to its history. Fix is a
structural delegate (`EditorHost.runStructuralCommand("block.insertOps", …)` or similar) that
lets a command commit a batch through the tree — `BlockTree.tsx` is another agent's this
session. The API side is unaffected: `batch_undo` reverses an API-created template as usual.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, building it (ADR 019) · **Test:**
`e2e/tests/template-undo.spec.ts` "Cmd/Ctrl+Z takes back a template inserted into an empty bullet,
and redo restores it" and "Cmd/Ctrl+Z takes back a template inserted after a bullet with text,
caret back where it was", and "undo and redo of a nested template with a marker and a property on
the bullet" (added by the verification pass); `apps/web/src/editor/external-batch.test.ts`;
`apps/web/src/commands/registrations/templates.test.ts`

Unchanged from `docs/BUGS.md`: a template inserted with `/template` stays after Cmd/Ctrl+Z.
Before the fix both e2e tests failed at the undo: into an empty bullet, the text went back but the
template's children stayed (the text was the only part that went through the editor); after a
bullet with text, nothing changed at all.

**Fixed 2026-09-13.** A new `EditorHost.commitOps(batch)` seam (`commands/hosts/editor-host.ts`,
bridged in `app/editor-host.ts`) lets a command hand the tree ops it built itself; `BlockTree`
validates and re-mints them (`editor/external-batch.ts#prepareExternalBatch`) and commits them
through `runStructural`, the path a split takes — one history transaction. `data/templates.ts`
now builds the ops without applying them (`templateAfterOps`, `templateIntoBlockOps`, the latter
with the first line's text as a `block.text` op instead of an `EditorHost.replaceRange`), and the
command falls back to `applyOps` only when no mounted tree shows the block. `runStructural` now
places the caret when the focus stays on the block being edited (it used to call
`attachEditing` with the same id, which re-renders nothing). ADR 019 amended. The redo half of the
test also exposed B-190, fixed separately.

One gotcha for whoever touches the e2e: every spec shares one server, and a template left in the
graph changes `templates.spec.ts`'s Settings list; `template-undo.spec.ts` deletes its library
after each test for that reason.

---

### B-145 · The date picker stores a garbage date for `+10000y` and throws on every keystroke of `+99999999d`
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-dates` (a real browser against the production build) · **Tests:**
`apps/web/src/commands/date-picker/parse.test.ts` "an offset that leaves the calendar is not a date
— never a garbage or NaN day (B-145)" and "refuses to format a day that is not on the calendar…",
`DatePicker.test.tsx` "a typed offset past the calendar's end is an error line, not a crash or a
write (B-145)", `e2e/tests/dates.spec.ts` "while the picker is open, the structural keys never
reach the tree, and a date past the calendar is refused without an error (B-145)" (fails against
the pre-fix parser: Enter closed the picker having written nothing)

Offsets were the one input with no size limit. `/scheduled`, `+10000y`, Enter: the preview said
"Sun, Sep 13, 12026", and the server then held `scheduled:: 1202-60-91` — `formatStoredDate`
sliced the nine-digit day `120260913` into four-two-two, and the reducer's `SCHEDULED_RE` checks
only the digit pattern, so `scheduled_day` became `12026091`: no chip (the chip parser rejects
it), but a due date in the year 1202 for the Tasks view and every `scheduled:<today` query.
`+99999999d` goes past what `Date` holds: `addDays` returned NaN, `formatJournalTitle` threw
`RangeError: Invalid time value` from the preview (two uncaught page errors while typing, the
preview frozen on the last good value), and Enter closed the picker having silently written
nothing. `-3000y` gave a negative day. Seen in e2e probe output: `C: props
[{"scheduled":"1202-60-91"}]`, `B: errors ["RangeError: Invalid time value", …]`.

**Fixed 2026-09-13.** `parse.ts` checks an offset's result with `isValidJournalDay` and says
`"+10000y" is too far away` otherwise (`+7973y` still reaches 9999); `formatStoredDate` throws a
`RangeError` rather than format a day that is not on the calendar, so no caller can store one;
the picker's arrows/PageUp/PageDown stop at the calendar's ends. All three tests failed before the
fix (the component test also with two unhandled `RangeError`s).

---

### B-143 · Import keeps `SCHEDULED: <2023-2-17 Fri>` as text and loses the date when Logseq wrote a one-digit month or day
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-dates (checking chips
against a copy of the owner's graph)

In a copy of `~/.nooklet/default/graph.sqlite` only 4 blocks have `scheduled_day`, and 20 more
still carry a literal `SCHEDULED: <2023-2-17 Fri>` line in their content — so they show no chip,
sort nowhere in the Tasks view, and read as text. The Logseq source graph
(`~/notes-graph`) has exactly 24 `SCHEDULED:` lines: 4 zero-padded
(`<2023-01-06 Fri>`) and 20 not (`<2023-2-17 Fri>` ×19, `<2022-12-8 Thu>` ×1) — the 20 lost ones.
(Survey: `grep -rhoE "(SCHEDULED|DEADLINE): <[^>]*>" journals pages`, digits folded.) Cause:
`packages/core/src/outline.ts` `TIMESTAMP_INNER_RE` takes the date as `\d{4}-\d{2}-\d{2}` only,
and a non-matching timestamp falls through to content "so no data is lost". The same regex
takes the time as `\d{1,2}:\d{2}` and stores it unpadded, while the reducer
(`sync/apply-ops.ts#SCHEDULED_RE`) only accepts `HH:MM` — a `<2026-09-14 Mon 9:30>` would be
parsed into a value the reducer rejects (no such line exists in the owner's graph).

**Fixed 2026-09-13.** `outline.ts#orgTimestamp` accepts one-digit month, day and hour, zero-pads
them, and rejects an impossible date or time (kept as text, as before). Grammar spec OUT-23 rule
5 says so. Checked on real data: a fresh `pnpm nooklet import ~/notes-graph
--data <scratch>` now has 24 blocks with `scheduled_day` (was 4) and 0 blocks with
`SCHEDULED:`/`DEADLINE:` text (was 20); `pnpm nooklet verify` on it: 19,580 ops replayed, OK.
**The owner's live graph is not repaired by this** — the 20 blocks keep their text until the
graph is re-imported (or someone runs a one-off fix; none written).
**Test:** `packages/core/src/outline-org-dates.test.ts` (4 tests, all failed before the fix) and
`packages/server/src/importer/logseq.test.ts` "imports SCHEDULED/DEADLINE written with one-digit
month, day and hour (B-143)" (fails against the old parser — checked by restoring it).

---

### B-141 · The date picker's error line names only the first letter typed
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-dates (screenshot review of
this branch's own picker; never on main) · **Test:** `apps/web/src/commands/date-picker/DatePicker.test.tsx`
"Enter on text that is not a date does nothing but say so; Backspace edits the text"

Type `bananas` into the picker and press Enter: the red line says `"b" is not a date — …`. The
line was `<Match when={invalidMessage()}>{(message) => message()}</Match>`. Solid's `Switch`
calls a Match's render function once, inside `untrack`; a function that returns the accessor's
value as a bare string (rather than JSX that reads it) captures the first message and never
updates while the condition stays truthy. No other `{(x) => x()}` render callback exists in
`apps/web/src` (grep, 2026-09-13).

**Fixed 2026-09-13.** The Match renders `{invalidMessage()}` as JSX, which Solid tracks. The test
named above now asserts the whole `"banana" is not a date`; run against the old line it failed
with `Received: ""b" is not a date — try tomorrow, fri, +3d or 2026-09-20"`.

---

### B-140 · A row-rendering module that imports the `lucide-solid` barrel stalls anything that renders a row under vitest
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, impl-dates (while adding chips) ·
**Test:** `apps/web/src/editor/render/render-seams.test.tsx` (the three ```` ```query ```` fence
tests time out when it regresses)

Seen while building B-102, never shipped: the first cut of `editor/DateChips.tsx` imported
`{ CalendarClock, Flag, Repeat } from "lucide-solid"`. `BlockRowView` imports it, and
`QueryFenceView`/`Shelf` import `BlockRowView` (for `MARKER_GLYPH`), so the query fence's lazy
view took longer than five seconds to load under vitest — the barrel re-exports 1,821 icon
modules and vitest, unbundled, evaluates each — and three `render-seams.test.tsx` tests timed
out waiting for it. Evidence: a one-off probe test that `import()`ed `QueryFenceView.js` hit
vitest's 5 s timeout with the barrel import, and passed once the three icons were imported by
path; moving the chip's static `app/date-picker.ts` import to click time first, on its own, did
not make the failing tests pass. Recorded because the trap is still set: the shell
(`Sidebar.tsx`, `AppShell.tsx`, `Shelf.tsx`, `HelpMenu.tsx`, `ReferencesPanel.tsx`) imports the
barrel, which is harmless only as long as no unit test renders those. In the production build
Vite tree-shakes the barrel, so this is a test-time cost, not a bundle one (not measured).

**Fixed 2026-09-13.** `DateChips.tsx` imports one file per icon
(`lucide-solid/icons/calendar-clock` …). It also loads `app/date-picker.ts` (and with it the data
layer) on click rather than at module load — not needed for the timeout, but a row renderer that
the shelf and the query fence share should not drag the replica client in.

---

### B-102 · A task's scheduled/deadline date is not shown on its row
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D8)

`scheduled`/`deadline` are on `EditableBlock` and shown in the Tasks view, but `BlockRowView`
never renders them — a `TODO call mom` with `scheduled:: 2026-09-20` is just "☐ call mom" on the
page. Fix: a small date chip after the marker (a cheap win the audit ranks #2).

A task's scheduled/deadline date is not shown on its row.

**Fixed 2026-09-13.** `editor/DateChips.tsx` (one hookup line in `BlockRowView.tsx`) renders a
chip per date at the end of the row — relative label (Today, Tomorrow, Fri, Sep 20, Sep 20 2027,
with the time), `vr-date-overdue` on an open task whose date is before today, `vr-date-today`,
muted on DONE/CANCELED, plain `past` on a non-task. "Today" is a signal re-armed at local
midnight and on tab re-show, so a page left open overnight turns overdue without a refetch.
Clicking a chip opens the picker on that date, anchored under the chip, without entering edit
mode; the picker's Remove button clears it.
**Test:** `e2e/tests/dates.spec.ts` "chips: overdue on an open task, muted on a closed one, plain
on a note or a future date (B-102)" and "clicking a chip opens the picker on that date without
entering edit mode; a new date rewrites it; Remove clears it"; unit: `editor/date-chips.test.ts`.

---

### B-96 · `/scheduled`, `/deadline` and the date commands do nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D2)

`app/CommandLayer.tsx` passes `createFakeDatePickerHost()` — a test double — to the real command
set, so the trigger text is removed and nothing else happens; no picker element exists. Fix: a real
popover writing `setBlockProp` for `scheduled`/`deadline`.

`/scheduled`, `/deadline` and the date commands do nothing.

**Fixed 2026-09-13.** `app/CommandLayer.tsx` now hands the command set the real host
(`app/date-picker.ts` → `commands/date-picker/host.ts`) instead of `createFakeDatePickerHost()`.
`task.setScheduled`/`task.setDeadline` open a keyboard-first picker
(`commands/date-picker/DatePicker.tsx`, spec R38): type a date — `tomorrow`, `fri`, `+3d`,
`2026-09-20 14:00`, `20.9.`, `every week`, `none` (`commands/date-picker/parse.ts`) — or move the
highlight with the arrows (±1/±7 days, PageUp/PageDown a month), Enter sets, Escape cancels.
The editor keeps DOM focus throughout, so the caret is where it was when the picker closes. Keys
are taken in the window's capture phase and the popup keys are claimed through
`claimPopupKeys`; a document-level listener (as `TemplatePicker` uses) was tried and loses to the
global keymap in block selection: Backspace deleted the selected block (verified by swapping the
listener and re-running the e2e test below, which then failed with the block gone). A pick is one
`setBlockProps` batch (`scheduled`/`deadline` in ADR 011's `YYYY-MM-DD[ HH:MM]`, plus `repeat`
when one was typed). With an argument (an agent through `ui_run`) the commands write directly
with no picker.
**Test:** `e2e/tests/dates.spec.ts` "/scheduled, type tomorrow, Enter: scheduled:: is stored, the
chip appears, the caret never left (B-96)" (would have caught it: no `.date-picker` ever
appeared), plus "/deadline with a typed ISO date and time, then arrows…", "Escape cancels…",
"from block selection, the palette's Set deadline date opens the picker and Backspace edits the
date, not the selection"; unit: `commands/date-picker/{parse,host}.test.ts`,
`DatePicker.test.tsx`.

---

### B-160 · The shelf is reachable only by Shift+click
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md` §1.4, §1.10 #15, §2 item 6) · **Tests:**
`e2e/tests/commands.spec.ts` "the bullet context menu's Open on shelf puts that block on the shelf
(B-160)", "Open on shelf and Open this page on shelf run from the palette (B-160)", "Shift+Enter on
a page in the palette shelves it without leaving the current page (B-160)";
`apps/web/src/commands/registrations/shelf.test.ts`; `CommandPalette.test.tsx` "Shift+Enter on a
page row shelves it instead of opening it, and says so"

Nothing in the palette, the bullet context menu or the page switcher puts a block or a page on the
shelf; the only way in is a Shift+click on a bullet or a `[[link]]`, which nothing on screen
mentions. A keyboard user cannot shelve anything at all.

**Fixed 2026-09-13.** Two commands (`commands/registrations/shelf.ts`, host `app/shelf-host.ts`,
both landing in `app/shelf.ts#openOnShelf` like a Shift+click): `block.openOnShelf` "Open on shelf"
(`editorFocused || blockSelected`; the focused block or the first selected) and
`nav.openPageOnShelf` "Open this page on shelf" (the page on the current route; `nav.` because
`page.` is not an R2 area and would blank the app, B-87). "Open on shelf" is in the bullet context
menu under "Zoom in" (`context-menu.spec.ts`'s pinned label list updated). In the palette,
Shift+Enter — or Shift+click — on a page row shelves the page instead of opening it, and a hint line
under the list says so whenever a page row is highlighted. Limitation, same as `edit.mergePage`:
"Open this page on shelf" is listed off a page route too (journals, search) and does nothing there,
because `WhenContext` cannot see the route.

---

### B-106 · Comment and spec drift around commands
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D12)

`DiagnosticsPanel.tsx` refers to an `app.diagnostics` command that does not exist;
`docs/spec/commands-and-keymap.md`'s table lacks the nine `format.*` and four `task.setMarker*`
commands and does not list `nav.openPage`/`nav.revealBlock`. Fix: regenerate the table from the
registrations (the wiki's shortcuts page already does this) and delete the stale comment.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit · **Test:**
`apps/web/src/commands/registrations/spec-tables.test.ts` (spec §E tables vs the registered
commands: ids, section/category, title, keys, `when`; spec R54's slash table vs `SLASH_ITEMS`)

What was still true at `da85cfb`: the nine `format.*` and the `task.setMarker*` rows had already
been added (the audit read an older spec), but eight registered commands had no row —
`nav.openPage`, `nav.revealBlock`, `block.insertQueryFence`, `block.insertTemplate`,
`block.turnIntoPage`, `block.moveToPage`, `edit.mergePage`, `search.findReplace` — and R54's slash
table lacked the Template and Query items while still saying templates are "not a core slash item",
which ADR 019 reversed. `DiagnosticsPanel.tsx` still named a nonexistent `app.diagnostics` command.
Every title, key and `when` of the rows that did exist matched the code.

**Fixed 2026-09-13.** Rows and short rules added for all eight (R32b, R43b, R49a, R52), plus this
branch's own `block.openOnShelf` / `nav.openPageOnShelf` (R32a, R43a) and `requiresArgs` (R1a);
R54 gains Template and Query and cites ADR 019. The DiagnosticsPanel comment now names the two real
ways in (the top bar's sync indicator, Settings → About). `spec-tables.test.ts` fails against
`da85cfb`'s spec (2 of 4 tests: the eight missing ids, and the slash table) and will fail the next
time a command is added without its row — which is the intent; the fix is a spec row. Also: the
wiki generator (`docs/wiki/tools/generate-shortcuts.mjs`) now passes the optional refactor and shelf
hosts (their commands were missing from the wiki page) and lists `requiresArgs` commands apart from
the palette-reachable ones; `docs/wiki/pages/Keyboard shortcuts.md` regenerated (90 commands).

---

### B-105 · Argument-only commands show as palette rows that do nothing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D11)

`nav.openPage` and `nav.revealBlock` take arguments (they are agent primitives for the live UI
channel) but appear in the palette as "Open page" / "Reveal block" and do nothing when chosen. Fix:
a `hidden`/`argsOnly` flag the palette respects.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit · **Tests:**
`apps/web/src/commands/palette/CommandPalette.test.tsx` "never lists a command that requires
arguments, even when the query matches it"; `apps/web/src/commands/registrations/palette-rows.test.ts`
(every command the palette lists with nothing focused, run with no args, must reach a host)

**Fixed 2026-09-13.** `Command.requiresArgs` (spec R1a): a command whose `run` does nothing without
`ctx.args` declares it, and `CommandPalette` filters those out. `nav.openPage` and
`nav.revealBlock` set it; `ctx.exec(id, args)`, the live-UI channel (`live/command-runner.ts`) and
a `keybindings.json` row with `args` still run them. Both tests fail with the flag removed.
`palette-rows.test.ts` is the general guard: it runs each of the ~20 commands the palette lists with
nothing focused, as a palette row does (no args), against the fake hosts, and fails for any that
reaches none — it would have flagged these two at registration time. It cannot see a real host
that ignores a delegate (B-97's shape); `e2e/tests/commands.spec.ts` covers that.

---

### B-98 · "Open plugin manager" leads to a blank page
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D4)

`app/hosts.ts` navigates to `/settings/plugins`, which is not a route; the main area is empty.
Fix: open the settings panel's plugins section, or drop the command until one exists.

**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit · **Test:**
`e2e/tests/commands.spec.ts` "Open plugin manager opens Settings at the list of running plugins,
not a blank page (B-98)"

**Fixed 2026-09-13.** Not a manager — there is nothing to manage from the client: the server
exposes `GET /api/v1/plugins` (active plugins only) and no op to enable, disable or reload one
(`nooklet plugin …` is the only switch, and it takes effect when `nooklet serve` restarts). So
Settings gained a read-only Plugins section
(`views/PluginsSection.tsx`, data in `data/plugins.ts`) listing name, id, version and which halves
each plugin has, with a note naming the CLI commands, saying a restart of `nooklet serve` applies
them (added in verification — the note first read as if the change were immediate), and saying
disabled plugins are not shown.
`app.openPluginManager` now opens Settings scrolled to that section (`AppDeps.openPluginManager`,
wired in `CommandLayer.tsx`) and no longer navigates anywhere. The test compares the section's rows
with what the server's endpoint returns (the e2e server loads the repo's `plugins/`); against the
old code it fails on the URL changing to `/settings/plugins`. Spec R52 updated.

---

### B-97 · "Collapse all" and "Expand all" do nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D3)

Registered with `when` clauses and shown in the palette, but `BlockTree.tsx` has no `case` for
either id. Audit: on a 3-level page, Collapse all left 5 rows at 5. Fix: the two cases, over every
block with children (or the visible subtree when zoomed).

**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit · **Tests:**
`e2e/tests/commands.spec.ts` "Collapse all and Expand all fold the whole page with nothing focused,
and it persists (B-97)", "zoomed into a block, Collapse all and Expand all act on that subtree only
(B-97)", "Collapse all while editing a block it hides ends editing, and the page stays editable
(B-97)", "a selected block that Collapse all folds away is deselected, so Backspace deletes nothing
hidden (B-97)", "Collapse all is one undo step: Cmd/Ctrl+Z in the page opens everything it folded
(B-97)"; `apps/web/src/editor/collapse-all.test.ts`; `apps/web/src/editor/outline-registry.test.ts`

Two causes, not one. The audit's reading was right that `BlockTree`'s `runCommand` and selection
switch had no case for either id. But even with the cases, the palette row the audit tried — with
nothing focused — could never reach a tree: structural commands go through
`app/editor-host.ts#activeEditorHost()`, which is the inert no-op host unless a block is being
edited or selected.

**Fixed 2026-09-13.** `editor/collapse-all.ts#setAllCollapsedOps` builds one `block.prop
collapsed` op per block with children whose flag changes — over the whole page, or, zoomed, over
the zoom root's subtree (Collapse all leaves the root itself open, Expand all opens it). `BlockTree`
commits them as one undoable batch through `commit`, the same path as Cmd+Up, so they sync and
mirror like any collapse. If the row being edited (or part of a selection) folds away, editing ends
— a surface left attached to an unmounted row swallows keystrokes. For the nothing-focused case,
every editable `BlockTree` registers in `editor/outline-registry.ts` and the no-op host hands the
two page-scoped ids (and only those) to all of them: on a page view that is the page; on the journal
stream, every loaded day. All three e2e tests fail against `da85cfb`'s `BlockTree.tsx` /
`editor-host.ts` (rows stay 6/4/2). Not covered by e2e: the journal stream fan-out (seeding journal
days in a shared-server spec disturbs `journals.spec.ts`; the fan-out is unit-tested).

Real graph (`tools/probes/collapse-all-real-graph.mjs`, a copy of the owner's graph served on 6402,
page "OmnivoreSync": 961 blocks, 150 parents, 110 collapsed): Expand all → 961 rows on screen in
467 ms, server shows 0 collapsed ~11 s later; Collapse all → 1 row (the page has one top-level
block) in 136 ms, server shows 150/150 collapsed ~11 s later, and a reload still shows 1 row. No
flag was written on a leaf. `pnpm nooklet verify` on the copy afterwards: 20,671 ops replayed, OK.
The ~11 s is the time for the batch to reach the server, not the UI — not investigated further.

Verification (second agent, 2026-09-13): the selection guard is load-bearing — with the
`setSelection(null)` line removed, the "deselected" test fails because Backspace deletes the hidden
`a1` on the server. Journal stream probed in a browser against a scratch server (3 seeded days):
nothing focused folds all three, a focused block folds only its day; `nooklet verify` OK. R26's
prose still said "every block" and "the page's overflow menu" (which does not exist); rewritten to
what the code does.

---

### B-85 · Moving a block to another page makes its children vanish from both pages
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, probing for `block.move_to_page` ·
**Tests:** `packages/server/src/ops/block-move-to-page.test.ts` "moves the whole subtree, not
just the root",
`packages/server/src/ops/page-merge.test.ts` "nested blocks survive the move"

`block_move {id: <a block with children>, page: "Other"}`: the block appears on `Other`, its
children appear nowhere. `page_read` of either page lists only what was already there, plus the
moved block with `children: []`. In the database the children still say `page_id = <old page>`
with `parent_id = <the moved block>`, so neither page's tree query finds them.

Cause: `@nooklet/core`'s `applyBlockPlace` updates one row — the block the op names — and a
`block.place` op that changes `pageId` carries nothing about descendants. The reducer is right to
be one-op-one-row (that is what makes it replayable), so the fix is at the op layer: every
cross-page move emits a `block.place` for each descendant too, keeping its parent and order and
changing only the page (`data-api.ts#subtreePlaceOps`). The M7 ops (`block.to_page`,
`block.move_to_page`, `page.merge`) and `DataApi.blocks.move` do this. **`ops/block-move.ts` does
not yet** — its `page:` form needs the same two-line change; owned by another agent this session.

**Fixed 2026-09-13.** `block.move` now goes through `data-api.ts#subtreePlaceOps` like the M7 ops: one
`block.place` per block, root first, only when the page changes. `updated` lists every moved id.
Test: `packages/server/src/ops/ops.http.test.ts` "moves the whole subtree when the target is another
page (B-85)" (rebuild parity asserted).

Big batches stall the server (F8, plus one found in passing while measuring B-120):

- **`recordChanges` looked each op's result up with `results.find`**, once per op — quadratic in
  the batch. `graph.replace` allows 20,000 blocks in one `applyOps`; a big `page.merge` or sync
  push is one batch too. The skeptic measured the `find` alone at about 0.25 s at 8k ops and 1.1 s
  at 20k.
- **A cross-page move of a large subtree was slow** on the code as it stood before this branch. Moving the owner's largest subtree (961 blocks) with `subtreePlaceOps`
  through `serverApplyOps` took 23 s at `da85cfb` (load average ~24 on a shared machine).
  `reindexTouchedEntities` calls `reindexBlockAndSubtree` for every placed block, which walks that
  block's whole subtree with `SELECT id FROM block WHERE parent_id = ?` — no `deleted_at` filter,
  so the partial `block_children` index cannot serve it and every step is a full scan — and
  rebuilds `path_ref` for each descendant: roughly subtree² full scans. Fix direction: collect the
  union of touched subtrees once per batch (live children via the index, tombstoned ones from one
  scan, as `subtree-page-repair.ts#childLookup` does), then rebuild each block's `path_ref` once.

**`recordChanges` fixed 2026-09-13 (F8).** One `Map` from op id to result, built once. No unit
test — a timing assertion is not a signal on a machine shared by a dozen agents, so this is
believed fixed and measured instead: `tools/probes/apply-ops-batch-scaling.ts` times the lookup
shapes side by side — at 16,000 ops, 1,364 ms of `find` against 2 ms of `Map` — and one
`serverApplyOps` of N `block.text` ops (2k / 8k / 16k: 266 / 2,419 / 8,243 ms before, 239 / 2,256 /
7,687 ms after, load average 5–13). The batch was still quadratic after that; the remaining cost
was the reindex walk in the second bullet (every `block.text` reindexed its block's subtree through
the unindexed `parent_id = ?` query — a full scan per block).

**Reindex walk fixed 2026-09-13.** `packages/server/src/block-children.ts#childLookup` reads live
children through `block_children` and tombstoned ones from one scan per pass;
`reindexTouchedEntities` rebuilds `ref` for every touched block first and then `path_ref` once for
the union of their subtrees (it rebuilt each touched block's whole subtree, per block). The subtree
page repair (B-120) and the B-86 re-index share the lookup. Test:
`packages/server/src/block-children.test.ts` "reads live children through the block_children index,
never a table scan per parent" (an `EXPLAIN QUERY PLAN` assertion — deterministic, unlike a timing).
Equivalence on real data: `tools/probes/reindex-parity-real-graph.ts` rebuilt every `ref` and
`path_ref` row of the owner's graph copy through the new walk — 2,185 and 32,671 rows, identical
to what the old walk had built. Measured (load average ~20, i.e. against the machine, not for it):
16,000 `block.text` ops in one batch 7.7 s → 1.8 s (8,000: 1.0 s, now linear); the owner's
961-block subtree moved by the server-planned path 23 s → 0.46 s, and by a device op (with the
B-120 repair) 18.8 s → 1.0 s.

---

### B-95 · `nooklet serve` never writes the markdown mirror
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D1)

Only `nooklet export` calls `exportAll` (`packages/server/src/cli.ts`); `config.mirror.enabled`
is read by nothing. Verified live by the exposure audit: `page.create` against a mirror-default
server produced no `pages/` directory. README and OPERATIONS §2 describe the mirror as continuous —
"a greppable copy you can walk away with" — which today is only true after running a command
nobody is told about. Fix: export each touched page after a commit, debounced, from the serve
process (`sync/realtime.ts#onCommit` already exists for exactly this kind of listener).

**Fixed 2026-09-12.** `mirror/live.ts`: `nooklet serve` subscribes to commits and, after a 500 ms
quiet period, runs `exportAll(…, { onlyChanged: true })` — the already-tested path that writes
changed pages, moves renamed ones and prunes deleted ones — plus one sweep on start to catch up
whatever happened while the server was down. `--no-mirror` is honoured for the first time. Failures
log and never throw: the mirror is a projection and must not take down the source of truth.
`packages/server/src/mirror/live.test.ts`.

---

### B-64 · Block-selection mode is keyboard-dead
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/selection.spec.ts` (10 `fixme`), `e2e/tests/focus.spec.ts` "Escape while editing hands
the block to selection mode and Enter hands it back"

Escape (or Cmd/Ctrl+click) selects a block. From then on nothing on the keyboard does anything:
Enter does not re-enter editing, Shift+Up/Down does not extend, Backspace/Delete do not delete,
Tab does not indent, Cmd/Ctrl+A does not select all, Cmd/Ctrl+C copies nothing, Alt+Up/Down
does not move, and a second Escape does not clear. Two layers. After Escape, `surface.detach()`
removes the focused element and nothing focuses the outliner (`tabindex="-1"`), so its own
keydown handler never fires — `document.activeElement` is `<body>`. And on every route in, the
document-level dispatcher (`CommandLayer`'s `KeyboardDispatch`) matches the `blockSelected`
bindings first and runs them through `EditorHost.runStructuralCommand`, which returns early
because `surface.currentId()` is null while selected — then `stopPropagation` keeps the key from
the outliner's handler even when it does have focus (Cmd/Ctrl+click leaves focus on the
`.vr-block-view`). `task.cycle` is the one key that works, because it writes through the store.
`block.copySelection` additionally has no implementation anywhere (not in `keydown.ts`, no `copy`
handler).

**Fixed 2026-09-12.** Both layers: entering selection mode (Escape, or a Cmd/Ctrl+click) now
focuses the outliner root; the editor host forwards a command that arrives with no edited block to
the tree, which resolves it against the standing selection instead of returning early; and the
container's own handler ignores keys the editor already consumed, so the Escape that enters
selection mode cannot clear it on the bounce. `focus.spec.ts` 30/30 with the fixmes lifted.

---

### B-65 · The `[[` / `#` / `((` / `/` popups ignore the keyboard
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/popups.spec.ts` (9 `fixme`)

With a popup open: ArrowDown/ArrowUp do not move the highlight; Enter splits the block at the
caret instead of selecting the row (`[[` + Enter leaves `[[` in one block and an empty block
below); Tab indents the block; Escape drops the block into selection mode, and the popup only
closes as a side effect of the editor detaching. Only the mouse works. The popup's `onKeyDown` is
on the popup element, which never has focus, and both `BlockTree`'s dispatch context and the
global dispatcher hardcode `popupOpen: false`, so R12 step 2 never applies. This is the class of
thing B-42 was reported as.

**Fixed 2026-09-12.** Two halves. `commands/popup-keys.ts`: a popup claims Escape / Enter / Tab /
ArrowUp / ArrowDown for exactly as long as it has a trigger, both dispatch contexts read
`popupOpen` from that claim instead of a hard-coded `false`, and the editor's keymap offers the
key to the popup before resolving it as a block command — so Enter selects a row instead of
splitting the block and Escape closes the popup instead of entering selection mode. And in
`CommandLayer`, a dismissal is remembered by the offset the trigger opened at: before, Escape
closed the popup and the very next keyup re-detected the `[[` still in the text and reopened it,
so Escape did nothing you could see. Three of the lifted tests then failed for a test-side reason
worth recording: they read the DOM after the caret had left the token, and the live preview hides
`[[`, `]]` and `# ` there by design — they now read the stored block. `popups.spec.ts` 40/40.

This is very likely what B-42 was reported as: Enter or Escape at the popup ended with the editor
gone, which reads as "focus keeps deselecting and I have to click again".

---

### B-66 · Delete-merge and undo change the block in the database but not in the editor
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/focus.spec.ts` "Delete at the end merges the next block in, keeping the caret",
"Cmd/Ctrl+Z undoes typed text and Cmd/Ctrl+Shift+Z redoes it"

Delete at the end of `ab` with `cd` below: the database now holds one block `abcd`, the editor
still shows `ab`; keep typing and the two drift apart. Cmd/Ctrl+Z after typing ` typed`: the
database reverts to `base`, the editor keeps `base typed`, and a reload shows the other text. An
op that rewrites the content of the block being edited (`deleteForwardMerge`, a text transaction
from `doUndo`/`doRedo`) goes through `commit`/`applyOptimistic` but never touches the mounted CM6
buffer — and the refetch effect then prefers the live buffer, so the model quietly follows the
stale editor.

**Fixed 2026-09-12.** The rule "live buffer wins on refetch" stays — a first attempt to detect
"the database disagrees" at refetch time reverted a split mid-keystroke inside the full suite,
because a refetch that READ before our own write and RESOLVED after it is indistinguishable from
an external change. Instead the local operations that rewrite the edited block — `commit`,
`doUndo`, `doRedo` — sync the editor from the optimistic tree synchronously, where there is
nothing to guess; undo back into the block already being edited places the caret directly, since
`attachEditing` to the same id is a no-op.

---

### B-67 · Shift+Enter does nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/focus.spec.ts` "Shift+Enter inserts a newline inside the block, not a new block"

R17's newline is never inserted. The global dispatcher matches `block.newline` (`when:
editorFocused`), runs it — which is deliberately a no-op, "left to CM6" — and then
`preventDefault` + `stopPropagation`, so CM6 never sees the key.

**Fixed 2026-09-12.** The handler inserts the newline itself through the editor view.

---

### B-68 · Alt+Down drops editor focus
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/focus.spec.ts` "Alt+Up/Down moves the block and keeps the editor in it"

Alt+Up keeps the editor; Alt+Down moves the block and focus lands on `<body>` (the test records
the `focusout` and its stack). The keyed `<For>` moves the focused row's DOM node, which blurs
it, and the attach-time refocus in `surface.ts` only runs on attach.

**Fixed 2026-09-12.** The refocus is deferred past Solid's reconciliation (a microtask, then a
frame — the same two-stage dance `surface.attach` does), guarded so a genuine click-away is not
fought.

---

### B-69 · `#` autocomplete never lists an existing page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/popups.spec.ts` "lists a page that is already used as a tag"

Type `#` and a page's name: the only row is `New page "…"`. `createPageSource.listPages` never
sets `isTag`, and the popup keeps only `p.isTag === true` in tag mode, so the candidate list is
always empty.

**Fixed 2026-09-12.** `isTag` was declared on `PageSummary`, filtered on by the `#` popup and the
palette's tags mode, and set by nothing. A tag is a page (ADR 017), so `#` now offers every page,
ranked by the query, exactly as `[[` does; the flag is gone. `popups.spec.ts` "lists a page that
is already used as a tag".

---

### B-70 · The keyboard toolbar never appears on a phone
**Status:** fixed · **Severity:** high (phone) · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/phone.spec.ts` (2 `fixme`)

Playwright's plain `devices["iPhone 13"]` descriptor — WebKit, iPhone user agent, `pointer:
coarse`, no hover, so `detectPlatformFromEnvironment` reports `platform: ios`, `mobile: true` —
and the same under Chromium emulation: tap a block, type with the editor focused, and no
`.cmd-toolbar` ever renders. `MobileKeyboardToolbar`'s `visible` memo reads `getContext()` →
`activeContextSnapshot()`, which before any block is edited is a constant object with no reactive
reads, so the memo computes `false` once and is never re-run; even afterwards `editorFocused` comes
from `surface.currentId()`, a plain variable, not a signal.

**Fixed 2026-09-12.** The toolbar's `visible` memo read the command context through a plain
module variable — nothing for Solid to track — so it evaluated once at mount, saw nothing focused,
and never ran again. The active context snapshot is a signal now, and the tree withdraws it when
neither editing nor a selection stands, so the toolbar shows while typing and hides after.
`phone.spec.ts` on the iPhone 13 descriptor (WebKit, coarse pointer, iOS UA), both toolbar tests.

---

### B-71 · Choosing a context-menu item or clicking an autocomplete row drops editor focus
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/context-menu.spec.ts` "an item chosen from the menu leaves the editor focused and
typeable", `e2e/tests/popups.spec.ts` "clicking a row leaves the editor focused"

The command runs (Indent indents, the page link is inserted), but the item is focusable — a
`<button>`, or a `tabIndex={-1}` row — so mousedown moves focus to it; the overlay then closes and
focus lands on `<body>`. Typing afterwards goes nowhere until the block is clicked again. The mobile
toolbar already does this right (`preventDefault` on `pointerdown`, spec R61).

**Fixed 2026-09-12.** Rows in the `[[`/`#`/`((`/`/` popups and the context menu's items now
`preventDefault` on mousedown, so a click runs the item without ever moving focus off the editor.
`popups.spec.ts` "clicking a row leaves the editor focused", `context-menu.spec.ts` "…leaves the
editor focused".

---

### B-72 · While a block is in edit mode, Escape ends editing instead of closing what is on top
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/context-menu.spec.ts` "Escape leaves focus and the caret exactly where right-click put
them", `e2e/tests/views.spec.ts` "Escape closes the help menu while a block is being edited…",
"opening the palette while editing and closing it hands focus back to the editor"

Context menu: Escape closes it AND runs `block.selectBlock` — the menu's document listener does
not stop propagation, and the global dispatcher's context still reports `editorFocused`. Help
menu, shortcuts dialog and command palette: their Escape never arrives at all — the global
capture handler runs first, matches `block.selectBlock`, and stops propagation — so the overlay
stays open while the block behind it drops to selection mode.

**Fixed 2026-09-12.** The context menu, the help menu and the command palette now claim Escape
through the same `commands/popup-keys.ts` registry the autocomplete popups use (B-65), so both
dispatchers know something is open and yield the key to it instead of running `block.selectBlock`
underneath. `context-menu.spec.ts` Escape, `views.spec.ts` help Escape and palette focus.

---

### B-73 · Right-clicking a selected block drops the selection
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/selection.spec.ts` "right-clicking a selected block keeps the selection",
`e2e/tests/context-menu.spec.ts` "Delete appears for a selected block and deletes it"

`onContextMenu` calls `attachEditing`, which clears the selection, so the menu's Delete entry —
gated on `blockSelected` — can never appear. This is the "things keep selected when there are
context menu shenanigans" the suite was asked for.

**Fixed 2026-09-12.** A right-click on a block that is part of a standing selection no longer
enters edit mode (which discarded the selection); the menu opens against the selection, so Delete,
indent and move apply to all of it. The tree also publishes its command context while a selection
stands, not only while editing — a selection made by Cmd/Ctrl+click on a never-edited tree had no
context at all. `selection.spec.ts` "right-clicking a selected block keeps the selection".

---

### B-74 · Clicking away leaves the block in edit mode
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/popups.spec.ts` "clicking elsewhere dismisses the popup"

Nothing clears `editingId` on blur, so the row keeps the CM6 surface after a click elsewhere: a
`[[link]]` you just typed cannot be followed (clicking it re-focuses the editor), an open `[[`
popup stays open, and the bullet stays accent. The rendered view only comes back when another
block is clicked. `e2e/helpers/editor.ts`'s `clickAway` documents what tests have to do about it.

**Fixed 2026-09-12.** A `pointerdown` outside the outliner ends editing (flush, detach), except
for clicks that belong to the session — a popup, the context menu, the palette, the mobile toolbar,
the help layers, the shelf, the zoom breadcrumb, or a click that is closing the context menu.
`CommandLayer` also re-detects triggers after a pointer, deferred a macrotask so a click on a
popup row still lands on the row it aimed at; before, the `[[` popup outlived the editor it
belonged to. `popups.spec.ts` "clicking elsewhere dismisses the popup". Note for tests: a click
away now UNMOUNTS the editor, and `not.toBeFocused()` on a missing element fails — the shared
`clickAway` helper polls `activeElement` instead.

---

### B-75 · A page created from the UI is empty with nowhere to type
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "a page created from the missing-page view can be typed into straight
away"

The missing-page view's Create and the palette's Create make the page, then `BlockTree` renders
zero rows and there is no placeholder row like the virtual journal day's — no `.vr-block-view`,
no `.vr-draft-input`, nothing to click. The only way to give such a page a first block is the API.

**Fixed 2026-09-12.** Create now makes the page's first empty block along with the page and
requests focus into it, the way a journal day's first block is made. `pages.spec.ts` "…can be
typed into straight away".

---

### B-76 · The sidebar's "Pages" list is the first twelve names alphabetically
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "the sidebar's Pages list shows the most recently edited pages first"

`Sidebar.tsx` says "most recently edited pages" and takes the first 12 of `useAllPages()`, whose
query is `ORDER BY name`. With a few hundred pages a page you just made never appears there.

**Fixed 2026-09-12.** `recentPages` was a stub that returned `useAllPages()` untouched — which
is ordered by name. It sorts by `updatedAt`, newest first. `pages.spec.ts` "…most recently edited
pages first".

---

### B-77 · Creating a journal-titled page from the missing-page view makes an ordinary page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "creating a journal-titled page from the missing-page view makes a
journal, not an ordinary page"

Open `/page/2027-10-17` (a day with no page), press Create: `PageView.createThisPage` sends
`page.create` with `journalDay: null`, so the graph gets an ordinary page named like a date —
B-23's hole, reopened through the UI. `page.read` of that date then answers not found while the
page exists under that name.

**Fixed 2026-09-12.** Create parses the URL's name with `parseJournalTitle`; a date makes a
journal day (ISO name, `journalDay` set — ADR 018) instead of an ordinary page that would shadow it.
The server-side guard from B-23 could not help here: the op is minted on the client.
`pages.spec.ts` "…makes a journal, not an ordinary page".

---

### B-78 · Renaming a page from its title makes the view say the page doesn't exist
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "renaming a page from its title keeps you on the page under its new name"

The rename commits (the new name reads back, the old one is gone), but the route still carries
the old name, `usePageByName` resolves it to null, and the page you are on turns into "This page
doesn't exist yet" with a Create button.

**Fixed 2026-09-12.** After `page.rename` the view navigates to the new name (`replace`, so Back
does not lead to a URL that no longer resolves). Routes are name-addressed, so the old URL pointed
at nothing the moment the rename applied. `pages.spec.ts` "renaming a page…".

---

### B-79 · Ticking a task in the Tasks view marks it done but the list never updates
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/tasks.spec.ts` "the Tasks view checkbox completes a task and removes it from the open
list"

The click writes `marker = DONE` (the API reads it back), and the row stays in the open list,
unchecked, eight seconds later; a reload removes it. B-05's shape.

**Fixed 2026-09-12.** The worker's change event mapped a `block.prop` op to `block_prop` only —
but reserved keys (marker, priority, scheduled, deadline, repeat, done, collapsed) are routed by the
reducer into the block ROW's own columns, so nothing stamped on `block` ever heard a task was
ticked. A `block.prop` write now invalidates `block` too. `tasks.spec.ts` "…checkbox completes a
task…".

---

### B-80 · A failed search sits on Searching… forever
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/views.spec.ts` "a failed search shows an error with Retry, and Retry recovers"

Abort `/api/v1/search` and the view shows "Searching…" indefinitely: no `.search-error`, no
Retry. B-10 lists search as fixed, but its only e2e test covered the references panel.

**Fixed 2026-09-12.** Reading an errored resource re-throws, and the loading branch's own
`when` read `results()` — so the first failed request threw inside render, the computation died,
and "Searching…" stayed. Every read now goes through a guard that returns `undefined` while the
resource is errored; the error branch and Retry were already there and now actually get to show.
`views.spec.ts` "a failed search shows an error with Retry, and Retry recovers".

---

### B-81 · A second tab of the same graph never renders
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/views.spec.ts` "a second tab of the same graph renders the page"

Open a page in a second tab of the same browser context: "Loading…" for 20 s and counting, no
outliner. Presumably the second tab is waiting on the writer election / OPFS pool and has no
follower path.

**Fixed 2026-09-12.** The worker's leader election waited on the writer lock unconditionally
(`opfs-sahpool` allows one connection per file), so a second tab's worker queued behind the first
until it closed — "Loading…" forever. It now asks for the lock with `ifAvailable`; a tab that does
not get it becomes a **follower**: an in-memory replica bootstrapped from the server, fully usable,
its writes reaching the leader through sync. The sync indicator says "synced via another tab" so
nobody wonders which tab keeps the local copy. Taking the lock over live when the leader closes is
not attempted — a reload does it — because it would mean swapping storage under an open session.
`views.spec.ts` "a second tab of the same graph renders the page".

---

### B-82 · Picking a page in the command palette never opens it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, e2e suite · **Tests:**
`e2e/tests/views.spec.ts` "Enter on a highlighted page in the palette opens it",
`e2e/tests/pages.spec.ts` "Cmd/Ctrl+O switches pages by name with a click"

Cmd/Ctrl+K or Cmd/Ctrl+O, type a page name until it is highlighted, press Enter or click the
row: the palette closes and the URL does not change, with nothing in the console. `CommandLayer`
wires `onSelectPage` to `navigation.openPage(p.id)`, whose `pageNameForId` is
`resolveBlockPageName` — a lookup by BLOCK id, handed a page id, so it resolves to nothing and
`openPage` silently does not navigate. (One earlier probe run saw a click navigate; two later runs
and every Enter did not — treat the click path as broken too.) The palette's "Create page" row
takes a different path and works.

**Fixed 2026-09-12.** `nav.openPage(id)` resolved the page's name with `resolveBlockPageName`,
which takes a BLOCK id and so found nothing. `store.ts#resolvePageName` looks a page up by its own
id. `views.spec.ts` "Enter on a highlighted page…", `pages.spec.ts` "Cmd/Ctrl+O…".

---

### B-83 · A tag page created right after typing the tag never shows the reference
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/pages.spec.ts` "a tag page created straight after typing the tag shows the reference
without a reload"

Type ` #NewTag ` in a block, click the rendered tag, press Create on the missing-page view: the
new page shows no linked references, and keeps showing none (15 s) — although
`page.backlinks` on the server lists the block within moments, and the same flow with a pause
before clicking the tag shows it. The panel fetched its backlinks before the typed ref's op had
been pushed, and nothing re-fetches when the push lands, because `useLinkedReferences` is
server-backed and off the local change bus (B-09's shape, one step later).

**Fixed 2026-09-12.** The references panel is a server-computed view stamped on local writes —
but the write it needed the server to see was still in the push queue when it fetched, and no
later local change re-stamped it. The store now bumps a `syncVersion` when the push queue drains,
and the panel refetches on it. `pages.spec.ts` "a tag page created straight after typing the tag
shows the reference without a reload".

---

### B-84 · `block.copySelection` has no implementation
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, e2e suite · **Test:**
`e2e/tests/selection.spec.ts` "Cmd/Ctrl+C copies the selection as markdown"

Select a block, press Cmd/Ctrl+C: the clipboard is unchanged. The command is registered (it shows
in the shortcuts dialog as Cmd+C) and spec R31 says the trigger is the outliner's native `copy`
event, but `BlockTree` installs no `copy` handler and `keydown.ts` does not know the command.

**Fixed 2026-09-12.** `block.copySelection` is implemented: the selection as outline markdown,
subtrees included, through the same `serializeOutline` the mirror uses (ids omitted), so what you
paste elsewhere is what a page file would say. A block whose ancestor is also selected is copied
once, inside that ancestor. `selection.spec.ts` "Cmd/Ctrl+C copies the selection as markdown".

---

### B-87 · A command registered under an unknown id area blanks the whole app
**Status:** fixed (the ids; the failure mode stays) · **Severity:** high · **Found:** 2026-09-12,
`e2e/tests/refactor.spec.ts` on first run · **Tests:**
`apps/web/src/commands/registrations/refactor.test.ts` "every refactor command registers in the
real registry", and every e2e spec (the app did not boot)

Commit `c916c29` registered `page.mergeInto` and `search`-less `graph.findReplace`. The registry
enforces R2's closed set of core areas and throws `CommandRegistrationError` at
`createCoreCommands` time — inside the first render, so the page stayed a white `<div id="app">`
with the error only in the console. Unit tests passed (they build commands, they never register
them); typecheck passed (an id is a string). Fixed by naming them `edit.mergePage` and
`search.findReplace`, and by a test that registers every refactor command in a real registry.

Still open in spirit: one bad command id, from core or a plugin, is a blank screen with no
message. `CommandLayer` could catch registration errors and render the shell without that
command; not done here (shell/commands provider are not this task's files).

---

### B-92 · Slash menu shows 16 items; `popups.spec.ts` pins 15
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, full e2e run (views agent, M7) ·
**Test:** `e2e/tests/popups.spec.ts` "opens at a run start with every item in R54 order" and
"opens as the first character of an empty block"

Type `/` in a block: the popup lists sixteen items — the M7 `Template` entry (78970b1,
`apps/web/src/commands/slash/items.ts`) is there — but `SLASH_ORDER` in `popups.spec.ts` still
lists the fifteen from R54, so the two count/order assertions fail on every full run. Either the
spec's list needs the new item in its R54 position or the keymap spec's R54 needs the item added;
whichever way, the two should agree. Seen with the suite run from a worktree at `f1675df` +
`81546e1`; not caused by, and not fixable from, the references/appearance/shelf work.

**Fixed 2026-09-12** (templates agent): `SLASH_ORDER` now lists `Template` and `Query` after
`Property`, matching `items.ts`; the two tests above pass again and pin the seventeen-item
order. The spec's R54 table still lists fifteen — the coordinator owns that file.

---

### B-107 · Enter on a calendar-opened journal day drops the caret
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, `e2e/tests/templates.spec.ts`
"a day started in the app begins with the journal template, the typed text after it" (the first
test to type into a pinned day) · **Tests:** that e2e case, and
`apps/web/src/views/VirtualJournalDay.test.tsx` "hands its focus request back if it is torn down
while the caret is inside it"

Open a day from the calendar (a virtual, not-yet-existing day), type into its placeholder, press
Enter: the blocks are created but there is no editor anywhere — the same failure B-06/B-16's
era had for today, on a different path. `VirtualJournalDay` asks for the caret in the new
sibling and optimistically mounts its own `BlockTree`; that tree's single `getPageTree` resolves
before `usePinnedJournalDay`'s two-step fetch, claims the request and attaches the editor — then
the pinned resource resolves, `JournalStreamView` swaps in its own `BlockTree` for the now-real
page, and the component holding the editor is unmounted. Today's day never showed it because
`useJournalStream` resolves first, so the stream's tree is the one that claims the request.

Measured with a MutationObserver/focus probe on the pinned flow: the optimistic tree's editor
appears and takes focus at 43 ms, the teardown's `surface.detach()` blurs it at 43.9 ms, the
successor outliner appears at 44.6 ms, and no editor exists afterwards. On today the successor
appears at 132 ms and attaches its editor at 136 ms.

**Fixed 2026-09-12** (templates agent, in `VirtualJournalDay.tsx`): when the component is torn
down after its focus request was consumed, it re-issues the request for the block it had asked
for, and the successor tree for the same page claims it. No heuristic about where the caret was:
the teardown's blur is indistinguishable from a click on the page background, and nobody clicks
away inside the swap's window. The race itself (two trees for one page during the swap) is the
stream's to remove; the hand-back makes it harmless.

---

### B-110 · `nooklet import <missing dir>` reports success with zero pages
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream — `pnpm nooklet import
docs/wiki` from the repo root (`pnpm nooklet` runs with cwd `packages/server`, so the relative path
pointed at nothing) printed `pagesImported: 0`, no warning, no error · **Test:**
`packages/server/src/importer/logseq.test.ts` "refuses a graph directory that does not exist"

`listMdFiles` answers `[]` for a missing directory on purpose — a graph may have no `journals/` —
so a missing *graph* looked like an empty one. `importLogseqGraph` now throws before touching the
database when the path is absent or not a directory, and the CLI exits non-zero with the message.

---

### B-51 · Uploaded images were broken pictures on every route below the root
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, by the first test that ever rendered
one · **Test:** `e2e/tests/assets.spec.ts`

`asset.upload` hands back `![alt](assets/<id>.png)` — a relative path — and the renderer put it
into `<img src>` untouched. At `/journals` that resolves to `/assets/<id>.png` and works. At
`/page/Some Page`, where most images are actually looked at, it resolved to
`/page/assets/<id>.png`, the SPA fallback answered with `index.html`, and the picture was broken.
`naturalWidth` was 0; nothing in the console said so.

The stored form stays relative on purpose — it is what the mirror writes and what a Logseq graph
already uses. `editor/render/asset-url.ts` now resolves `assets/…`, `./assets/…` and
`../assets/…` to the server's `/assets/:id` route at render time, for images and for links (a
PDF is a link). No e2e test had ever rendered an asset; found on the way to importing the Logseq
graph's `assets/`, which would have produced 153 broken pictures the moment it worked.

### B-63 · A plugin's mounted sub-app and its RPC routes were unauthenticated
**Status:** fixed · **Severity:** low (security) · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/plugins/host.test.ts` "guards a mounted sub-app and rpc.expose"

`registerRoute(method, path, handler)` defaulted to `auth: "required"`, but the other two shapes
did not: `registerRoute(app)` forwarded every request under `/api/plugins/<id>/` to the sub-app
with no check at all, and `rpc.expose` mounted an unauthenticated POST on the reasoning that only
the plugin's own client half calls it "over localhost". With `--host` set, both are reachable by
anyone on the network — and the client half holds the app's token, so nothing was gained.

Both now require a valid bearer token (scope is the plugin's own business; `RouteInfo.origin`
carries the token id); `registerRoute(app, { auth: "none" })` opts a sub-app out explicitly, as
the handler form already could. `@nooklet/plugin-api` documents the rule.

### B-61 · An uploaded `.html` asset ran in the app's origin; a bad `mime_type` made every fetch a 500
**Status:** fixed · **Severity:** low (security) · **Found:** 2026-09-12, code review · **Tests:**
`packages/server/src/ops/asset-upload.http.test.ts` "serves hostile content as an inert document",
"rejects a mime_type that is not a well-formed media type"

`GET /assets/:id` echoed the uploader's `mime_type` as `Content-Type` with no
`X-Content-Type-Options` and no CSP. Upload `text/html` (or an SVG with a `<script>`), open it in a
tab, and it executes on the app's origin — with `localStorage`, the device token included, in
reach. On loopback that token is handed out freely anyway; behind a tailnet it is the credential.
Separately, a `mime_type` containing a newline was stored as given, and `new Response` threw on
every later fetch of that asset: a permanent 500 for one bad upload.

Responses now carry `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`
(any document built from the response runs in an opaque origin with no script — `<img>`,
`<video>` and `<audio>` subresources are unaffected), `mime_type` must be a `type/subtype` in RFC
6838's token characters, and the file is streamed instead of `readFileSync`-ing up to 25 MB on
the event loop per request.

### B-62 · `page_list({tag: "art"})` returned pages tagged `party`
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/ops/ops.http.test.ts` "filters by tag through the page_tag index"

The filter was `tags:: LIKE '%art%'` on the raw property text: a substring match, so `art` found
`party` and `smart`, and whether `#art` or `[[Art]]` matched depended on how the property had been
typed. ADR 017's `page_tag` table exists for exactly this and is keyed the way every other
reference is; `page.list` now uses it, and `art`, `Art`, `#art` and `[[Art]]` are one tag.

### B-60 · Any `/ui/live` socket could answer any window's request; a closed window kept callers waiting
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, code review · **Tests:**
`packages/server/src/live/rpc.test.ts` "only the socket a request was sent to can answer it",
"closing the window fails its in-flight requests at once"

A `state.result`/`command.result` frame resolved whichever pending request carried its
`request_id`, regardless of which socket sent it — including a socket that had never completed
`hello`. `request_id`s are random UUIDs, so guessing one is impractical, but an unauthenticated
connection should not be able to answer anything. And `unregisterWindow`'s doc said it failed the
window's in-flight requests immediately; it did not, so a tool call to a window that had just
closed waited out the full 2 s timeout.

A pending request now remembers the socket it went to and only that socket can settle it; closing
the socket settles its requests as "did not answer" at once.

### B-59 · The stdio bridge dropped `ui:control`, so Claude Desktop never saw the `ui_*` tools
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/mcp/stdio.test.ts`

`nooklet mcp --stdio` resolved its one fixed token with `scopesFor(verified.scope)` — the
read/write/admin tier alone — where the HTTP and MCP mounts use `allScopesFor(verified)`, which
adds `ui:control` for a token minted with `--ui-control`. `tokens.ts` says in so many words that
every caller building an `OpContext` must use `allScopesFor`; this one was missed. Over stdio the
five `ui_*` tools were never listed, however the token had been created.

### B-58 · `idempotency_key` was accepted, documented, recommended — and ignored
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review · **Tests:**
`packages/server/src/ops/ops.http.test.ts` `describe("idempotency_key (B-58)")` — replay,
conflict on a different body, per-token scope, dry runs ignored, failed writes not remembered,
24-hour expiry

Every write op took `idempotency_key`, its description said "repeating a call with the same key
and body returns the original result instead of applying it twice (stored 24h)", and
`page_append`'s description told agents to "pass idempotency_key if you might retry after a
timeout, or you may get duplicate blocks". Nothing read the field. A retried `page_append`
duplicated the blocks — the one outcome the field exists to prevent, on the one call whose
description promised otherwise.

Implemented as mcp-tools.md §3.6 specifies (`ops/idempotency.ts`, table `idempotency`, migration
v6), wrapped around every write in `runOpHandler` so HTTP, MCP and the stdio bridge behave the
same. The request identity is the parsed input with defaults applied and keys sorted; a
`dry_run` is never recorded.

### B-57 · `batch_undo` said "a batch_id returned by any write"; no write returned one
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review · **Tests:**
`packages/server/src/ops/batch-undo.http.test.ts` (uses the returned id), `ops.http.test.ts`
"page_create with markdown is one batch" and "a dry run or a no-op write carries no batch_id"

The README promises an agent can "undo any batch it just made". `batch_undo`'s input said its
`batch_id` comes "from a previous write's response" — but `WriteResult` had no such field, so the
only way to undo your own `page_append` was to call `changes_since` and fish the id out of the
first item, which is what the undo tests themselves did.

Every write now returns `batch_id` (absent for a `dry_run` or a no-op, when nothing was written),
and `batch_undo`'s own result uses the same field rather than a one-off `undo_batch_id`.

Fixed alongside: `page_create` with `markdown` was two batches — the page through `DataApi`, the
blocks through a second `applyOps` — so undoing "the batch it just made" emptied the page and left
the page. It is one batch now; undoing it removes the page too.

### B-56 · `changes_since` reported an undone deletion as another deletion
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/ops/ops.http.test.ts` "reports an undone delete as a restore"

`batch_undo` of a delete mints `block.delete { deletedAt: null }` — a restore, by ADR 003's
tombstone model. `changes_since`'s classifier only looked at the op *kind*, so the restore came
back as `block.deleted` (and a page as `page.deleted`): an agent catching up on history was told
the thing it had just brought back was gone again. The `block.restored`/`page.restored` kinds in
the output schema had never been produced by anything.

Fixed alongside: three tool descriptions promised a trash "restorable for 30 days" and `block_read`
hinted "ask the user to restore it". There is no trash view and no 30-day window; deletes are
tombstones and the one restore mechanism is `batch_undo` on the write's `batch_id`. The
descriptions and `docs/spec/mcp-tools.md` now say that.

### B-55 · `alias::` never worked, and `keep_alias` wrote an index row no other device would ever see
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, code review; confirmed on the
owner's graph (three pages with `alias::`, `page_alias` empty) · **Tests:**
`packages/server/src/apply-ops.test.ts` "derives page_alias from alias::" and "re-resolves
references by the old name on rename", `ops.http.test.ts` `describe("aliases (B-55)")`,
`db.test.ts` (migration v5 fills the table from an existing property)

Two halves of one omission. Nothing ever populated `page_alias` from a page's `alias::` property —
the spec (sql-schema.md rule 6) says a change to `alias::` MUST refresh it, and the importer
brought the property across, but no code derived the table, so `page_read("garden")` on a page
called `Zahrada` with `alias:: garden` was `not_found`. The one thing that did write the table
was `page.update keep_alias`, with a raw `INSERT` outside `serverApplyOps` — a row that no other
device, no `rebuild()`, and no `nooklet verify` would ever reproduce.

Now `page_alias` is derived on every page write, like `page_tag` (`packages/server/src/
page-aliases.ts`); `keep_alias` appends the old name to the `alias::` property with an ordinary
`page.prop` op and the index follows; a reference to an alias resolves to the page
(`ref.dst_page_id`), and backlinks are computed over the page's own key plus its aliases (rule 13).
Renaming back to a former alias removes that name from the list rather than leaving a page listed
as its own alias. Migration v5 rebuilds the table for existing graphs.

Fixed alongside, because the same re-resolution covers it: a `[[Page]]` written before `Page`
existed stayed unresolved (`dst_page_id NULL`) until the referencing block happened to be edited
again; creating, renaming or deleting a page now re-resolves every reference addressed by any
name it answered to before or answers to now.

Not done here: the web client's `usePageByName` looks up `page.key` only, so opening
`/page/garden` in the app still says the page does not exist even though the API resolves it.
`page_alias` is a server-only table; the client would need to scan `page_prop.alias`.

### B-54 · Every server start left one more live write token behind
**Status:** fixed · **Severity:** medium (security) · **Found:** 2026-09-12, code review; confirmed
on the owner's graph (three live `web-client (auto)` rows) · **Tests:**
`packages/server/src/auth/tokens.test.ts` "createSoleToken revokes every earlier live token",
`packages/server/src/http/host-guard.test.ts` "a restart retires the previous process's auto token"

The served client's credential is minted per process on the first `/api/session` and — the
comment said — "lives only in memory ... so a restart invalidates old sessions". The raw string
did; the row did not. Its hash sat in the `token` table as a live `write` + `can_sync` token, and
nothing ever revoked it, so a graph accumulated one usable credential per `nooklet serve`, each
one invisible to `nooklet token list`'s reader as anything but "active, last used <date>".

A process that has exited cannot retire its own token, so its successor does: `createSoleToken`
revokes every live token with the same label in the transaction that mints the new one. A
long-running server still keeps its single token for its whole life.

### B-53 · Searching for `c++`, `e-mail` or `what's` was an HTTP 500
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, code review; reproduced with
`tools/probes/fts5-query-syntax.mjs` · **Tests:** `packages/server/src/ops/fts-query.test.ts`
(every probe string against a real FTS5 table), `ops.http.test.ts` "survives punctuation FTS5
would choke on" and "honours -exclusions and quoted phrases"

The raw query string went straight into `block_fts MATCH ?`. FTS5's query language is not a search
box: `c++`, `what's`, `a.b`, `(`, a lone `AND` and an unbalanced `"` are syntax errors, and
`e-mail` / `foo -bar` are read as *column filters* ("no such column: mail"). Each of those came
back as `internal` — to the search view as "Couldn't search", to an agent as a broken tool. An
e-mail address is not an edge case in a notes app.

Worse, the description promised `-exclusions`, and the one thing a `-` could never do in raw FTS5
was exclude. `ops/fts-query.ts` now compiles the documented grammar — words, `"phrases"`,
`-exclusions`, `prefix*` — into string literals only, so nothing typed can reach the query
language. Exclusions with no positive term give no hits rather than an error.

Also fixed alongside: `updated_after: "yesterday"` (anything `Date.parse` rejects) became `NaN`,
which compared false against every row and returned nothing — indistinguishable from "no
matches". It is `invalid` now, with the format in the hint.

### B-43 · Without OPFS the client died silently — no message, nothing rendered
**Status:** fixed · **Severity:** high · **Found:** 2026-09-12, running the B-42 probe in WebKit ·
**Tests:** `e2e/tests/storage.spec.ts` (runs under a new `webkit` Playwright project scoped to
that one file) · **Probe:** `tools/probes/playwright-webkit-opfs.mjs`

The replica is `opfs-sahpool`, which needs OPFS sync access handles inside a worker. Where those
are missing — Playwright's WebKit build, some privacy modes, some embedded webviews — every worker
RPC rejected with `UnknownError: The operation failed for an unknown transient reason (e.g. out of
memory)`, the console filled with unhandled rejections, and the app showed a blank journal
forever. Nothing said why.

`openSqliteWasmDriver` now falls back to an in-memory database, warns once, and reports
`storage: "memory"` through `WorkerApi.init()`; the shell's sync indicator then says **"not saved
locally"** where it would otherwise say "synced" — which would also have been true, and exactly
the wrong thing to tell someone typing into a database that evaporates on reload. With sync
configured the server still has everything, so the cost is a re-bootstrap next load, not data.

The probe settled a fact worth keeping: Playwright's WebKit cannot open OPFS from a worker at all
(`navigator.storage.getDirectory()` itself rejects), so it is not a stand-in for the Mac app's
WKWebView on storage — `wkwebview-opfs.swift` shows the real thing writes 1.2 GB happily.

### B-52 · A date-shaped typo became a page
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, code review · **Test:**
`packages/server/src/ops/ops.http.test.ts`, "rejects a date-shaped ref that is not a real day"

`page_append({page: "2026-13-45"})` passed the wire-date regex, turned into journal day `20261345`,
and — because the reducer refuses to derive a name from an impossible day — created an ordinary
page called `2026-13-45`. No date format ever resolves to it, so it sat there as a shadow journal.
`journalDayFromWire` now returns `null` for an impossible day and `resolvePageRef` answers
`invalid` for anything date-shaped that is not a date.

### B-40 · Five CSS variables were used in eight stylesheets and defined nowhere
**Status:** fixed · **Severity:** high · **Found:** 2026-09-11, during the design pass · **Test:**
the design tokens now live in one file; `e2e/tests/settings.spec.ts` asserts the theme toggle

`--surface-1`, `--surface-2`, `--border`, `--danger` and `--ok` were referenced by the command
palette, the keyboard-shortcuts dialog, the context menu, the diagnostics panel and the mobile
drawers — and declared by nothing. Every one of those fell through to its hardcoded fallback, which
was some flavour of `#fff`.

In dark mode that means the shortcuts dialog and the command palette rendered as **white sheets
carrying near-white text**: not unpolished, unreadable. Before/after in the design pass's
screenshots (`00-before/d-dark-help-keys.png` vs `06-final/`).

This is what an undeclared custom property costs: CSS has no error for it, the fallback silently
wins, and the failure only appears in the theme you were not looking at. `styles/shell.css` is now
the single place a raw colour may appear, and it supplies all five for both themes.

Two smaller ones fixed alongside: `.task-filters label { flex-direction: column }` out-specified
`.task-state-checkbox`, stacking every task-state checkbox above its own word; and priority chips
were white on `#f5a623` at roughly 1.9:1.

### B-41 · The journal stream reserved 40vh of blank space after every day
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, during the design pass

`.vr-outliner` carried `padding-bottom: 40vh` — correct for a page view, where it keeps the last
block reachable above the fold. But the journal stream renders one outliner *per day*, so the
padding repeated down the whole stream. It was a good part of why the app read as "a page full of
holes". Moved to `.page-scroll-inner`, where the intent actually lives.

### B-12 · Two CSS naming schemes in the editor
**Status:** fixed · **Severity:** low · **Found:** 2026-09-11 · **Tests:** `a-fresh-journal`,
`connectivity`, `editing`, `remote-device` specs updated to the surviving selectors

`BlockRowView` used `.vr-row` / `.vr-content`; `VirtualJournalDay` used `.block-row` /
`.block-content-input` for the same concepts, so the placeholder row and a live row were two things
kept looking alike by hand.

Resolved by making the virtual journal day emit **real outliner markup** rather than a lookalike:
`.vr-draft` shares one declaration block with `.vr-outliner`, so they cannot drift. Eight dead rules
for markup nothing renders were deleted. `.vr-draft` is deliberately not named `.vr-outliner` —
several specs use that class with `.first()` to mean "a materialised tree", and a virtual day
answering to it would break them silently.

### B-13 · UI was visually unfinished
**Status:** fixed · **Severity:** medium · **Reported:** 2026-09-11 ("looks absolutely barebones…
like first project in life design")

`styles/shell.css` is now a design system: an 8-step type scale, a spacing scale, radii, elevation,
motion with a `prefers-reduced-motion` block, and a full two-theme palette whose contrast was
computed rather than guessed (light `--muted` 5.34:1, `--accent` 6.23:1; dark 6.14:1 and 8.06:1).
One focus recipe, audited by tabbing four routes.

The outliner specifically: bullets now align at a given depth (the collapse arrow was rendered
*in flow*, so a row with children pushed its own bullet ~14px right of a childless sibling — its
lane is now always reserved); indent guides are painted per ancestor; task markers are fixed-width
so text after `☐ ◐ ◔ ☑ ☒` starts at one x; and CodeMirror, which ships only a light theme, no
longer draws a black caret on a black page.

Known and left alone, in the design pass's own words: the top bar has nothing to say in its middle,
collapsed rows shift ~13px right because the child count sits in flow, the tasks filter bar wraps
arbitrarily, and the mobile drawers have no scrim. Each needs markup, not CSS.

### B-39 · `nooklet backup` rewrote the graph it was asked to preserve
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, by running it on a real graph

ADR 018's journal-name migration was hooked into `cli.ts`'s shared `open()` on the reasoning that
it is idempotent and cheap, so it may as well be everywhere. Every command goes through `open()` —
including `backup`, `verify`, `gc` and `export`, which are the commands you reach for when you
want to inspect or preserve a graph, not change it.

Two consequences, both bad. Taking a backup *before* a migration produced a backup taken *after*
it, which is the opposite of the thing being asked for. And `verify` — a diagnostic whose entire
job is to report on a database's state — would have reported on a database it had just modified.

`open()` now takes `{ migrate: true }`, passed only by `serve`, `import` and `mcp`.

**Lesson:** "idempotent and cheap" is an argument about cost, not about permission. A command that
does not say it writes must not write.

### B-32 · `graph.spec.ts` wrote into today's journal
**Status:** fixed · **Severity:** low · **Found:** 2026-09-11

The graph spec appended to **today's** journal, which is exactly the shared state
`a-fresh-journal.spec.ts` needs untouched — that spec is named to sort first for this reason, and
only worked because it happened to run earlier. Reordering or sharding the suite would have broken
the journal test with a failure that read as an editor bug rather than a fixture collision.

It now writes to a dated day in the past, with a comment saying why.

### B-37 · The Settings command navigated to a route that does not exist
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11 by a subagent building the panel

`app.openSettings` called `navigate("/settings")`. There is no such route, so the command — bound
to a key and listed in the palette — landed on a blank page. It now raises the settings panel.

Test: `e2e/tests/settings.spec.ts`.

### B-38 · Embeddings could not be configured without dropping to the CLI
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11 by a subagent

Semantic search needed `nooklet embed model …` from a terminal: there was no HTTP op to see
whether a provider was reachable, pick a model, or start a backfill, and nothing in the UI to do it
with. Someone who installed the app and wanted the feature it advertises had no path to it.

Now `embeddings.status` / `configure` / `reindex` exist (HTTP-only, deliberately not MCP tools:
they are operator decisions with real cost), the provider is probed *before* anything is persisted
so a bad host is never stored, and the indexer activates a model once its backfill drains — which
is the part a request handler cannot do synchronously and the reason an HTTP-configured model
would otherwise sit inactive forever.

Tests: `packages/server/src/ops/ops.http.test.ts` (against a stub Ollama, so results do not depend
on the machine), `e2e/tests/settings.spec.ts`. Also verified end to end against a real Ollama with
`bge-m3`: an English query returned a Czech note as its top hit.

### B-21 · Journal pages were stored under a display format
**Status:** fixed · **Severity:** medium · **Raised:** 2026-09-11 (user: "stored name should IMHO
be ISO. and then we should have in settings selectable format of that") · ADR 018

A journal page was *stored* under whatever title format the graph was written with —
`Mon, 07.09.2026` in the imported Logseq graph — while search results, block references and the
API all handed out the ISO date. The format a date is displayed in had become part of its
identity, and that one mistake produced B-22, B-23, and a quieter third: `ref.dst_page_key` is the
reference text, so `[[Mon, 07.09.2026]]`, `[[Sep 7th, 2026]]` and `[[2026-09-07]]` were three
different keys and a journal's backlinks were whichever subset happened to match its stored name.

Now: a page with a journal day is stored as `2026-09-07` (derived in `@nooklet/core`'s reducer, so
client, server and replay all agree); every recognised date format canonicalises to one reference
key; and the displayed title is a per-device setting (Settings → Appearance → Journal date format).

Existing graphs are migrated by `packages/server/src/journal-names.ts`, which mints real
`page.rename` ops — a raw UPDATE would desync live state from the op log and no other device would
ever hear about it. Run against the real 952-page graph: 825 pages renamed, `nooklet verify` clean,
and unresolved references *dropped* (path_ref 7403 → 5889, ref 1444 → 1357) because dates written
in a different format now resolve.

Tests: `packages/core/src/journal.test.ts`, `packages/core/src/sync/apply-ops.test.ts`,
`packages/server/src/journal-names.test.ts`, `e2e/tests/journals.spec.ts`.

### B-23 · `page.create` accepted a journal-formatted name and made a non-journal page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, while writing journal e2e tests ·
commit `dab7dc7`

`page.create` deliberately refuses journal days — but its guard used `journalDayFromWire`, which
only understands ISO and `today`/`yesterday`, not the title formats `parseJournalTitle` accepts. So
`page.create({name: "Tue, 08.09.2026"})` succeeded and produced a page with `journal_day = NULL`:
named like a journal day, looking like one, and invisible to the journal stream forever.

The guard now uses `parseJournalTitle` — the parser the rest of the system resolves references
with — and the error names the ISO date to use with `page_append` instead.

Test: `packages/server/src/ops/ops.http.test.ts`, `describe("page.create journal guard")`.

### B-35 · `page.append` could not create an ordinary page, and shadowed journals
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, by an e2e test that tried to use it

Two faults in one function. `page_append`'s `create_page` flag defaults to true and is documented
as creating the page — but `resolvePageRef` only ever honoured it on the journal branch, so
appending to a page that did not exist yet failed with *"does not exist and create_page is false"*
having been passed exactly the opposite. An agent reading that message would conclude the flag was
the problem and never find the real one.

And the fallthrough was B-23's hole through a different door: `page_append({page: "Sep 8th, 2026"})`
would have created an ordinary page shadowing that journal day.

`resolvePageRef` now resolves in a documented order — wire date, id, existing name, *then* any
other journal title format, and only then creates an ordinary page. The name-before-date step is
what keeps an imported page genuinely called `11.12.2024` reachable by its name.

Test: `packages/server/src/ops/ops.http.test.ts`, `describe("page.append page resolution")`.

### B-36 · Moving the e2e port left the browser pointing at the old one
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, immediately after B-34's guard fired

B-34 taught the suite to refuse a port that is already serving nooklet, and to say
`NOOKLET_E2E_PORT`. Doing what it said moved the *server* but not the *browser*: `baseURL` came
from a separate `NOOKLET_E2E_URL` and stayed at 6188 — the very server the guard had just objected
to. The suite then tested a concurrent agent's build and reported a failure in code that was
correct, which is the exact outcome B-34 existed to prevent.

`baseURL` is now derived from `NOOKLET_E2E_PORT`. One knob.

**Lesson:** a guard that tells you which knob to turn has to be sure that knob turns everything.

### B-33 · `.gitignore` silently excluded seven source files from the repository
**Status:** fixed · **Severity:** critical · **Found:** 2026-09-11 by a subagent

`.gitignore` line 12 was a bare `data/`, which matches **any** directory named `data` at any
depth — so `apps/web/src/data/` was never committed. The published repository was missing
`store.ts`, `api-client.ts`, `bootstrap.ts`, `types.ts`, `tree.ts`, `block-ref-cache.ts` and
`tree.test.ts`, and could not build.

Nothing local would ever have caught it: the files exist on disk, `git status` is clean, every
test passes. It surfaced only because a subagent noticed its own edits to `store.ts` were
invisible to `git status` and said so rather than assuming it had misread.

Now `/data/`, anchored to the root, which is what it always meant. Verified by cloning the repo
into a temp directory and running `typecheck` + `build` there — the check that would have caught
this at any point.

**Lesson:** a repo that builds locally proves nothing about what was committed. Clone it.

### B-34 · The e2e suite could silently run against someone else's server
**Status:** fixed · **Found:** 2026-09-11, chasing a test that failed only in the full suite

`global-setup.ts` spawned a server on a fixed port and then waited for `/healthz`. When something
was already listening — a concurrent agent's Playwright run — the spawn failed to bind but the
health check succeeded against the OTHER process, so the whole suite ran against a foreign server
carrying foreign data.

It presented as a real product bug: one spec failed on state it never created, and kept failing
when run in isolation. Several rounds went into looking for a regression in the editor that did
not exist.

The setup now refuses to start when the port is already serving nooklet, and says what to do
(`NOOKLET_E2E_PORT`). Logged alongside B-32, which was the same class of problem one level up —
tests sharing state they did not declare.

### B-30 · A client silently held a copy of a different graph
**Status:** fixed · **Found:** 2026-09-11, chasing "search finds nothing but the sidebar is full"

The sidebar listed a thousand pages while search returned zero results. Both were telling the
truth about different graphs: the client's replica lives in OPFS keyed by **origin**, so pointing
`127.0.0.1:6100` at another data directory leaves the browser reusing the copy it already had.
The page list reads the local replica; search and backlinks read the server. Every individual
part worked.

Each database now mints a stable identity (`packages/server/src/graph-identity.ts`), exposed via
`GET /api/session`. The client remembers which graph its replica belongs to and, on a change,
stops and explains instead of rendering two disagreeing halves (`views/GraphMismatchView.tsx`).

**It asks rather than wiping.** The local replica can hold edits that were never pushed, and
destroying those silently to fix a configuration mistake would be the worst possible trade.

Two contributing causes worth recording: the README's quick start said `--data ~/.nooklet` while
the CLI defaults to `~/.nooklet/default`, so following it produced a second graph; and the desktop
app used the platform app-data directory, so it opened a third. Both now use one default.

### B-31 · A wall-clock assertion in the unit suite
**Status:** fixed · **Found:** 2026-09-11 by a subagent, which correctly refused to blame its own change

`packages/core/src/tokens.test.ts` asserted `tokenizeContent` over 20,000 blocks finished in under
50 ms. It measured 60-71 ms when run alongside the rest of the suite and passed every time in
isolation — the test was measuring the machine's load, not the code.

A test that fails when the laptop is busy teaches nobody anything and trains people to re-run
until green. The budget is now 500 ms: an order of magnitude above the real ~30 ms, which still
catches the regression actually worth catching (an accidental quadratic turning this into
seconds) and never fires on load.

### B-29 · A self-executing module hijacked the CLI once bundled
**Status:** fixed · **Found:** 2026-09-11, building the desktop app's bundled server

The desktop app's server died on `unable to open database file` for a directory that plainly
existed. The path it tried to open was the data **directory**, not `graph.sqlite` inside it.

`mcp/stdio.ts` ended with a standalone entry point:

```js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```

Bundled by esbuild into a single file alongside `cli.ts`, that guard compares *the bundle's* path
— so it is true for whichever entry point is actually running, and the stdio bridge's `main()`
ran instead of the CLI's. The two read `--data` differently on purpose: the CLI takes a data
directory, the bridge takes the database file. Hence the error.

`main()` and its `parseArgs` now live in `mcp/stdio-main.ts`; `mcp/stdio.ts` is a pure library.

**The red herring worth remembering:** a byte-identical copy of the bundle ran fine from `/tmp`
and failed from the repo. That is not filesystem magic — `/tmp` is a symlink to `/private/tmp`,
so `import.meta.url` (symlinks resolved) and `process.argv[1]` (as given) did not match, and the
guard stayed false. Chasing "the location matters" nearly sent this in the wrong direction; what
settled it was printing the path that was actually being opened.

**Rule:** a module that can be imported must not self-execute. Bundling makes every entry point
look like *the* entry point.

### B-28 · The entire command layer was wired to a no-op editor
**Status:** fixed · **Test:** `e2e/tests/parity.spec.ts` (6 tests)
**Found:** 2026-09-11, by finally exercising B-17/B-18 in a browser

The slash menu, `[[`/`#`/`((` autocomplete and every formatting shortcut did nothing. All were
implemented and unit-tested against a fake host; none had ever run in a browser. Three bugs,
stacked:

1. **`CommandLayer` captured the host once.** `const editor = activeEditorHost()` evaluates at
   setup, when no `BlockTree` has focus — so it captured the inert no-op host and kept it forever.
   `activeEditorHost()` returns a *snapshot*; anything built once at startup needs the new
   `liveEditorHost`, which forwards each call to whoever is active now.
2. **The host was never registered anyway.** `BlockTree`'s registration effect was
   `createEffect(() => { if (surface.currentId() !== null) … })` — and `surface.currentId()` reads
   a plain closure variable inside `surface.ts`, not a signal. The effect ran once, at mount, with
   nothing focused, and never re-ran. Now keyed on `editingId()`, which is a real signal.
   Measured before the fix: `getSelection()` returned `null` on every keystroke, so no trigger
   could ever match.
3. **Commands wrote to the model but not the editor.** With the above fixed, `Cmd+B` resolved and
   *ran* (`handled: true`) yet the text never changed: `EditorHost.setText` called `onTextChange`,
   updating `localBlocks` while CodeMirror kept the old buffer — and the next refetch, which
   prefers the live buffer for the block being edited, then discarded the change entirely. It now
   dispatches a real CodeMirror transaction and lets the surface's update listener do the rest.

**Lesson:** a unit test against a fake host proves the command's logic and nothing about whether
the host is connected. Every one of these had passing unit tests.

### B-25 · Any LAN caller could mint a write token by forging `Host: localhost`
**Status:** fixed · **Severity:** critical · **Test:** `packages/server/src/http/host-guard.test.ts`
**Found:** 2026-09-11 by the multi-user/pairing research agent, reproduced before fixing

`buildClientBootstrap` decided "is this loopback?" from the `Host` header, which the caller
controls. Verified against a running server bound to `0.0.0.0`:

```
curl -H 'Host: localhost:6198' http://192.168.1.6:6198/api/session
→ {"token":"nk_<redacted>"}
```

That is a `write` + `can_sync` token handed to anyone who can reach the port. Introduced in this
session along with the bootstrap endpoint.

Now decided from the socket's peer address (`getConnInfo`), with the `Host` check RETAINED as a
second condition rather than replaced — a DNS-rebinding attack arrives from a genuine loopback
peer (the victim's own browser) carrying the attacker's hostname, so both must hold. An
in-process request with no socket is treated as non-loopback: never hand out a credential to a
caller you cannot identify.

### B-26 · The DNS-rebinding guard covered 2 routes out of 7
**Status:** fixed · **Test:** `packages/server/src/http/host-guard.test.ts`, "guards EVERY route"
**Found:** 2026-09-11, same research pass

`@modelcontextprotocol/hono` ships a Host guard, but `createApp` merges that sub-app *after*
`/api/v1/*`, `/sync/*`, `/api/session` and `/assets/*` are registered — and Hono composes handlers
in registration order, so a terminal handler registered earlier short-circuits before the merged
middleware runs. The guard only ever covered paths with no earlier route. Meanwhile `cli.ts`
printed that requests with an unexpected `Host` "are refused". They were not.

nooklet now installs its own allowlist middleware *before* every route, active only when bound to
a non-loopback address. Verified per-route: with `--host 0.0.0.0` and no `--allow-host`, all of
`/healthz`, `/openapi.json`, `/api/session` and `/` return 403 to a LAN Host and 200 to loopback;
adding `--allow-host` opens exactly that hostname. The CLI message now says what actually happens.

**Testing note:** these cannot be tested through `app.request()` — both behaviours depend on the
connection itself. And `fetch` silently drops a `Host` header (it is a forbidden header name), so
the tests use raw `node:http`; written with `fetch` they would have asserted nothing while passing.

### B-27 · A plain LAN IP cannot run the client at all
**Status:** documented · **Severity:** high · **Found:** 2026-09-11, same research pass

`http://192.168.1.5:6100` — the URL the README previously recommended for phone access — is not a
*secure context*. The client stores its replica via OPFS (`installOpfsSAHPoolVfs`) and elects a
writer with `navigator.locks`; both are secure-context-gated and neither has a fallback, so the
client cannot open its database there at all. README now recommends HTTPS or a tailnet and
explains why.

Not a code fix: the real remedy is a documented deployment shape. Revisit if a plain-LAN fallback
is ever wanted, which would mean a non-OPFS storage path.

### B-22 · Clicking a search result said "This page doesn't exist yet"
**Status:** fixed · **Test:** `e2e/tests/journals.spec.ts` (3 tests)
**Reported:** 2026-09-11

Three separate defects on one path.

1. **Journal pages were only addressable by their stored name.** The graph stores
   `Mon, 07.09.2026`; search results and references hand out `2026-09-11`. `usePageByName` looked
   up by name only, so a journal that plainly existed reported "doesn't exist yet". It now falls
   back to `parseJournalTitle` → `journal_day`, which is format-agnostic. See B-21 for the
   underlying design fix.
2. **Zooming into a block threw and left the view permanently blank.** `flattenVisible` called
   `getBlock`, which throws on an unknown id — and on the first render the tree is empty because
   the page resource has not resolved, so a `?block=` URL took down the whole subtree behind a
   "Loading…" that never cleared. A missing zoom root now yields no rows instead of throwing.
3. **"Loading…" never cleared even once data arrived.** `createResource` sets `loading = true` on
   every REFETCH, and after the version-stamping fix (B-05) every resource refetches whenever its
   tables change — so a spinner keyed on `loading` alone reappeared on every sync pull. Views now
   show a spinner only while there is nothing to display (`loading && value === undefined`).
   Fixed in `PageView`, `TasksView`, `ReferencesPanel` and `SearchView`.

### B-24 · Future journal days were invisible
**Status:** fixed · **Test:** `e2e/tests/journals.spec.ts`, "a future journal day appears in the stream"
**Reported:** 2026-09-11 ("shows just today page even though /page/Sep 12th, 2026 exists")

The stream query was `journal_day < today`, so a day ahead of today never appeared. Empty past
days are hidden deliberately; a *future* day exists only because something was written or
scheduled there, so hiding it turned into "days you created are not shown". Future days now render
above today (keeping the stream newest-first) and are not counted against the `maxDays` window,
which exists to bound scrolling back through years of history.

### B-20 · The app never updated — a browser stayed pinned to the first build it cached
**Status:** fixed · **Reported:** 2026-09-11 as search still hanging and "agents can't see this
window" persisting after both had been fixed and verified

`vite.config.ts` used `registerType: "prompt"`, which only applies an update when something calls
the update function — and `sw/register.ts`'s `onNeedRefresh` did nothing but `console.info`. So a
browser kept serving the first build it had ever precached, forever. Every fix shipped after that
first visit was invisible, and the symptoms looked like unfixed bugs.

Proven by driving a *fresh* browser (no service worker) at the same server and the user's real
graph: `/api/session` 200, `/api/v1/search` 200, 48 results, zero console errors, live UI
connected. The code was correct; the cache was not.

Now `registerType: "autoUpdate"`, `onNeedRefresh` actually applies the update, and a long-lived
tab re-checks hourly (a service worker otherwise only looks for a new version on navigation).
Safe for unsaved text because a pending edit already flushes on `pagehide`/`visibilitychange`
(B-04).

**To unstick a browser that is still on an old build:** hard-reload twice, or DevTools →
Application → Service Workers → Unregister, then reload.

**Lesson:** when a verified fix "doesn't work" for the user but passes in CI, suspect the
delivery path before the code. `pnpm e2e` rebuilds and uses a fresh browser context every run, so
it could never have caught this.

### B-19 · The service worker served a shell with no token, so reloads lost credentials
**Status:** fixed · **Test:** `e2e/tests/remote-device.spec.ts`, plus every reload-based editing test
**Found:** 2026-09-11, while adding the connect screen

The web-client token was injected into `index.html`. The PWA service worker precaches that file
**at build time**, so from the second page load onward the browser was handed a shell containing
no `window.__NOOKLET__` at all — the app silently lost its credentials on every reload, on
loopback, where everything was supposed to just work. It had been happening since the token
injection landed; it only became visible once a missing token started rendering a connect screen
instead of failing quietly.

A shell is static and cacheable; a credential is neither. The token now comes from
`GET /api/session` at startup (`data/bootstrap.ts#initBootstrap`), which the service worker's
runtime caching already treats as `NetworkOnly`.

**Lesson worth keeping:** two of the reload-based editing tests started failing the moment the
connect screen existed. They were not regressions — they were the first time this bug had anything
to fail against.

### B-15 · Keystrokes lost right after clicking a block or pressing Enter
**Status:** fixed · **Test:** `e2e/tests/editing.spec.ts`, "typing immediately after Enter"
**Reported:** 2026-09-11 as "I type, press enter, the new text disappears", "can't click on a new
bullet point to put cursor in there", and "tab + shift tab doesn't work"

All three were one defect. Solid runs a `ref` callback when the element is *created*, not when it
is inserted into the document, so `surface.attach`'s `view.focus()` ran against a still-detached
host and did nothing. Focus sat on `<body>` until a `requestAnimationFrame` backstop restored it a
frame later, and everything typed in that window went to `<body>` and was discarded. Measured:
immediately after Enter, `document.activeElement` was `BODY` and the focus trace read
`out->BODY`, `in:cm-content`.

It read as "Tab doesn't work" for the same reason — with focus on `<body>`, CodeMirror's keymap
never saw the key, so *no* structural key worked, including Backspace.

Fixed by re-asserting focus in a `queueMicrotask` (runs after Solid inserts the element but before
the browser dispatches the next input event), keeping the rAF as a backstop for the separate case
where the browser resets focus after removing the previously focused element.

### B-16 · An edit typed into a just-created block was discarded
**Status:** fixed · **Test:** `e2e/tests/editing.spec.ts`, "typing immediately after Enter"

`flushPendingEdit` looked the block up in `treeBefore` — the tree as of the edit's first keystroke
— and returned early when absent (`if (!before || before.content === content) return`). A block
created moments earlier (Enter for a new sibling, pasting a subtree) is not in that snapshot, so
the text op was never built and the typing was lost with no error. Absent from the snapshot is not
"unchanged": it now falls back to the live tree and only skips when content genuinely has not
moved.

---

The six below were reported within minutes of first opening a served production build, and all six
had passed the 1,180-test unit suite. That is what `e2e/` now exists to prevent — see its
`playwright.config.ts` header.

### B-01 · Served client had no API credentials
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/connectivity.spec.ts`

Search 401'd, linked references hung, `/ui/live` reported "agents can't see this window", and the
sync indicator flapped offline→syncing→offline every few seconds. One cause: the token came from
`VITE_NOOKLET_TOKEN`, a dev-only stand-in that is undefined in a production build. The server now
injects a per-process token as `window.__NOOKLET__`, for loopback callers only.

### B-02 · Editing stopped after exactly one character
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "types a whole sentence"

`<For each={rows()}>` keyed on objects rebuilt by `flattenVisible` on every refetch, so each
keystroke recreated every row's DOM and tore out the element the single CodeMirror surface is
re-parented into. Now keyed by block id.

### B-03 · Clicking a block entered edit mode without focus
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/rendering.spec.ts`, "clicking a seeded row"

The clicked `.vr-block-view` is swapped out of the DOM inside the click handler, so the browser
reset focus to `<body>` after the handler returned, undoing `view.focus()`. Re-asserted on the next
frame. Deliberately *not* moved to `mousedown`, which fires before link clicks and would break
`[[page]]` navigation.

### B-04 · Typed text vanished on blur, reappeared on reload
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "text survives blurring"

Two causes. See B-05 for why the UI didn't update; separately, a typed edit could be lost for real:
writes are debounced ~500 ms and nothing flushed on blur or unload, so clicking away and reloading
inside that window discarded it. Now flushed on `focusout` past the tree, `pagehide`, and
`visibilitychange`.

### B-05 · Nothing refetched after a write
**Status:** fixed · `d6163df` · **Test:** covered by B-04's test and "a page seeded through the API"

Global. Every resource source called `trackTable`/`trackPage` and then returned a stable scalar (an
id, a name, or literally `true`); `createResource` refetches only when the source *value* changes,
so Solid never re-ran the fetcher. Local edits reached SQLite and the UI kept rendering the
previous result until a reload. Sources now return a version-stamped object.

### B-06 · Enter dropped the next two keystrokes
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "Enter creates a second bullet"

Surfaced by fixing B-05: a refetch landing before the write committed overwrote the optimistic row
and unmounted the new block's editor, so `second bullet` arrived as `cond bullet`. The block being
edited is now preserved when absent from a query result.

---

### B-07 · Cmd+A in a block doesn't select its text
**Status:** fixed (by B-15's focus fix; covered by `e2e/tests/parity.spec.ts`) · **Status was:** open · **Severity:** high · **Found:** 2026-09-11, while writing e2e tests

Pressing Cmd+A (Ctrl+A) while editing a block does not select that block's text. It detaches the
editor and swallows the following keystroke — typing `persisted` after it produced
`seedersisted`, i.e. the `p` vanished and the caret jumped to the end.

Expected: select the block's text first, and only escalate to selecting sibling blocks on a second
press (`docs/spec/commands-and-keymap.md`). No keystroke should ever be dropped.

It turned out to be the same detached-editor fault as B-15: the keymap ran against an editor the
DOM no longer owned. `e2e/tests/parity.spec.ts` now presses Cmd+A in a real browser and asserts the
block's text is selected and the next keystroke replaces it.

### B-08 · References panel always present, no counts, not collapsible
**Status:** fixed · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** medium · **Reported:** 2026-09-11

Linked and unlinked references render as sections even when there are none, show no count, and
cannot be collapsed. Should show `Linked references (3)`, collapse/expand, and disappear entirely
when empty.

`apps/web/src/views/ReferencesPanel.tsx`.

### B-09 · References don't refresh after a local edit
**Status:** fixed · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** medium · **Found:** 2026-09-11, reading the code for B-08

`useLinkedReferences` and `useSearchResults` are server-backed and deliberately not wired to the
local change bus (`apps/web/src/data/store.ts`), exposing a manual `refetch` instead — but nothing
calls it. So adding a `[[link]]` does not update the panel until navigation.

Related to B-05's root cause but a separate path: those two resources bypass the version stamping.

### B-10 · A failed request renders as a permanent spinner
**Status:** fixed (search + references) · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** high · **Reported:** 2026-09-11 (as "searching for aa just stops at Searching…")

`SearchView` has a loading branch and a results branch but no error branch, so a rejected fetch
leaves "Searching…" on screen forever. The underlying 401 was B-01, but the *invisibility* is its
own bug and will hide the next failure too.

Every view that can fail needs an error state. Same applies to the references panel's "Loading…".

### B-11 · No diagnostics surface
**Status:** fixed · **Test:** `e2e/tests/diagnostics.spec.ts` · **Status was:** open · **Severity:** medium · **Requested:** 2026-09-11

Nothing in the UI says whether the client reached the API, whether it has a token (and if not,
why), how big the search index is, or whether embedding indexing is running. B-01 was invisible for
exactly this reason. `data/bootstrap.ts` already carries a `reason` field for this.

Wanted: a settings/dev panel with connection state, backend reachability, index size, indexing
progress.

### B-14 · No context menu on a bullet
**Status:** fixed · **Test:** `e2e/tests/parity.spec.ts` (3 tests) · **Status was:** open · **Severity:** medium · **Requested:** 2026-09-11

Right-clicking a bullet should open an app-specific menu rather than the browser's default:
zoom in, indent/outdent, toggle task, copy block ref, delete — and **formatting** (bold, italic,
highlight) when there is a selection. The commands already exist
(`commands/registrations/format.ts`, `structural.ts`); this is the missing surface for them.

### B-17 · Slash menu never verified in a browser
**Status:** FIXED — see B-28 below · **Status was:** needs-repro · **Severity:** medium · **Raised:** 2026-09-11

`SlashMenu`, `matchSlashTrigger` and the insert commands are implemented and unit-tested, and
`CommandLayer` wires them up — but nothing has ever exercised typing `/` in a real browser. Given
that every keyboard path checked so far had a defect (B-02, B-07, B-15), assume it is broken until
an e2e test says otherwise. Same for the `[[`, `#` and `((` autocomplete popups.

### B-18 · Formatting shortcuts never verified in a browser
**Status:** FIXED — see B-28 below · **Status was:** needs-repro · **Severity:** medium · **Raised:** 2026-09-11

`format.bold` / `format.italic` / `format.highlight` are registered with Cmd+B/I and unit-tested
against a fake editor host, but have never been pressed in a real browser. These route through the
same global capture-phase dispatcher and `EditorHost` delegation that B-07 shows is fragile.

## Notes for whoever picks this up

- `pnpm e2e` builds the client, boots a real server on a temp data dir, and drives Chromium. It is
  the only suite that would have caught B-01 through B-06.
- When a bug is "it doesn't update", check `data/store.ts` first — B-05's pattern was replicated
  across eight resources and is easy to reintroduce.
- Bugs found while fixing other bugs (B-06, B-09, B-12, B-16) are worth recording even when small;
  several entries above exist only because something else was being read carefully.
- **Assertions can hide bugs.** `expect(outliner).toContainText("first bullet")` and
  `toContainText("second bullet")` both passed while Enter was doing nothing at all, because both
  strings were sitting in one block. Assert structure (`toHaveCount`) alongside content.
- When a keyboard interaction "does nothing", check `document.activeElement` first. Three separate
  reports (B-15) were one focus bug, and the giveaway was that Backspace did not work either.
