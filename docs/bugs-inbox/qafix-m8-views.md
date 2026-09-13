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
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q2) ·
**Test:** none yet

Right-click a row at y≈520 of a 900px window (or long-press one at y≈490 of an 844px phone): the
menu's top is 536 and its bottom 1047, so "Move to page…" and the "Created … · Edited …" line are
below the window, and the menu has no scroll to reach them. `BlockContextMenu.tsx` clamps its top
to `innerHeight - 320`, a height the menu had before M8 added "Open on shelf" and the timestamps
footer; it is now 511–542px.

---

### B-352 · A phone without a keyboard cannot open the command palette
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q3) ·
**Test:** none yet

At 390px with touch, no control in the top bar, sidebar drawer, page "…" menu, editing toolbar or
Help menu opens `.cmd-palette`; only Cmd/Ctrl+K does. So everything that exists only as a palette
command is out of reach on a phone: Random page, Collapse all / Expand all, Open this page on the
shelf, and every other command without a button.

---

### B-353 · Clearing the search box leaves the previous results on screen, under any filter chosen next
**Status:** open · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q4) ·
**Test:** none yet

Search "zaplatit" (49 results), clear the box: "Type to search." shows, and so do "49 results" and
all 49 rows. Choosing Task = LATER then leaves the same 49 rows (DONE and unmarked blocks among
them) under a filter they do not satisfy. A reload clears it.

---

### B-354 · Search hits and Find & Replace groups name journal days by their ISO storage name
**Status:** open · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q5) ·
**Test:** none yet

With the journal title format `E, dd.MM.yyyy`, a search hit reads "2024-09-22 › todo" and a Find &
Replace group "2022-12-16", while the agenda and tagged-pages lists on the same screens say "Sun,
22.09.2024". ADR 018: every place that shows a page name to a person goes through the display name.

---

### B-355 · The Search filters put Task / Show / Journals only between "Updated after" and "Updated before"
**Status:** open · **Severity:** low · **Found:** 2026-09-13, M8 views QA (finding Q6) ·
**Test:** none yet

Filter order is Tag, Namespace, Updated after, Task, Show, Journals only, Updated before, so the
two halves of one date range are split (about 430px apart at 390px wide).

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

### B-356 · `page-icons.spec.ts` "clearing the field removes the icon" reads the server before the clear has synced
**Status:** open · **Severity:** low (test harness) · **Found:** 2026-09-13, qafix-m8-views, running
nearby specs under load · **Test:** the spec itself

In an 11-spec run (7 minutes, shared machine) the test failed with `expect(received).toBeUndefined()
— Received: "🇨🇿"`: the title row already showed the empty icon slot, and the `page.read` right after
it still returned the old icon. The spec reads the API once instead of polling, so it races the
client's push. Passed on an immediate rerun (3/3). Fix: `expect.poll` around the `page.read`. Not
changed here (outside this branch's findings).
