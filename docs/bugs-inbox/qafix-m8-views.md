# Bug inbox — m9/qafix-m8-views

Entries in BUGS.md's format, for the coordinator to fold in. New numbers B-350..B-359 only.
Source: exploratory QA of the M8 views, routes and phone width on a copy of the owner's graph
(findings Q1–Q6, 2026-09-13).

---

### B-350 · On a phone the page title is cut off after about 12 characters
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q1) ·
**Test:** `e2e/tests/page-title-fit.spec.ts`

At 390px (Chromium, `isMobile`, `hasTouch`) `/page/Deciding%20on%20a%20Job` shows "Deciding on a"
and hides "Bike"; `TTRPG/VTM-alpha` and `RPG on Harry Potter theme with Robin` are clipped the same
way. The title input is 164px wide in a 366px row (`scrollWidth` 219 > `clientWidth` 164). The rest
of the row is the empty icon slot (39px, `opacity: 0`), the History link (55px, `opacity: 0`) and the
M8 star and "…" (90px with 44px touch targets). The two invisible controls only appear on `:hover`,
which a touch screen does not have (that half is B-225). At desktop width a 36-character name is
clipped too (`scrollWidth` 451 > `clientWidth` 424): the title is an `<input>`, which cannot wrap.

**Fixed 2026-09-13.** Two causes, two changes. (1) The title is a one-row `<textarea>` that grows
to its value (`views/PageTitleField.tsx`, hooked into `PageView.tsx`): a long name wraps at any
width, Enter still commits and never inserts a break, a pasted line break becomes a space, and the
height is re-measured when the value or the field's width changes. (2) Under `(hover: none)` the
empty icon slot and the History link leave the row (`views/page-title.css`), and the "…" menu
gains "Add icon"/"Change icon" and "Page history" (B-225). The row's controls now sit on the
title's first line (`align-items: flex-start` plus a first-line centring margin). `print.css` and
two specs that named `input.page-title-input` now name the textarea. Real graph copy at 390px:
"Deciding on a Bike" and "TTRPG/VTM-alpha" one line in a 270px field (was 164px, clipped),
"RPG on Harry Potter theme with Robin" two lines, the 76-character `hls__The_Design_of_…` name five
lines, none clipped; at 1400px the same four fit (1, 1, 2, 3 lines). Test that would have caught it:
`e2e/tests/page-title-fit.spec.ts` — the four fit/menu tests failed before the change (`clippedX:
true`, no "Add icon" item); the fifth (Enter renames, no line break) guards the textarea swap.

---

### B-351 · The block context menu opens partly off-screen in the lower half of the window
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q2) ·
**Test:** `e2e/tests/context-menu-placement.spec.ts`, `apps/web/src/app/menu-placement.test.ts`

Right-click a row at y≈520 of a 900px window (or long-press one at y≈490 of an 844px phone): the
menu's top is 536 and its bottom 1047, so "Move to page…" and the "Created … · Edited …" line are
below the window, and the menu has no scroll to reach them. `BlockContextMenu.tsx` clamps its top
to `innerHeight - 320`, a height the menu had before M8 added "Open on shelf" and the timestamps
footer; it is now 511–542px.

