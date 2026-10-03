# Readiness sweep: the core daily-use loop on the real graph (2026-10-03)

**Question (owner):** before the real test (own Mac, own server, own iPhone), are all the
functional pieces in place for basic daily use?

**Method.** `main` at `c322269`. `pnpm install --frozen-lockfile`, then `pnpm --filter @nooklet/web build`.
I copied `~/notes-graph` to a scratch directory (the original was only read)
and ran `nooklet import` into a fresh `--data` dir. Then `nooklet serve --port 6310` and real
headless Chromium (Playwright), driven the way a person would: clicks and keystrokes, with the API
used only to seed pages and read back what the server holds. All scripts are in
`tools/probes/sweep-core/` (`journal`, `refs`, `tasks`, `search-trash`, `sync`, `perf`,
`images`, `cold-load`, `draft-diag`, `indent-render`, `end-after-link`). Each one prints PASS/FAIL
per step with evidence, and they can be re-run against any server on 6310.

Import: 127 pages, 825 journals, 259 referenced pages created, 18,628 blocks, 171 assets, 16.4 s.
The server's startup verify passed (19,839 ops).

## Results

| Feature | Verdict | Evidence |
|---|---|---|
| Journals: today, typing, Enter, Tab/Shift-Tab | works (one low-severity race) | `journal.mjs`: the outline and the server agree at depths [0,1,0]. A zero-delay burst on a brand-new day loses the Tab (see the bugs below). At 60 ms/key the result is correct. |
| Move (Alt+Up/Down), collapse (Mod+Up/Down) | works | The row order changes and changes back. 3 rows → 2 → 3. |
| Multiline (Shift+Enter) | works | The server holds `"sweep three\nsecond line ěščřžýáíé"`. |
| Undo/redo (text and indent) | works | `sweep one UNDOME` → `sweep one` → `sweep one UNDOME`. Undo of an indent restores depth 0. |
| Caret placement in blocks ending in a `[[link]]` | **broken** | `end-after-link.mjs`: both End and a click right of the text put the caret inside the link. See the bugs below. |
| `[[` autocomplete, new page, existing page | works | "New page" row; picking it creates the page. `Baleni` (no diacritics) offers `Balení`. The popup opens in 15 ms. |
| `#tag` | works (by API read; the probe's UI step was spoiled by the caret bug) | The tag page exists. |
| Navigation, linked/unlinked references | works | Clicking the ref navigates. `Balení`: 98 linked, 7 unlinked, opens in 115 ms. |
| Rename page | works | The source block was rewritten to the new name, and the old name still resolves. |
| Tasks: cycle, scheduled, tasks view | works, with a **workflow gap** | null→TODO→DOING→DONE→null. `/scheduled` sets `scheduled`. Tasks view: 81 rows in 184 ms. A LATER task cycles to *nothing* (see the bugs below). |
| Properties | works | `status:: aktivní` becomes a property. |
| ```` ```query ```` fence | works | `LATER` → "72 blocks on 29 pages" in 227 ms. Logseq `{{query}}` renders as raw text (a non-goal, PLAN §2). |
| Templates | works | `/template` offers the owner's "Weekly planning" and inserts 4 blocks. |
| Search (keyword) and Czech | works | 24–180 ms. `rikat` and `říkat` both give 19 results. Semantic search is not configured; the fallback note says so. |
| Command palette, slash menu | works | Mod+K "Balení" in 8 ms, Enter opens it, 26 commands. The slash menu has 19 rows. |
| Delete → Trash → Restore | works | The confirmation is an in-page dialog. Trash row "3 blocks". Restore takes 46 ms and brings the blocks back. |
| History | works | 3 batches shown; Restore returns the block to `v1`. |
| Images / assets | works | Imported PNGs load (naturalWidth 1708 etc.), with no asset 4xx/5xx. |
| Reload persistence | works | The UI and the server agree after a reload. |
| Two contexts, live sync | works | A→B 623 ms, B→A 510 ms. |
| Offline edit, reconnect, converge | works | Converged in 212 ms. An offline edit survived an offline reload. A same-block conflict resolved by last-writer-wins, and the loser was kept as `conflict_copy::`. |
| `nooklet verify` | **OK** | 20,105 ops replayed; 1 rejected op (a client `page.create` that collided with the server-minted ref page, the expected ADR 024 rejection). |
| Markdown mirror | works | The journal, renamed page, sync and task files match the edits. |
| Import → serve on a fresh data dir | **broken** | See the bugs below. |

**Performance (real graph):** cold first load to an interactive today: 1.8 s ("Loading…" before
that). Warm reload: 249 ms. The largest page (OmnivoreSync, 9.4k lines) opens in 1.3 s. Typing
takes 2–5 ms from key to DOM and about 17 ms from insert to frame. Typing 120 characters at full
speed took 252 ms. All pages (407 rows) opens in 98 ms.

## BUGS.md entries to fold in

### Clicking right of a block's text, or pressing End, puts the caret inside a trailing `[[link]]`
**Severity:** high. Typing corrupts the link target and creates junk pages. "… with [[Person]]" is
a very common block shape. Not covered by B-325 or B-585.
**Repro:** seed `- plain text [[Balení]]`. Click in the empty space right of the rendered text and
type `Y`: the result is `plain text [[BalenYí]]`. Click the same block, press Home, then End, then
type `Z`: the result is `plain text [[BaleníZ]]`. A page named `BaleníZ` now exists and shows up in
Mod+K. Blocks that do not end in a link (`[[Inbox]] trailing words`, `text **bold** end`) behave
correctly. Probe: `tools/probes/sweep-core/end-after-link.mjs`. Likely cause: `livePreview.ts`
hides `]]` with `Decoration.replace` while the caret is not touching the link, so End stops before
it, and the click mapping in `caret.ts` lands in the link token. Not confirmed.

### `nooklet import` into a fresh data dir, then `nooklet serve`, crashes: `a graph called "default" already exists`
**Severity:** medium. It blocks first start on a new server if the import comes first. Workaround:
run `serve` once before importing, or write `graphs/default/graph.json` by hand.
**Repro:** `nooklet import <graph> --data $D` on an empty `$D`, then `nooklet serve --data $D`. The
process exits 1. `import` creates `graphs/default/graph.sqlite` but no `graph.json`.
`GraphRegistry.list()` skips directories without one, so `cli.ts:286` calls `create("default")`,
which throws because the db exists. README also still says `~/.nooklet/default`, but the layout is
now `graphs/default`.

### Mod+Enter ignores the owner's LATER/NOW workflow: a LATER task cycles to no marker
**Severity:** medium. The owner's graph has `:preferred-workflow :now`, with 72 LATER, 5 NOW and
0 TODO blocks.
**Repro:** on `- LATER owner style`, press Mod+Enter three times. Markers go `null`, then `TODO`,
then `DOING` (`task-logic.ts#nextCycleMarker`). Logseq goes LATER→NOW→DONE, and a plain block
starts at LATER. Probe: `tasks.mjs`.

