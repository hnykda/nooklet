# Bug inbox — impl-export (M8)

Entries in `docs/BUGS.md`'s format, for the coordinator to merge. Numbers B-220..B-229.

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

### B-226 · `views.spec.ts` "opening the palette while editing and closing it hands focus back to the editor" fails at `da85cfb`
**Status:** open (needs-investigation) · **Severity:** medium · **Found:** 2026-09-13, e2e run for
this branch · **Test:** that test

After Cmd/Ctrl+K and Escape the palette closes but `.cm-content` never regains focus
(`toBeFocused` times out at 10 s; the locator resolves, state "inactive"). Failed 6 of 6 runs on
port 6408, Chromium: in a 12-spec batch; in `views.spec.ts` alone; alone with `-g` on this branch;
alone with the title-row controls removed; alone with the page-action commands and print hookup
also removed; and alone with `apps/web/src`, `packages/core/src` and `packages/server/src`
checked out from `da85cfb` (production build, fresh server) — so it is not caused by this branch. The coordinator's full run at `a6c2859` did not list it among
failures, so either `06fd859`/`da85cfb` or the machine's state since then changed something;
neither was checked. B-72's fix names this test. Nothing in `CommandPalette.tsx` restores focus
explicitly, so whatever used to return it to the editor is worth finding first.

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
