# Bugs inbox — impl-commands (m8)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. Existing bugs are marked
"(existing)"; new ones use B-160..B-169.

---

### B-97 (existing) · "Collapse all" and "Expand all" do nothing
**Status:** in progress · **Severity:** medium · **Found:** 2026-09-12, exposure audit

---

### B-98 (existing) · "Open plugin manager" leads to a blank page
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, exposure audit

---

### B-105 (existing) · Argument-only commands show as palette rows that do nothing
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, exposure audit

---

### B-106 (existing) · Comment and spec drift around commands
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, exposure audit

---

### B-160 · The shelf is reachable only by Shift+click
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md` §1.4, §1.10 #15, §2 item 6) · **Test:** —

Nothing in the palette, the bullet context menu or the page switcher puts a block or a page on the
shelf; the only way in is a Shift+click on a bullet or a `[[link]]`, which nothing on screen
mentions. A keyboard user cannot shelve anything at all.
