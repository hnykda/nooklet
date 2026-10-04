# Exposure audit, 2026-09-12

Three questions from the owner: are the features nooklet already has actually reachable by a
person; which of the things Logseq users ask for could ship in under a day each given what exists;
and is publishing a graph as a static wiki cheaply possible.

Method: the inventory is built from the code, not the docs — every `defineOp` in
`packages/server/src/ops/` and `live/`, every command in `apps/web/src/commands/registrations/`,
the slash items, context menu, palette modes, settings panel, shell, routes and help menu — and
then checked by hand against a production build served by a real `nooklet serve` on a fresh graph
(port 6361, `--no-mirror`, driven by a Playwright script; details in §1.9). Snapshot: the files
were read at `a4d137f` (~17:20) plus the M7 agents' uncommitted work; the client was built at
17:31; by the time the runtime pass finished (~17:50) HEAD had moved to `1add7e9` and the served
`dist` had been rebuilt by another agent's e2e run. Where a file changed under the audit it is
said so; the last section lists what landed meanwhile.

Five M7 streams are in flight in this tree (query fence, templates, refactors + find/replace,
reference filters/appearance/shelf outline, trash/history). Their ops are registered
(`packages/server/src/ops/index.ts` lists `trash.list`, `trash.restore`, `page.history`,
`block.to_page`, `block.move_to_page`, `page.merge`, `graph.replace`) but, at snapshot time, their
client files (`apps/web/src/commands/registrations/templates.ts`, `data/queries.ts`,
`data/templates.ts`, `editor/render/highlight.ts`, `math.ts`) are untracked and mostly not yet
imported by anything (`grep -rn 'registrations/templates\|data/queries\|render/highlight'
apps/web/src` finds no importer; `data/appearance.ts` is imported by `SettingsPanel.tsx`). They are
listed below as "M7 in flight" and not counted as gaps.

---

## 1. What exists vs what a person can reach

### 1.1 Server ops (38 registered in `packages/server/src/ops/index.ts`)

Columns: exposure flags from each `defineOp` (`http` is always the canonical `POST /api/v1/<name>`
plus `GET` for read-only ops; a REST alias is noted); MCP hint flags; and where — if anywhere — the
web client calls it. "Local ops" means the client does not call the HTTP op at all: it mints the
same `Op` into its SQLite replica and syncs (`data/store.ts#applyOp`), which is by design.

