# Bug inbox — m9/qafix-m8-views

Entries in BUGS.md's format, for the coordinator to fold in. New numbers B-350..B-359 only.
Source: exploratory QA of the M8 views, routes and phone width on a copy of the owner's graph
(findings Q1–Q6, 2026-09-13).

---

### B-350 · On a phone the page title is cut off after about 12 characters
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, M8 views QA (finding Q1) ·
**Test:** none yet

At 390px (Chromium, `isMobile`, `hasTouch`) `/page/Deciding%20on%20a%20Job` shows "Deciding on a"
and hides "Bike"; `TTRPG/VTM-alpha` and `RPG on Harry Potter theme with Robin` are clipped the same
way. The title input is 164px wide in a 366px row (`scrollWidth` 219 > `clientWidth` 164). The rest
of the row is the empty icon slot (39px, `opacity: 0`), the History link (55px, `opacity: 0`) and the
M8 star and "…" (90px with 44px touch targets). The two invisible controls only appear on `:hover`,
which a touch screen does not have (that half is B-225). At desktop width a 36-character name is
clipped too (`scrollWidth` 451 > `clientWidth` 424): the title is an `<input>`, which cannot wrap.

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

Picked up by B-350 (same title row).