### A zero-delay Enter/Tab burst on a brand-new journal day loses the Tab
**Severity:** low. At 60 ms/key the result is correct, but rows flicker for about 1.1 s, showing
`["","ccc"]`.
**Repro:** today is empty. Click today and type `aaa`⏎`bbb`⇥⏎`ccc`⇧⇥ with no delay. The server
gets `aaa`,`bbb`,`ccc`, all at depth 0, instead of `bbb` indented. The same burst on an ordinary
page is correct. Probe: `indent-render.mjs journal fast 0`.

### The word-count plugin returns 500 for a page just deleted
**Severity:** low; it only adds console noise.
**Repro:** delete a page from Page actions. The server log shows
`OpError: no page named "…"` at `plugins/word-count … countPage`, and the browser logs a 500.

### Observations (not logged as bugs)
- Cycling DONE→none leaves the `done::` property in place. It may be intended.
- On a cold replica, today shows "Loading…" for about 1.8 s, and keys typed then go nowhere.
- The sync indicator flips to "offline" only after a push fails. That matches `sync-indicator.spec.ts`.

## Verdict
The basic daily-use loop works on the real graph, including sync, offline handling and Czech text.
Before the test, fix or brief the owner on the caret-inside-trailing-link bug (it silently mangles
links), and on import-before-serve. The LATER/NOW cycling gap will be noticed on day one.