| Op | Summary | Scope | HTTP alias | MCP | Client surface | Verdict |
|---|---|---|---|---|---|---|
| `graph.overview` | Orient: what is in this graph | read | — | alwaysLoad | none | API-only (agent orientation; fine) |
| `system.diagnostics` | Backend health | read | — | yes | `views/DiagnosticsPanel.tsx` — click the sync indicator in the top bar (`shell/AppShell.tsx:32`), or Settings → About → "Open diagnostics" | exposed (no palette command; `DiagnosticsPanel.tsx:11` mentions an `app.diagnostics` command that does not exist) |
| `embeddings.status` / `.configure` / `.reindex` | Semantic search config | read/write | — | **mcp: false** | `views/SettingsPanel.tsx` "Search & embeddings" | exposed |
| `page.list` | List pages (namespace, prefix, `tag`, kind) | read | `GET /pages` | yes | none — the client lists pages from its replica (`useAllPages`) | API-only; the `tag` filter (over `page_tag`, ADR 017) has no UI anywhere: nothing shows "pages tagged X" |
| `page.read` | Read a page | read | `GET /pages/{page}` | alwaysLoad, 200k | local replica | API-only by design |
| `block.read` | Read a block subtree | read | `GET /blocks/{id}` | yes | local replica | API-only by design |
| `search` | FTS/semantic/hybrid | read | — | alwaysLoad | `views/SearchView.tsx` (mode, tag, namespace, updated after/before) | exposed; `scope`, `properties` (e.g. `marker`), `pages`, `journals_only` have no UI |
| `related.find` | Nearest neighbours by meaning | read | — | yes | none | API-only. PLAN §9 says "Related … shown in the sidebar"; never built |
| `page.backlinks` | Linked/unlinked refs | read | `GET /pages/{page}/backlinks` | yes | `views/ReferencesPanel.tsx` | exposed |
| `mentions.link` | Link every plain mention | write | — | yes | ReferencesPanel "Link all" (M7 #10, landed) | exposed |
| `graph.links` | Page link graph | read | — | yes | `views/GraphView.tsx` | exposed |
| `changes.since` | What changed since a cursor | read | — | yes | none | API-only. PLAN §11's "UI badges (changed by agent X)" never built |
| `page.create` | Create a page | write | — | yes | local ops (palette "Create page", missing-page Create button, virtual journal day) | exposed via local ops |
| `page.append` | Append markdown to a page/journal | write | — | alwaysLoad | local ops (quick capture writes `page.create`/`block.create` locally) | API-only by design |
| `block.insert` / `block.update` / `block.move` / `block.delete` | Block edits | write | — | yes | local ops (editor) | API-only by design |
| `page.update` | Rename / set page props | write | — | yes | local ops (`page.rename` from the title input, `page.prop` from `views/PageProperties.tsx`) | exposed via local ops |
| `batch` | Atomic multi-op | write | — | yes | none | API-only by design |
| `page.delete` | Delete a page (undoable) | write | — | requiresUserInteraction | **none** — `grep -rn 'page.delete' apps/web/src` hits only the replica's reducer (`db/worker-core.ts:228`) | **API-only. A person cannot delete a page from the UI at all.** M7 trash stream may add it; not in the tree at snapshot |
| `batch.undo` | Undo a batch | write | — | yes | ReferencesPanel "Undo" after Link all | exposed for that one case; no general "undo last agent batch" surface |
| `asset.upload` | Upload a file | write | — | yes | **none** — no client code posts to it (`grep -rn 'asset.upload\|files.pick' apps/web/src` finds only comments) | API-only; the slash "Image" item exists but is dead (§1.2) |
| `trash.list` / `trash.restore` / `page.history` | Trash and history over the audit log | read/write | — | yes | none yet | M7 in flight (#8) |
| `block.to_page` / `block.move_to_page` / `page.merge` / `graph.replace` | Refactors, find & replace | write | — | yes (`page.merge` requiresUserInteraction; `graph.replace` maxResultSizeChars 60k) | none yet | M7 in flight (#3, #4) |
| `ui.windows` / `ui.state` / `ui.run` / `ui.navigate` / `ui.highlight` | Live UI control | `ui:control` | — | yes | consent toggle only (`live/ConsentBadge.tsx`) | agent-only by design (ADR 015) |

Server capabilities that are not ops:

| Capability | Where it lives | How a person reaches it | Verdict |
|---|---|---|---|
| Markdown mirror | `packages/server/src/mirror/export.ts` | `nooklet export` (CLI) only. **`nooklet serve` never writes it**: the only caller of `exportAll`/`exportPage` outside tests is `cli.ts:305` (the `export` subcommand); `config.mirror.enabled` (set from `--no-mirror`, `cli.ts:156`) is read by nothing. Runtime check in §1.9 | **CLI-only, and stale between runs.** README ("Your notes are also written out as plain markdown") and OPERATIONS §2 ("regenerated from the database") read as continuous; they are not |
| Backups / restore / gc / verify | `packages/server/src/backup/`, `gc.ts`, `verify.ts` | CLI only (`nooklet backup|restore|gc|verify`, OPERATIONS §3–6) | CLI-only; no "last backup" indicator, no settings row |
| Tokens | `auth/` | CLI only (`nooklet token create|list|revoke`) | CLI-only; README's "Connecting an agent" requires a terminal |
| Plugins (server half) | `plugins/` + `GET /api/v1/plugins` (`plugins/http.ts:37`) | CLI `nooklet plugin list|enable|disable|reload`; no UI | CLI-only; `app.openPluginManager` (palette) navigates to `/settings/plugins`, which is not a route (`App.tsx` route table) → **dead command** |
| Plugins (client half) | Server serves `GET /plugins/:id/:file` (`plugins/http.ts:15`); `plugins/word-count/src/client.ts` registers a status item, `plugins/mermaid/src/client.ts` a code-block renderer | **Nothing in `apps/web` loads them**: no fetch of `/api/v1/plugins` or `/plugins/<id>/client.*.js`, no `registerStatusItem`/`registerCodeBlockRenderer` host, no status-bar slot in `shell/` | **dead.** research/13 §4.1 marks Mermaid and Word count as "have"; neither is reachable |
| Page aliases (`page_alias`, B-55) | `packages/server/src/page-aliases.ts`; server resolves refs/backlinks through aliases | Palette page rows carry aliases (`app/hosts.ts:101` reads `page_prop.alias`, `commands/ranking/rank.ts` scores them); `views/pageSearch.ts` (the `PageFinder` switcher) does not; `usePageByName` resolves by key only, so `/page/<alias>` says "doesn't exist" (B-55 follow-up) | partially exposed — runtime check in §1.9 |
| Page-level tags (`page_tag`, ADR 017) | `packages/server/src/page-tags.ts`; `page.list tag:` uses it | No view lists pages by tag; `tags::` is an ordinary row in the page properties panel | API-only |
| Scheduled / deadline on a journal day | PLAN §8 promises a "Scheduled and deadline" section on each journal day | `views/JournalStreamView.tsx` has no such section; PLAN itself now says "not yet built" | missing (Part 2 candidate) |
| Block timestamps (`created_at`/`updated_at`) | in the model and the replica | not rendered anywhere (`editor/BlockRowView.tsx` shows marker, priority, ordinal, content) | invisible |

### 1.2 Client commands (82 registered via `commands/registrations/index.ts`)

Default keys are the mac column; `other` is the Ctrl equivalent unless noted. "Palette" means the
command is listed in `>` mode whenever its `when` clause holds; every command is, so the column
only says where else it is reachable.

**Block (31, `structural.ts`; all delegate to `editor/BlockTree.tsx#runCommand` / the selection
switch)**

| Command | Keys | `when` | Other surfaces | Verdict |
|---|---|---|---|---|
| `block.split`, `.newline`, `.indent`, `.outdent`, `.mergeWithPrevious`, `.deleteForwardMerge` | Enter, Shift+Enter, Tab, Shift+Tab, Backspace, Delete | editorFocused (+ caret conditions) | indent/outdent in context menu and mobile toolbar | exposed |
| `block.moveUp` / `.moveDown` | Alt+Up/Down | editorFocused ‖ blockSelected | context menu, toolbar | exposed |
| `block.focusPrevious/NextLine`, `.focusPrevious/NextChar` | arrows | editorFocused | — | exposed (keys) |
| `block.collapse` / `.expand` | Cmd+Up / Cmd+Down | hasChildren (+ collapsed state) | bullet click | exposed |
| `block.collapseAll` / `.expandAll` | none | `true` | palette only | **dead**: `BlockTree.tsx` has no `case` for either id (its `runCommand` switch ends in `default: return false`, lines 526–640; the selection switch likewise, 816–930). Runtime check §1.9 |
| `block.zoomIn` / `.zoomOut` | Cmd+. / Cmd+Shift+. | editorFocused ‖ blockSelected / zoomed | context menu "Zoom in"; bullet click | exposed |
| `block.selectBlock`, `.editSelected`, `.clearSelection`, `.extendSelectionUp/Down`, `.selectAll`, `.deleteSelected`, `.indentSelected`, `.outdentSelected` | Escape, Enter, Escape, Shift+Up/Down, Cmd+A, Backspace, Tab, Shift+Tab | blockSelected | context menu "Delete" | exposed (keys); selection mode itself is discoverable only via Escape or Cmd/Ctrl+click (`BlockRowView.tsx:99`) |
| `block.copySelection` | Cmd+C | blockSelected | — | discoverable only by shortcut; the context menu has no "Copy as markdown" |
| `block.duplicate` | Cmd+Shift+D | editorFocused ‖ blockSelected | context menu | exposed |
| `block.copyRef` | Cmd+Shift+C | editorFocused ‖ blockSelected | context menu | exposed |
| `edit.paste` | Cmd+V (informational) | editorFocused | native | exposed |

**Task (13, `task.ts`)**

| Command | Keys | `when` | Other surfaces | Verdict |
|---|---|---|---|---|
| `task.cycle` | Cmd+Enter | editorFocused ‖ single selection | context menu; marker glyph click | exposed |
| `task.toggleDone` | none | isTask | context menu, mobile toolbar | exposed |
| `task.setMarkerTodo` | none | editorFocused ‖ blockSelected | slash "TODO / task" | exposed |
| `task.setMarkerDoing` / `Waiting` / `Canceled` / `Done`, `task.clearMarker` | none | (isTask for clear) | palette only | discoverable only by palette. PLAN §8: "WAITING and CANCELED are reachable from the menu" — they are not in the context menu |
| `task.setPriorityA` / `B` / `C` | none | isTask | palette only | discoverable only by palette; no visual affordance to set a priority |
| `task.setScheduled` / `task.setDeadline` | none | editorFocused ‖ blockSelected | slash "Scheduled" / "Deadline" | **dead**: `CommandLayer.tsx:301` passes `createFakeDatePickerHost()`, whose `open()` only pushes to an array (`registrations/date-picker-host.ts`). Runtime check §1.9 |

**Navigation (10, `nav.ts`)**

| Command | Keys | Other surfaces | Verdict |
|---|---|---|---|
| `palette.open` | Cmd+K | — | exposed (no button anywhere; the `?` help lists the key) |
| `nav.switchPage` | Cmd+O | — | shortcut/palette only |
| `nav.todayJournal` | Cmd+J | sidebar "Journals" | exposed |
| `nav.journals` | Cmd+Shift+J | sidebar | exposed |
| `nav.back` / `nav.forward` | Cmd+[ / Cmd+] | top bar arrows | exposed |
| `nav.followLink` | Alt+Enter | click | exposed |
| `search.open` | Cmd+Shift+F | sidebar "Search" | exposed |
| `nav.openPage`, `nav.revealBlock` | none | — | agent primitives (ADR 015 §2.4) that take `ctx.args`; they still appear as palette rows that do nothing when chosen |

**Formatting (9, `format.ts`)**: bold Cmd+B, italic Cmd+I, strikethrough Cmd+Shift+X, highlight
Cmd+Shift+H, inline code Cmd+E, insert link Cmd+Shift+K — all `editorFocused`; bold/italic/highlight
also in the context menu. `format.insertPageRef` / `insertTag` / `insertBlockRef` have no keys; they
are in the slash menu and the mobile toolbar. All exposed.

**Insert (11, `insert.ts`)**

| Command | Surfaces | Verdict |
|---|---|---|
| `block.setHeading1/2/3` | slash | exposed |
| `block.insertCodeFence`, `block.insertTable` | slash | exposed |
| `block.insertImage` | slash "Image" | **dead**: delegates to `editor.runStructuralCommand("block.insertImage")`, which `BlockTree.tsx` does not handle (no case; `commands/hosts/editor-host.ts:21` says it "needs `platform.files.pick` + asset upload, both outside" — never wired). Runtime check §1.9 |
| `block.embedPage` / `block.embedBlock` | slash | inserts `{{embed …}}`; the renderer shows a placeholder box, not the target (`editor/render/tokens.tsx:157–181`, header "Known gaps") — runtime check §1.9 |
| `block.insertToday` | slash | exposed |
| `block.insertProperty` | slash "Property" | inserts `key:: ` into the text; what the row then shows is a runtime check (§1.9) |
| `block.openSlashMenu` | mobile toolbar | exposed |

**App (8, `app.ts`)**

| Command | Keys | Other surfaces | Verdict |
|---|---|---|---|
| `edit.undo` / `edit.redo` | Cmd+Z / Cmd+Shift+Z | mobile toolbar | exposed |
| `app.toggleSidebar` | Cmd+\ | top bar | exposed |
| `app.openSettings` | Cmd+, | help menu | exposed (the only pointer route is the `?` corner button, deliberately — `HelpMenu.tsx:122`) |
| `app.openPluginManager` | none | — | **dead** (`/settings/plugins` is not a route) |
| `sync.now` | none | — | palette only |
| `app.toggleTheme` | none | Settings → Appearance | exposed |
| `app.hideKeyboard` | none | mobile toolbar | exposed |

Spec drift worth one line: `docs/spec/commands-and-keymap.md`'s command table lacks the nine
`format.*` and four `task.setMarker*` commands that are registered, and lists nothing for
`nav.openPage`/`nav.revealBlock` (diffed with `comm` over the two id lists).

### 1.3 Slash menu (`commands/slash/items.ts`, 15 items)

TODO / task, Heading 1–3, Code block, Table, **Image (dead)**, **Scheduled (dead)**, **Deadline
(dead)**, Embed page, Embed block (placeholder render), Page reference, Tag, Today's date, Property.
No `/template` or `/query` yet (M7). No numbered list, quote, divider, or "Turn into page".

### 1.4 Context menu (`app/BlockContextMenu.tsx`, 13 entries, `when`-filtered)

Zoom in · Copy block reference · Cycle task state · Toggle done · Indent · Outdent · Move up · Move
down · Bold · Italic · Highlight · Duplicate · Delete. Missing, though the commands exist: Collapse/
Expand, Copy as markdown, Set priority, Mark WAITING/CANCELED, Set scheduled/deadline (dead anyway),
Open on shelf (no command exists for it — Shift+click is the only way in, `BlockRowView.tsx:95`).

### 1.5 Palette (`commands/palette/`)

One component, four modes: mixed (Cmd+K), commands (`>`), pages (Cmd+O), tags (`#`); a "Create page
"x"" row when nothing matches. Pages rows carry aliases (`app/hosts.ts:97–120`), so alias search
works here. No "open in shelf" action, no recent-pages ordering beyond MRU, no journal-date jump.

### 1.6 Settings (`views/SettingsPanel.tsx`, three sections at snapshot; M7 #6 is editing it)

Appearance (theme; journal date format; text size / width / custom CSS arriving from
`data/appearance.ts`), Search & embeddings (status, provider form, re-index), About (server, graph,
data dir, version, "Open diagnostics"). Not present: keybindings editor (PLAN §12 and ADR 009
promise "a settings UI that lists all commands, shows conflicts" — `CommandProvider.tsx:44` has the
`setKeybindings` seam and nothing calls it), plugin list, tokens, backups, mirror.

### 1.7 Shell, routes, help

- Sidebar (`shell/Sidebar.tsx`): Journals · Pages · Tasks · Search · Graph; Favourites (pages with
  `favorite::`); "Pages" = 12 most recently edited non-journal pages. No Settings, Diagnostics,
  Capture, Trash entries. Favouriting is only possible from the star in `/pages`
  (`views/AllPagesView.tsx:85`), not from the page itself or the palette.
- Top bar (`shell/AppShell.tsx`): sidebar toggle, back, forward, sync indicator (→ Diagnostics),
  live-UI consent badge.
- Shelf (`shell/Shelf.tsx`): appears only once something is Shift+clicked onto it.
- Routes (`App.tsx`): `/` → `/journals`, `/journal/today` → `/journals`, `/journals`, `/pages`,
  `/page/*name` (+ `?block=` zoom), `/search`, `/tasks`, `/graph`, `/capture` (PWA shortcut and
  share target only — `public/manifest.webmanifest`; no in-app link).
- Help `?` (`shell/HelpMenu.tsx`): Settings, Keyboard shortcuts (generated from the live keymap),
  Documentation, Report a bug, Request a feature, version.
- Mobile toolbar (`commands/toolbar/MobileToolbar.tsx`): outdent, indent, up, down, `[[ ]]`, `#`,
  `(( ))`, `/`, toggle done, undo, redo, hide keyboard.
- CLI (`packages/server/src/cli.ts`): serve, import, export, mcp, token, embed, plugin, backup,
  restore, gc, verify.

### 1.8 Data hooks with no renderer

Every `use*` in `apps/web/src/data/store.ts` has at least one non-test caller
(`usePageTree` ×6, `useJournalStream` ×4, `usePinnedJournalDay`, `useSyncStatus` ×3,
`usePageByName` ×2, `useAllPages` ×4, `usePageProperties`, `useFavoritePages` ×2, `usePageIcons`
×2, `useOpenTasks` ×2, `useNamespaceChildren` ×2, `useLinkedReferences` ×2, `useGraphLinks`,
`useSearchResults`). No dead hooks. The gaps are the other way round: data the replica holds that no
hook exposes — generic block properties (`list:: number` and friends: `editor/numbering.ts` header,
`editor/types.ts:34`, `BlockTree.tsx:112` hard-codes `listNumber: false`), block timestamps, and
`scheduled`/`deadline` (mapped into `EditableBlock` at `BlockTree.tsx:95–108` but never rendered by
`BlockRowView.tsx`).

### 1.9 Runtime pass

What was run: `cd e2e && NOOKLET_E2E_PORT=6360 pnpm exec playwright test tests/a-fresh-journal.spec.ts`
(builds the client, boots a server on 6360, 1 passed, 3.4 s; the global teardown stopped it). Then
`pnpm nooklet serve --port 6361 --data <scratch>/audit-data --no-mirror` and, to test the mirror
claim, `pnpm nooklet serve --port 6362 --data <scratch>/audit-data-mirror` with the default. A
Playwright script (`<scratch>/audit.mts`, results in `<scratch>/audit-results.json`, screenshots in
`<scratch>/shots/`) seeded nine pages over `POST /api/v1/page.create` / `page.append` — a page with
`alias:: garden`, blocks with `list:: number`, a block with `foo:: bar`, tasks with
`scheduled::`/`deadline::`, a page with `tags:: foo`, `{{embed}}`s, mermaid/js/query fences and
inline math, a three-level outline — and then walked the client. Note: the running build already
contained the M7 templates work (an "Insert template…" command and a "Template" slash item that were
not in the files read earlier) and the appearance rows ("Text size", "Content width"); the tree
moved between reading and building.

| Check | What the app showed | Verdict |
|---|---|---|
| Palette `>` with nothing focused | 18 rows: Open command palette, **Collapse all, Expand all**, Switch page, Open today's journal, Open journals, Go back, Go forward, Open search, **Open page, Reveal block**, Undo, Redo, Toggle sidebar, Open settings, **Open plugin manager**, Sync now, Toggle theme | five of the 18 rows a person sees first do nothing when chosen |
| Palette `>` with a block being edited | 63 rows (full list in `audit-results.json`), including Set scheduled date, Set deadline date, Image, Embed page/block, Property, Insert template… | — |
| "Collapse all" on a 5-row, 3-level page | 5 rows before, 5 after, 0 collapsed bullets; "Expand all" after a manual Cmd+Up collapse: see §1.9 follow-up | **dead** (as read from `BlockTree.tsx`) |
| "Open plugin manager" | URL becomes `/settings/plugins`, `.page-scroll-inner` is empty — a blank main area | **dead** |
| Slash menu | 16 items: TODO / task, Heading 1–3, Code block, Table, Image, Scheduled, Deadline, Embed page, Embed block, Page reference, Tag, Today's date, Property, Template | — |
| `/scheduled` on "parent2" | text returns to `parent2 `; no element with `date`/`picker` in its class, no dialog | **dead** (fake `DatePickerHost`) |
| `/image` | no `filechooser` event within 1.5 s; text unchanged | **dead** |
| `{{embed [[Numbered]]}}`, `{{embed ((id))}}` | rendered as the boxes "Embed: [[Numbered]]" and "Embed: ((nonexistentid))" | placeholder only; embeds do not transclude |
| Blocks with `list:: number` | 0 `.vr-list-number` elements; rows read "one / two / three" | **numbered lists never render** (research/13 §4.1 says "have") |
| Block with `foo:: bar` | row shows "has a prop"; the editor buffer is "has a prop"; `block.read` returns `properties: {foo: "bar"}` | block-level properties are stored but **invisible and uneditable** in the UI (PLAN §8 "chips under the block" not built) |
| Task with `scheduled:: 2026-09-20`, `deadline:: 2026-09-25` | row is "☐ call mom" — no date anywhere in the row's HTML; `/tasks` shows the due day | **a block's own scheduled/deadline is invisible on the page**; only the Tasks view shows it |
| `[#A]` priority | rendered as a badge ("☐ A priority one") | exposed |
| Journal stream | no "Scheduled and deadline" section (no such text on `/journals`) | missing, as PLAN §8 admits |
| Page with `tags:: foo` | `/page/foo` says "This page doesn't exist yet" with no references panel; `page.list {tag: "foo"}` returns "Tagged" | "pages tagged X" is API-only |
| Alias `garden` on "Zahrada" | Cmd+O "garden" → Zahrada (palette matches aliases); `/page/garden` → "doesn't exist"; `[[gard` autocomplete offers only 'New page "gard"' and a block hit — not Zahrada (§1.9 follow-up checks `[[garden`) | partial |
| Fences | `mermaid`: no `<svg>`; `js`: no highlight spans; `query`: plain `<pre>` with "TODO"; `$E=mc^2$` rendered literally | M7 #1/#9 not in this build; mermaid plugin renderer never mounts |
| Client plugin loading | `GET /api/v1/plugins` lists mermaid and word-count with `client_url`s; the browser made **zero** requests to `/plugins/` or `/api/v1/plugins`; no "words" text on any page | **client plugin halves are dead** |
| Mirror (6362, mirror default on) | after `page.create` and 3 s: data dir holds `graph.sqlite`, `-shm`, `-wal`, `plugin-data`; **no `pages/` or `journals/` directory** | **`serve` does not write the mirror** |
| Page view controls on "Zahrada" | buttons: icon "＋", Properties toggle, bullets, Unlinked references, Link all; no Delete, no Favourite, no word count | no per-page actions beyond rename/icon/properties |
| Context menu (not editing) | Zoom in, Copy block reference, Cycle task state, Indent, Outdent, Move up, Move down, Bold, Italic, Highlight, Duplicate | as coded |
| Help → Keyboard shortcuts | 48 rows: App 4, Block 29, Formatting 6, Navigation 8, Task 1 | the 34 commands with no key are invisible here |
| Sidebar | Journals, Pages, Tasks, Search, Graph; one section "Pages" (Favourites appears only when a page has `favorite::`) | as coded |
| Top bar | Toggle sidebar, Back, Forward, Show diagnostics, "Agents can see this window" | as coded |
| Settings | Appearance (Theme, Journal date format, Text size, Content width), Search & embeddings, About (Server, Graph, Data directory, Version, Open diagnostics) | as coded + M7 #6 |
| Search filters | Hybrid/Keyword/Semantic; Tag, Namespace, Updated after, Updated before | `properties`/`scope`/`pages`/`journals_only` unexposed |
| Tasks filters | State (TODO, DOING, LATER, NOW, WAITING), Tag, Namespace, Due from, Due to; due dates shown | exposed |
| Shelf | Shift+click on a block opened the shelf with a "Nested" card | works, but Shift+click is the only way in |
| `/capture` | "Quick capture · Journal · Save to journal" | reachable only by URL / PWA shortcut / share target |
| Graph | "8 pages · 1 links", Journals toggle, Fit | exposed |

**Aliases in the `[[` / `#` popups** (`<scratch>/audit3.mts`, `audit3-results.json`): on fresh
pages against the rebuilt `dist` (post-`1add7e9`), `[[gard`, `[[garden` and `#gard` all list
Zahrada first, with no page errors. The first pass (17:31 build) had offered only 'New page "gard"'
for the same query; that was not reproducible afterwards and is recorded as unconfirmed, not as a
defect. The one alias gap that stands is the route: `/page/garden` → "doesn't exist".

**Follow-up run** (`<scratch>/audit2.mts`, `audit2-results.json`): `/pages` lists 9 pages with a
star each once the replica has settled (the first pass read it too early). "Expand all" after a
manual Cmd+Up collapse: 3 rows before, 3 after — dead like its twin. `/property` inserts a literal
`key:: ` line into the block text; after typing a value and leaving the block, the row renders
"start here key:: bar" as plain text and `page.read` returns `content: "start here \nkey:: bar"`
with **no** `properties` — the editor path keeps `key:: value` as text, whereas the API/import path
(`page.create` with the same markdown) turns it into a `block_prop` row. Diagnostics' backend
section, once loaded: Graph, Full-text search, Vector search, Embedding model, Embedding backlog.
Cmd+O with "gard" and "garden" both list Zahrada (alias ranking works in the palette); the `[[`
popup's alias behaviour is in the paragraph after the table in §1.9 above (clean re-test in
`audit3-results.json`).

### 1.10 Exposure gaps, ranked

Ranked by how much a person loses today × how cheap the honest fix is. "Fix" is the smallest
change that closes the gap; effort tiers are minutes / an hour / half a day / a day.

| # | Gap | Evidence | Smallest honest fix | Effort |
|---|---|---|---|---|
| 1 | The markdown mirror is only written by `nooklet export`; `serve` never touches it, so the on-disk copy the README promises is stale from the first edit after the last CLI run | §1.1, §1.9 mirror row; `exportAll` callers = `cli.ts:305` only | After `serverApplyOps` commits, `exportPage` each touched page id (debounced ~500 ms as ADR 002 already says) when `config.mirror.enabled`; `exportAll({onlyChanged: true})` on startup; a Settings → About row "Mirror: last written …". Until then, fix the README/OPERATIONS wording | an hour |
| 2 | No way to delete a page in the UI | §1.1 `page.delete`; §1.9 page-view row | A `page.delete` command (palette + a "…" button in the page title row) with confirm, navigating to `/pages` afterwards; belongs with the M7 trash view so restore exists the same day | an hour |
| 3 | `/scheduled`, `/deadline`, "Set scheduled/deadline date" do nothing | `CommandLayer.tsx:301` fake host; §1.9 | Replace `createFakeDatePickerHost()` with a host that opens a small popover (`<input type="date">` + optional time, reuse `views/Calendar.tsx` if wanted) and calls `store.setBlockProp(blockId, field, value)`; repeat can wait | half a day |
| 4 | A block's scheduled/deadline is invisible on the page; only `/tasks` shows it | §1.9 Tasky row | In `BlockRowView.tsx`, after the content, a `.vr-date` chip per set field (`block.scheduled`/`deadline` are already on `EditableBlock`), red when past today | an hour |
| 5 | Client plugin halves never load: Mermaid and Word count are "have" in research/13 but unreachable | §1.1, §1.9 plugin rows | Either build the client plugin host (fetch `/api/v1/plugins`, `import(client_url)`, implement `ClientPluginContext` slots — a status strip in `AppShell`, a code-block renderer map consulted by `tokens.tsx`'s `fence` case, slash/command registration) — or stop pretending and move mermaid into core (lazy CDN import in the `fence` case) and drop word-count | a day (host) / an hour (core mermaid) |
| 6 | Five palette rows that do nothing: Collapse all, Expand all, Open page, Reveal block, Open plugin manager | §1.9 palette row | Implement collapse/expand-all in `BlockTree.tsx` (one `block.collapsed` op per block with children, batched — `commit` already exists); delete `app.openPluginManager` until there is a plugin UI; give `nav.openPage`/`nav.revealBlock` a `when` that never holds for humans (or a `hidden` flag the palette filters on) | an hour |
| 7 | Block-level properties are invisible and uneditable; `/property` writes text that is not a property | §1.9 Props + follow-up | Project generic `block_prop` rows into `BlockRow`/`getPageTree` (`packages/core/src/sync/queries.ts`), render them as read-only chips under the content in `BlockRowView.tsx`, and make `block.insertProperty` write a `block.prop` op (or have the editor's flush split `key:: value` lines the way the outline parser does — pick one and say so in the grammar spec) | half a day |
| 8 | Numbered lists never render | `numbering.ts` header; §1.9 | Same seam as #7: `listNumber = props.list === "number"`; a slash item "Numbered list" toggling `list:: number` | an hour on top of #7 |
| 9 | `/image` does nothing; `asset.upload` has no client caller | §1.9 | `block.insertImage` in `BlockTree.tsx`: `<input type=file>` → `POST /api/v1/asset.upload` (base64 as `e2e/tests/assets.spec.ts` does) → insert the returned markdown at the caret; drag-and-drop and paste can follow | half a day |
| 10 | `/page/<alias>` says the page does not exist | §1.9; B-55 follow-up | `usePageByName` falls back to a `page_prop WHERE key='alias'` scan (the replica has `page_prop`); `goToTarget` likewise | an hour |
| 11 | "Pages tagged X" exists only as `page.list {tag}` | §1.1, §1.9 | On every page view, a "Tagged pages" section under the namespace children: `SELECT page_id FROM page_prop WHERE key='tags'` filtered client-side with `splitList` (same shape as `useFavoritePages`) | an hour |
| 12 | Favourites can only be set from `/pages`; no favourite/unfavourite on the page or in the palette | §1.7 | A `page.toggleFavorite` command + star next to the title; sidebar "Favourites" then stops being invisible on a fresh graph | an hour |
| 13 | Settings, Diagnostics and Quick capture have no sidebar presence; capture is URL-only | §1.7 | Three footer links in `Sidebar.tsx`; `/capture` also as a palette command | minutes |
| 14 | Search UI exposes 4 of the op's 9 filters (no marker/properties, no pages-only scope, no journals-only) | §1.1 search row | Three controls in `SearchView.tsx` mapped onto `properties: {marker}`, `scope`, `journals_only` | an hour |
| 15 | Context menu misses commands that exist: Copy as markdown, Collapse/Expand, Set priority, Mark WAITING/CANCELED, Set scheduled/deadline (once #3 works), Open on shelf (no command yet) | §1.4 | Add the entries to `ENTRIES`; add a `block.openOnShelf` command that calls `app/shelf.ts` with the focused block | an hour |
| 16 | Undo of an agent batch is reachable only after "Link all" | §1.1 `batch.undo` | Later, with `changes.since`: a "Recent changes" panel with undo per batch — not cheap; note only | a day |
| 17 | Keybindings editor promised by PLAN §12 / ADR 009 does not exist; `setKeybindings` seam unused | §1.6 | A Settings section: command list, current key, conflicts (`detectConflicts` exists), edit stored as a synced setting | a day |
| 18 | Backups, tokens, plugin enable/disable are CLI-only | §1.1 | For a single-user local app this is acceptable; a "Back up now" button needs a new admin op. Note only | half a day each |
| 19 | `related.find` and `changes.since` have no reader | §1.1 | "Related pages" section on a page when embeddings are on (one HTTP call like backlinks); agent-change badges later | an hour / later |
| 20 | Spec/comment drift: `commands-and-keymap.md` lacks 13 registered commands; `DiagnosticsPanel.tsx:11` cites an `app.diagnostics` command that does not exist | §1.2 | Add `app.diagnostics` (minutes) and regenerate the spec table | minutes |

**Re-checked at HEAD `f5b5248` (~17:55)**, after the M7 commits listed at the end of this
document: every gap above still holds — `CommandLayer.tsx:302` still passes
`createFakeDatePickerHost()`; `editor/` still has no `collapseAll`/`expandAll`/`insertImage`
handling; `hosts.ts:301` still navigates to `/settings/plugins`; `BlockTree.tsx:112` still
hard-codes `listNumber: false`; `exportAll` is still called only from `cli.ts:306`; nothing in
`apps/web/src` references `/api/v1/plugins` or `client_url`; no client file calls `page.delete`
outside the replica reducer; `BlockRowView.tsx` still renders no scheduled/deadline. What did
change: the sidebar now links `/trash` (so #13 is three entries, not four), the context menu now
has "Turn into page" and "Move to page…" (15 entries), and the slash menu has Template and Query
(17 items).

---

## 2. Cheap wins from what Logseq users ask for

Source: `docs/research/13-logseq-usage-and-demand.md` §3.1 (forum requests by votes), §3.3
(GitHub 👍), §3.5 (what leavers miss) and the §4.1 mapping table. M7 already takes the top ten of
§4.2; everything below is what remains that could ship in under a day each given what §1 found
exists. Ranked by demand evidence × cheapness. Effort tiers as in §1.10.

| # | Candidate | Demand evidence (research/13) | What exists already | Smallest implementation | Effort | Reason not to / caveat |
|---|---|---|---|---|---|---|
| 1 | **Journal day "Scheduled and deadline" section** (today: due today + overdue; other days: due that day) | PLAN §8 promises it and admits it is unbuilt; §4.1 row "Scheduled/deadline" says "verify the journal-day section exists"; t/5815 (93 likes) left task management over *"no calendar or timeline view or features like highlighting overdue tasks"*; agenda how-to 83k views (§4.1 Tasks view row) | `useOpenTasks` (`data/store.ts:540`), `views/taskFilters.ts` (`filterTasks` with `dueFrom`/`dueTo`, `sortTasksByDue`), `TasksView.tsx` row markup, `todayJournalDay` | A `DayAgenda` component under each `journal-day-title` in `JournalStreamView.tsx`: `filterTasks(tasks(), {dueFrom: day, dueTo: day})`, plus for today `dueTo: today-1` as "Overdue"; rows reuse the Tasks view row (checkbox + `InlineContent` + due day). Hidden when empty | half a day | Journal stream renders 14+ days; compute once from one `useOpenTasks()` at the stream level, not per day |
| 2 | **Scheduled/deadline chips on the block row** | same as #1; "done date query-able" 42 votes | `EditableBlock.scheduled/deadline` already populated (`BlockTree.tsx:95–108`) | `.vr-date` chip(s) after the content in `BlockRowView.tsx`; `vr-date-overdue` class when `< today` | an hour | none |
| 3 | **A real date picker** for `/scheduled`, `/deadline`, "Set scheduled/deadline date" | Logseq bugs #10105/#8485 (`/scheduled` eats text) show the command is used enough to be complained about; `/scheduled` is in nooklet's own slash menu today and does nothing (§1.9) | `DatePickerHost` seam, `views/Calendar.tsx`, `store.setBlockProp` | Popover anchored at the caret: `<input type="date">` (+ optional `<input type="time">`), Save → `setBlockProp(blockId, "scheduled"|"deadline", "YYYY-MM-DD[ HH:MM]")`; a "Repeat" field can come later | half a day | ship without repeat; the ADR 011 grammar for `repeat::` is already accepted by the reducer, so a text field for it is minutes more |
| 4 | **Collapse all / Expand all** (and "open pages collapsed") | "Outlines Collapsed by Default" 84 votes (§3.1); the two commands are already in the palette and dead (§1.9) | commands registered; `block.collapsed` op; `BlockTree.commit` | In `runCommand`/selection switch: one `block.collapsed` op per block with children, committed as one batch. The default-collapsed preference is a view-local Settings toggle applied when a `BlockTree` first mounts (never written as ops — it would fight synced `collapsed`) | an hour (commands) + half a day (setting) | keep the setting device-local |
| 5 | **Alias resolution on the route** (`/page/<alias>`; the palette and the `[[`/`#` popups already match aliases — §1.9) | #4709 (50 👍) aliases duplicated/mishandled; "Hide aliases circles in Graph View" 109 votes; §4.1: "test alias edge cases" | Server side done (B-55); palette already ranks aliases (`hosts.ts:101`, `rank.ts`); `usePageByName` is key-only | `usePageByName` falls back to `page_prop key='alias'` (split on commas, `normalizePageName`) when the key misses; `goToTarget` uses the same; then `[[garden]]` typed by hand lands on Zahrada | an hour | none |
| 6 | **"Open on shelf" as a command** (palette, context menu, Shift+Enter on a palette page row) | "Outline Overview for sidebar" 121 votes and "sidebar" 11k how-to (§4.1 Right sidebar row); the shelf exists but only Shift+click reaches it (§1.9) | `app/shelf.ts` (`shelfItems`, open functions), `BlockContextMenu` | `block.openOnShelf` (focused block or selection anchor) and `page.openOnShelf` (current page) commands; one `ENTRIES` line; palette `onSelectPage` with shift → shelf | an hour | none |
| 7 | **Numbered lists** | 700 numbered lines in the owner's own graph (§4.1 says "have" — it does not render, §1.9) | `deriveNumbering`, `.vr-list-number` markup, `list:: number` stored in `block_prop` | Project generic block props through `getPageTree` (`packages/core/src/sync/queries.ts`) into `BlockRow`; `listNumber = props.list === "number"`; slash item "Numbered list" writing `block.prop list=number` | half a day | shares the seam with block-property chips (§1.10 #7); do both together |
| 8 | **Embeds that actually transclude** (read-only first) | leavers miss *"editable transclusion in backlinks"* and *"seeing child blocks"* (§3.5); DB import "page and block embeds not imported" is a listed grievance (§3.4); `{{embed}}` is in nooklet's slash menu and renders a box (§1.9) | `EmbedView` placeholder; `Shelf.tsx#ShelfOutline` already renders a page/block subtree read-only through the same renderer; `usePageTree`, `resolveBlockPageName`, `lookupBlockText` | Add `resolveEmbed?: (target) => BlockTreeNode[] | undefined` to `RenderCtx` (mirrors `resolveBlockRef`), have `BlockRowView` supply it from a small cache like `block-ref-cache.ts`, and render with `ShelfOutline`-style markup inside `.vr-embed`, depth-limited to 2 | half a day | editing inside an embed is a day+ (nested `BlockTree` with its own surface); read-only is honest and what most embeds are read as |
| 9 | **Copy/export a page as markdown** | "Pandoc plugin for exporting & Export to PDF" 110 votes; #2871 markdown export 24 👍 (§4.1 Export row); leavers' #1 reason is portability | `block.copySelection` already serialises selected blocks as markdown (`BlockTree.tsx:825`); `page.read` returns outline text; `serializeOutline` in core | `page.copyAsMarkdown` command (whole tree, ids off) + "Download .md" (a Blob link) from the page "…" menu once one exists (§1.10 #2) | an hour | the mirror file is the same text — but it is stale (§1.10 #1), so do not point people at it until #1 is fixed |
| 10 | **Print / Save as PDF** | 110 (pandoc/PDF) + 61 ("Export PDF with highlights") votes | nothing print-specific | `@media print` in `styles/`: hide `.app-topbar`, sidebar, shelf, help fab, bullets' controls; expand collapsed children; `page.print` command → `window.print()` | an hour | indent guides and page breaks will need a second pass; images load from the API origin and print fine |
| 11 | **Search filters in the UI** (marker / property, journals only, pages only) | "Search operators / filters for the search box" 83 votes; "Filters for note body" 140; §4.1: "expose tag/marker filters in the UI, not only in the op" | `search` op accepts `properties`, `scope`, `journals_only`, `pages` (§1.1) | Three controls in `SearchView.tsx`'s `<details>`; a marker `<select>` maps to `properties: {marker}` | an hour | none |
| 12 | **"Pages tagged X"** on a tag's page | ADR 017 built `page_tag` for exactly this; Logseq shows "Pages tagged with"; namespace/tag redesign 114 votes; DB "NewTags" 8.8k views (§4.1) | `page.list {tag}` works (§1.9); replica has `page_prop` | A section under `NamespaceChildren` in `PageView`: pages whose `tags::` list includes this page (client query shaped like `useFavoritePages`) | an hour | a tag page that does not exist yet still shows "doesn't exist" — render the section on the missing-page view too |
| 13 | **Favourite from the page and the palette; "Recent" named as such** | §4.1 Favourites row (B); sidebar "Favourites" is invisible on a fresh graph and the only star is in `/pages` (§1.7) | `setPageFavorite`, `useFavoritePages`, `Sidebar` | `page.toggleFavorite` command + star beside the title; rename the sidebar "Pages" section to "Recent" | an hour | none |
| 14 | **Word count** | 34 votes; word-count plugin 18k downloads (§4.1); the built-in plugin never mounts (§1.9) | `plugins/word-count` (server op `page.wordcount` + dead client half); `usePageTree` | Until the client plugin host exists (§1.10 #5): a muted "N words · M blocks" line at the foot of `PageView` computed from the tree | an hour | duplicates the plugin; decide the plugin host first, then delete one |
| 15 | **Block timestamps** in the context menu / a tooltip | "Block Timestamps" 46 votes (done in Logseq DB); §4.1: "show in context menu; trivial" | `updated_at` is in `BlockRow`; `created_at` — see the note below the table | A non-clickable footer line in `BlockContextMenu` ("Created … · Edited …") | an hour | none |
| 16 | **Search in the current page** (filter the outline) | "Search inside … page with Ctrl+F" 78 votes, done in Logseq (§3.1) | rendered rows carry their text; `BlockTree` flatten | A filter input on the page view hiding rows that do not contain the text, keeping ancestors; Cmd+F when the editor is not focused | half a day | interacts with collapsed state and zoom; keep it purely visual |
| 17 | **Read-only page lock** (`read-only:: true`) | "Lock a page as read-only" 69 votes (§3.1) | page properties panel | `BlockTree` refuses to enter edit mode when the page property is set; the title input likewise; a padlock glyph in the title row | an hour | UI-only: the API and agents are not bound by it — say so in the spec, or do not build it |
| 18 | **Random page** | no vote evidence in research/13 (not in the top 40 or the mapping table) | `useAllPages` | `nav.randomPage` command excluding journals | minutes | harmless, but no demand recorded — do it only if it is free |

Note on #15: `apps/web/src/editor/types.ts` `EditableBlock` carries `doneAt` only; whether the
replica's `BlockRow` exposes `created_at` was not checked in this pass (the server's `block` table
has both).

**Not cheap, or not worth it, despite votes** (so nobody re-litigates them next week):
custom TODO keywords (263 — a non-goal per §4.3), task notifications (85 — needs the native
shell), a table cell editor (58 — a day-plus widget), Vim (221 — plugin territory), multi-cursor
(28), tabs/windows (83 — wait for Tauri), auto-delete empty journals (82 — already true by
construction), "hide alias nodes in the graph" (109 — aliases are index rows, not pages, so the
graph never had them; unverified in this pass), rich-text/HTML paste (29 — `editor/paste.ts`
handles markdown; HTML→markdown is unverified and is a test to write, not a feature).

---

## 3. Publishing a graph as a static site

Scoping only; nothing here is a decision.

### 3.1 What Logseq's Publish is, and what people get from it

Source: `logseq/docs` `pages/Publishing.md` (fetched with `gh api` + raw on 2026-09-12; the
`docs.logseq.com` SPA itself was too large to fetch). Its own words: the feature *"publishes a
graph as a Publish Web, single page application (SPA). This is known as the Export option `Export
public pages`"*; it is *"Desktop App Only"*; *"By default no pages are public. Individual pages can
be marked as public with the property `public:: true`"* (or all-public via
`:publishing/all-pages-public?` and `public:: false` to opt out); *"All published pages are
displayed in a read-only mode"*; *"Most features in a Publish Web app should work e.g. page Search,
block links and page links"*; it reads `config.edn`, `custom.css`, `custom.js`, `export.css`;
routes are hash routes (`/#/page/:NAME`, heading anchors `/#/page/:NAME/block/:HEADING-CONTENT`);
and *"This only works for referenced blocks. If a block is not referenced elsewhere then its id is
temporary and will change on a subsequent publish."* The community adds `logseq/publish-spa` (a
GitHub Action/CLI that runs the export headless) and `logseq-schrodinger` (export pages to Hugo).

What that design implies, and what nooklet's data already fixes — inferred from the document, not
from user complaints (research/13 records only that publishing has 21k how-to views and 10 open
`publishing` issues, and §4.3 files it under "the mirror plus any static site generator; no second
renderer"):

- The export is the whole Logseq frontend bundle plus the graph as data: every site ships
  megabytes of JS and renders client-side behind `/#/` routes — fine for humans, poor for crawlers
  and for "just link me to that paragraph". nooklet can emit plain HTML.
- Desktop-only: there is no first-party CLI path. nooklet's CLI already opens `graph.sqlite`
  without a server (`packages/server/src/cli.ts#open`, as `nooklet export` does).
- Block anchors are unstable unless referenced. Every nooklet block has a stable short id (ADR
  004) and the mirror already writes it as `^id`, so `#<id>` anchors are free and permanent.
- `public::` is a page property in both; a Logseq import carries it across as an ordinary
  `page_prop` row, so existing marks survive (not verified on the owner's graph in this pass).

### 3.2 What `nooklet publish <graph> --out <dir>` would need

| Piece | What exists | What is missing |
|---|---|---|
| Page → tree | `mirror/export.ts#renderPageToOutline` returns a `ParsedPage` (properties, markers, priorities, scheduled/deadline/repeat/done as strings, collapsed, children) straight from the DB | nothing; reuse as is |
| Inline/block rendering | `@nooklet/core` `classifyBlockContent`/`tokenizeContent` are platform-free (core depends only on `date-fns`, `fractional-indexing`). The client's `render/tokens.tsx` maps tokens to HTML with the exact class names `docs/spec/markdown-grammar.md` §4 fixes | **a server-side HTML renderer.** Two ways: (A) a ~300-line pure-string `tokensToHtml` in `packages/server/src/publish/` following the same contract, tested against the same fixtures as `tokens.test.tsx`; (B) Solid SSR (`renderToString` from `solid-js/web`) over the real `tokens.tsx` — needs an SSR-mode JSX compile of that module (the CLI runs under `tsx`, which does not compile Solid JSX) and `tokens.tsx` must lose `./asset-url.js` → `data/bootstrap.ts` (browser globals). (A) is a day and risks drift; (B) is half a day to find out whether it is a day or a week |
| Links | `wikilink`/`tag`/`linkToPage` tokens carry the target name; `page-name.ts` normalises; `page_alias` resolves aliases | slugging (`pageNameToFileName` in core already makes safe file names for the mirror), and a "private target" rule: a link to a non-public page renders as plain text |
| Block refs, embeds | server has every block; `resolveBlockRef` seam is already how the client injects it | build-time resolution; private targets → a "(private)" placeholder, depth-limited to 2 |
| Backlinks | the `ref` table and the exact query `page.backlinks` uses (`data-api.ts`) | one call per page; group by source page as `ReferencesPanel` does |
| Listing | `page` (kind, `journal_day`), `page_tag`, namespaces | index page (all public pages, A–Z and recent), tag pages (public members only), namespace children, journals under `journals/<iso>/` only with `--journals` |
| Assets | `<data>/assets/<id>.<ext>`; content carries `assets/<id>.<ext>` (`asset-url.ts` shows the one rewrite rule) | copy only assets referenced from public pages; rewrite to a relative `../../assets/` |
| Tasks | marker glyphs live in `BlockRowView.tsx#MARKER_GLYPH`; priority badge | same glyphs in the static markup; scheduled/deadline as text |
| Collapsed blocks | `collapsed` flag | `<details open>` per collapsed subtree so nothing is hidden from a reader without JS |
| Search | none in the client that runs without the server (FTS is server-side) | `search.json` (page name, url, block text) + ~60 lines of vanilla JS with diacritic folding (`pageSearch.ts#foldDiacritics`'s two lines); Pagefind or MiniSearch are alternatives with a dependency each |
| Styling | `editor/editor.css` (`.vr-*`), theme tokens in `styles/shell.css` | a standalone `publish.css` (~150 lines) with light/dark via `prefers-color-scheme`; the web CSS is bundled/hashed in `apps/web/dist`, so it cannot be read back at runtime from a packaged server |
| Privacy | `public::` as a page property (syncs, agent-settable via `page_update`) | default: only `public:: true`; `--all-public`; tests that grep the output directory for every non-public page name and any block text from them |
| CLI | `cli.ts` subcommand pattern (`export`, `backup`) | `publish [--out <dir>] [--all-public] [--journals] [--home <page>] [--base-url <url>]` |
| Incremental | mirror's per-page hash bookkeeping | not needed in v1: 952 pages render in seconds |

### 3.3 Design sketch

```
nooklet publish --data ~/.nooklet/default --out ~/Sites/wiki [--all-public] [--journals]
  → out/index.html                 home: --home page or the A–Z index
    out/pages/<slug>/index.html    per public page: title, properties table, outline,
                                   namespace children, "Tagged pages" (if a tag), backlinks
    out/journals/<iso>/index.html  only with --journals
    out/tags/<slug>/index.html     public pages carrying tags:: <tag>
    out/assets/<id>.<ext>          referenced assets only
    out/search.json, out/site.js, out/site.css
```

Every block is `<li id="<blockId>">`, so `pages/<slug>/#<blockId>` is a permanent deep link; every
link is relative so the tree works from `file://`, GitHub Pages, or a subpath. No server-side
anything at view time. The renderer is one module, `packages/server/src/publish/render.ts`,
exporting `renderPageHtml(driver, pageId, opts)`; `site.ts` walks pages and writes files; the CLI
just calls it. It never touches the mirror (ADR 002's `mirror_file` bookkeeping stays untouched).

### 3.4 Effort and the biggest risk

- Minimum viable wiki (pages, links, backlinks, assets, `public::`, no search/tags/journals):
  **a day** if the renderer goes route (A).
- Complete v1 as sketched (search, tags, journals, namespace pages, light/dark, e2e that publishes
  the e2e graph and opens it in Chromium, privacy test): **two to three days.**
- The zero-code path — `nooklet export` mirror + Quartz/Hugo — is not honest: `^id` suffixes,
  `((refs))`, `{{embed}}`, `key:: value` lines and `TODO` markers appear raw, and the mirror is
  stale until §1.10 #1 is fixed. The preprocessor that would fix those is most of the publisher.

**The single biggest risk is a second renderer that drifts from the client's** — the exact thing
research/13 §4.3 chose to avoid. Mitigation if route (A): both renderers are written against
`markdown-grammar.md` §4's class-name contract, share one JSON fixture set, and an e2e renders the
same seeded page in the app and in the published output and diffs the text/class skeleton.
Mitigation if route (B): spend the half-day spike first; if Solid SSR of `tokens.tsx` compiles
cleanly under a small `vite build --ssr` of that one entry, drift is impossible by construction and
(A) is never written. The second risk is a privacy leak through backlinks, embeds, tag pages or
`search.json` quoting a private page; the output-directory grep test above is the guard.

---

## Defects noticed

Not added to `docs/BUGS.md` by this audit (single-file rule); the coordinator logs them. Repro is
against a fresh graph as in §1.9 unless stated. "Known" means an existing entry already covers it.

| # | Defect | Repro | Where |
|---|---|---|---|
| D1 | `nooklet serve` never writes the markdown mirror; only `nooklet export` does. README and OPERATIONS §2 describe it as continuous | `nooklet serve --data <empty>` (mirror default on); `POST /api/v1/page.create {"name":"MirrorTest","markdown":"- x"}`; wait; `ls <data>` shows no `pages/`. Verified on 6362 | `packages/server/src/cli.ts` (`exportAll` only in the `export` case), `mirror/export.ts` |
| D2 | `/scheduled`, `/deadline`, "Set scheduled date", "Set deadline date" do nothing | Edit a block, type `/sched`, Enter: the trigger text is removed and nothing else happens; no picker element exists | `apps/web/src/app/CommandLayer.tsx:301` (`createFakeDatePickerHost()`), `commands/registrations/date-picker-host.ts` |
| D3 | "Collapse all" / "Expand all" do nothing | On a 3-level page: palette → Collapse all: 5 rows stay 5. Cmd+Up on the root (3 rows), palette → Expand all: still 3 | `apps/web/src/editor/BlockTree.tsx` (no `case` for either id), `commands/registrations/structural.ts:109` |
| D4 | "Open plugin manager" navigates to a route that does not exist and leaves a blank main area | Palette → Open plugin manager → URL `/settings/plugins`, `.page-scroll-inner` empty | `apps/web/src/app/hosts.ts:301`, `App.tsx` |
| D5 | `/image` does nothing | Edit a block, `/image`, Enter: no file chooser, text unchanged | `BlockTree.tsx` (no `block.insertImage` case); `commands/hosts/editor-host.ts:21` |
| D6 | Numbered lists (`list:: number`) never render | `page.create` with `- one\n  list:: number\n- two\n  list:: number`; open the page: 0 `.vr-list-number` | `apps/web/src/editor/numbering.ts` header, `BlockTree.tsx:112`, `packages/core/src/sync/queries.ts` (no generic props on `BlockRow`) |
| D7 | Block properties are invisible and uneditable in the UI, and `/property` inserts literal text that never becomes a property | (a) `page.create` markdown `- has a prop\n  foo:: bar`: row shows "has a prop", editor buffer has no property, `block.read` has `properties: {foo: "bar"}`. (b) Edit a block, `/prop`, type `bar`, leave: `page.read` content is `"start here \nkey:: bar"` with no `properties` | `BlockRowView.tsx` (no chips), `commands/registrations/insert.ts:112` (`block.insertProperty`), the editor's text flush vs `outline.ts#parseOutline` property handling |
| D8 | A task's scheduled/deadline is not shown on its block row | `page.create` `- TODO call mom\n  scheduled:: 2026-09-20`; the row is "☐ call mom" with no date; `/tasks` shows it | `BlockRowView.tsx` (fields present on `EditableBlock`, never rendered) |
| D9 | Client plugin halves never load; Mermaid and Word count are advertised (research/13 §4.1 "have") and unreachable | Open any page: zero requests to `/plugins/*` or `/api/v1/plugins`; a ```` ```mermaid ```` fence renders as `<pre>`; no word count anywhere. `GET /api/v1/plugins` lists both with `client_url` | `apps/web/src` (no plugin host), `packages/server/src/plugins/http.ts:15,37` |
| D10 | `/page/<alias>` says "This page doesn't exist yet" (known: B-55 follow-up) | page with `alias:: garden`; open `/page/garden` | `apps/web/src/data/store.ts#usePageByName`, `views/navigateTarget.ts` |
| D11 | `nav.openPage` and `nav.revealBlock` appear as palette rows that do nothing when chosen | Palette `>`: "Open page", "Reveal block" → no effect | `commands/registrations/nav.ts:98–119`, `commands/palette/CommandPalette.tsx` (no way to hide arg-only commands) |
| D12 | Comment and spec drift: `DiagnosticsPanel.tsx:11` says "or with the `app.diagnostics` command" — no such command; `docs/spec/commands-and-keymap.md`'s table lacks the nine `format.*` and four `task.setMarker*` commands and does not list `nav.openPage`/`nav.revealBlock` | `grep -rn app.diagnostics apps/web/src`; `comm` of the spec's ids vs registrations | as named |
| D13 | research/13 §4.1 marks "Numbered lists" (row "Numbered lists, headings"), "Mermaid" and "Word count" as **have**; none is reachable (D6, D9). Its Templates row says "missing"; templates landed in this build | §1.9 | `docs/research/13-logseq-usage-and-demand.md` §4.1 (research is kept as written — a dated correction note belongs in the coordinator's hands) |
| D14 | (withdrawn) `[[` autocomplete did not offer the aliased page in the first pass; a clean re-run on the rebuilt build offers it for `[[gard`, `[[garden` and `#gard`. Not a defect on the evidence; noted so nobody re-chases the first observation | §1.9 alias paragraph | — |

### What landed in the tree while this was written (`a4d137f` → `f5b5248`)

`git log a4d137f..HEAD` at ~17:55: templates (`ced489d`, `3e7374d`: `/template`, journal template,
Settings section), appearance basics (`e338de5`), reference filters/sort + Link all (`3d56c6e`),
shelf outline mode (`aa3ca61`), the ```` ```query ```` fence rendering live (`4ef5864`, core
`d24ce73`), highlight.js + KaTeX wired (`e1286ff`), refactor ops and their commands "Turn into
page", "Move to page…", "Merge this page into…", "Find and replace…" (`ea74be5`, `e6aac6f`), a
`/replace` view (`cb45da6`), orphan-asset GC (`b1e9b6d`), `trash.list`/`trash.restore`/
`page.history` ops (`d72e7c4`, `9a10bc7`) and their views `/trash` and `/history/*name`
(`fd19935`, `f5b5248`). So §1.1's "M7 in flight" rows for trash/history/refactors and §1.9's
fence/math/template rows describe the 17:31 build, not HEAD; the §1.10 gaps and Part 2 candidates
were re-checked against HEAD (see the "re-checked at HEAD" line at the end of §1.10) and stand.