**Fixed 2026-09-13.** The menu is placed from its measured size (`app/menu-placement.ts#placeMenu`,
a `ResizeObserver` in `BlockContextMenu.tsx`, so the late footer re-places it): downward from the
pointer when it fits, else upward from it, else pinned to the bottom margin; shifted left to stay
on screen; `max-height` plus `overflow-y: auto` when the window is shorter than the menu. The
bottom edge is the phone's keyboard toolbar when one is showing (`usableViewport`): a first version
that used the window's height still put "Move to page…" and the footer under the 44px toolbar
(z-index 900) on a long-press at 0.55 of an 844px screen — seen in a real-graph screenshot, then
reproduced by the e2e test once it measured against the toolbar's top. Real graph `/page/TODO`:
desktop presses at y=272/522/740 give bottoms 798/537/755 of 900; phone long-presses at
y=267/486/704 give 791/791/720 above the toolbar at 799; footer and "Move to page…" on screen in
all six. Tests that would have caught it: `e2e/tests/context-menu-placement.spec.ts` (7; five
failed before the change, e.g. bottom 1040 > 900, and two phone cases failed against the
window-height-only version, bottom 836 > 799) and `apps/web/src/app/menu-placement.test.ts` (8).
Not verified: a real iPhone with the on-screen keyboard open (the toolbar's top is taken as the
keyboard's top; placement is computed when the menu's size changes, not when the keyboard moves).
Pre-existing, not touched: biome's `useSemanticElements` error on the menu's `role="separator"`
div (present at `cf08d19`).

---

### B-352 · A phone without a keyboard cannot open the command palette
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q3) ·
**Test:** `e2e/tests/phone-palette.spec.ts`

At 390px with touch, no control in the top bar, sidebar drawer, page "…" menu, editing toolbar or
Help menu opens `.cmd-palette`; only Cmd/Ctrl+K does. So everything that exists only as a palette
command is out of reach on a phone: Random page, Collapse all / Expand all, Open this page on the
shelf, and every other command without a button.

**Fixed 2026-09-13.** A "⌘ Command palette" row at the top of the sidebar — the drawer, on a
phone — on every device (`shell/PaletteButton.tsx`, `palette-button.css`, two lines in
`Sidebar.tsx`). It runs `palette.open` through `exec`, like the key; where there is a keyboard it
shows the live binding. In drawer mode (`max-width: 44rem`) it closes the drawer first, so the
drawer does not sit over what the command does next.

Tried first and dropped: a ⌘ icon in the top bar. On the owner's graph at 390px the bar already
holds the word count and the "Agents can see this window" badge; one more icon shrank every icon
button from 26px to its 18px glyph and, once that was stopped, pushed the badge to a third line
(53px in a 44px bar). Reclaiming gaps and padding kept the badge at two lines only by truncating the
word count ("2527 …") or by pixel-tuning against badge text that changes with its state and the
device's font. The sidebar has room and is where a phone user goes to get anywhere.

Opening it while editing ends the edit (the drawer toggle is a press outside the outline,
`BlockTree.tsx`), so block-level commands are not offered from it — the long-press menu has those;
page-level ones are. Real graph copy at 390px (`/page/TODO`): the row first in the drawer, drawer
closed after, Collapse all 111 → 41 rows, Expand all back to 111, Open a random page (TODO → "RPG on
Harry Potter theme with Robin"), all by tap. Tests that would have caught it:
`e2e/tests/phone-palette.spec.ts` (5; all five failed with the `Sidebar.tsx` hookup commented out).

---

### B-353 · Clearing the search box leaves the previous results on screen, under any filter chosen next
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q4) ·
**Test:** `e2e/tests/search-cleared.spec.ts`

Search "zaplatit" (49 results), clear the box: "Type to search." shows, and so do "49 results" and
all 49 rows. Choosing Task = LATER then leaves the same 49 rows (DONE and unmarked blocks among
them) under a filter they do not satisfy. A reload clears it.

**Fixed 2026-09-13.** Cause: with an empty query `SearchView`'s source memo is `undefined`, so no
search runs, and a Solid resource whose source goes `undefined` keeps its last value; the list read
that value unconditionally. `safeResults()` (and the error line) now also require a query
(`views/SearchView.tsx`). Real graph copy: typed 49 results; cleared → hint only, 0 rows; cleared +
LATER → hint only, 0 rows; typing again under LATER → 2 results. Test that would have caught it:
`e2e/tests/search-cleared.spec.ts` (failed before: 1 summary where 0 expected).

---

### B-354 · Search hits and Find & Replace groups name journal days by their ISO storage name
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q5) ·
**Test:** `e2e/tests/journal-display-names.spec.ts`

