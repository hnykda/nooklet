# Bugs inbox — impl-commands (m8)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. Existing bugs are marked
"(existing)"; new ones use B-160..B-169.

---

### B-97 (existing) · "Collapse all" and "Expand all" do nothing
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit · **Tests:**
`e2e/tests/commands.spec.ts` "Collapse all and Expand all fold the whole page with nothing focused,
and it persists (B-97)", "zoomed into a block, Collapse all and Expand all act on that subtree only
(B-97)", "Collapse all while editing a block it hides ends editing, and the page stays editable
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

---

### B-98 (existing) · "Open plugin manager" leads to a blank page
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit · **Test:**
`e2e/tests/commands.spec.ts` "Open plugin manager opens Settings at the list of running plugins,
not a blank page (B-98)"

**Fixed 2026-09-13.** Not a manager — there is nothing to manage from the client: the server
exposes `GET /api/v1/plugins` (active plugins only) and no op to enable, disable or reload one
(`nooklet plugin …` is the only switch). So Settings gained a read-only Plugins section
(`views/PluginsSection.tsx`, data in `data/plugins.ts`) listing name, id, version and which halves
each plugin has, with a note naming the CLI commands and saying disabled plugins are not shown.
`app.openPluginManager` now opens Settings scrolled to that section (`AppDeps.openPluginManager`,
wired in `CommandLayer.tsx`) and no longer navigates anywhere. The test compares the section's rows
with what the server's endpoint returns (the e2e server loads the repo's `plugins/`); against the
old code it fails on the URL changing to `/settings/plugins`. Spec R52 updated.

---

### B-105 (existing) · Argument-only commands show as palette rows that do nothing
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

### B-106 (existing) · Comment and spec drift around commands
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

### B-161 · e2e "opening the palette while editing and closing it hands focus back to the editor" fails
**Status:** needs-repro · **Severity:** low · **Found:** 2026-09-13, impl-commands e2e sweep ·
**Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands focus
back to the editor"

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