With the journal title format `E, dd.MM.yyyy`, a search hit reads "2024-09-22 › todo" and a Find &
Replace group "2022-12-16", while the agenda and tagged-pages lists on the same screens say "Sun,
22.09.2024". ADR 018: every place that shows a page name to a person goes through the display name.

**Fixed 2026-09-13.** Both render `data/page-title.ts#displayRefName(name)` (the hit and the match
carry only a name, which is the case that function exists for) in `views/SearchView.tsx` and
`views/FindReplaceView.tsx`; navigation still uses the stored name. Real graph copy: hits read
"Sun, 22.09.2024 › todo › zaplatit zalohu na delnase", replace groups "Fri, 16.12.2022". Tests that
would have caught it: `e2e/tests/journal-display-names.spec.ts` — the search test failed before
(received `["2026-08-13", "Journal Names Plain Page"]`), and the replace test failed with only
`SearchView.tsx` fixed.

---

### B-355 · The Search filters put Task / Show / Journals only between "Updated after" and "Updated before"
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q6) ·
**Test:** `apps/web/src/views/SearchView.test.tsx` "keeps Updated after and Updated before next to
each other, as the one range they are"

Filter order is Tag, Namespace, Updated after, Task, Show, Journals only, Updated before, so the
two halves of one date range are split (about 430px apart at 390px wide).

**Fixed 2026-09-13.** "Updated before" moved to straight after "Updated after" in
`views/SearchView.tsx` (the M8 selects had been inserted between them, `03cb6ef`). Order now Tag,
Namespace, Updated after, Updated before, Task, Show, Journals only. Real graph copy: the two date
labels 61px apart at 390px and at 1400px (the panel is one column at both). Test that would have
caught it: the named component test (failed before: the label after "Updated after" was "Task").
A DOM-order check, so a unit test is the honest level; the e2e search specs
(`search-filters`, `search-cleared`, `journal-display-names`) still pass over the reordered panel.

---

### B-225 (existing)

**Fixed 2026-09-13.** With B-350: on a screen without hover (`@media (hover: none)`) the History
link and the empty icon slot are `display: none` instead of invisible tap targets taking ~94px of
the title row, and the page "…" menu (`views/PageActions.tsx`) carries "Add icon" / "Change icon"
(opens the row's own icon editor through `PageIcon.tsx#requestPageIconEdit`) and "Page history" on
every device. Test that would have caught it: `e2e/tests/page-title-fit.spec.ts` "a 17-character
name fits on one line: the hover-only controls take no room" and "the page's history and a new icon
are in the … menu instead" (both failed before).

---

### B-161 (existing) — seen failing here, not caused by this branch

`e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands focus back to
the editor" failed 8 times in a row on port 6461 around 12:00 (load average ≈15): in a 12-spec run,
alone, `--repeat-each 4`, and `--repeat-each 2` twice — the last with every app file this branch
changes (`PageView.tsx`, `PageActions.tsx`, `PageIcon.tsx`, `print.css`, `BlockContextMenu.tsx`,
`context-menu.css`, `Sidebar.tsx`) restored to `cf08d19`. It had passed on this branch an hour
earlier. Another m9 branch carries a fix (`d69414f`, "the palette gives focus back when it closes;
a late frame no longer steals it (B-161, B-290)").

---

### B-356 · `page-icons.spec.ts` "clearing the field removes the icon" reads the server before the clear has synced
**Status:** open · **Severity:** low (test harness) · **Found:** 2026-09-13, qafix-m8-views, running
nearby specs under load · **Test:** the spec itself

In an 11-spec run (7 minutes, shared machine) the test failed with `expect(received).toBeUndefined()
— Received: "🇨🇿"`: the title row already showed the empty icon slot, and the `page.read` right after
it still returned the old icon. The spec reads the API once instead of polling, so it races the
client's push. Passed on an immediate rerun (3/3). Fix: `expect.poll` around the `page.read`. Not
changed here (outside this branch's findings).
