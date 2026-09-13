# Bug inbox — impl-export (M8)

Entries in `docs/BUGS.md`'s format, for the coordinator to merge. Numbers B-220..B-229.

---

### B-220 · A page cannot be copied or exported as markdown from the app
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, exposure audit §2 #9 · **Test:**
pending

Portability is the #1 reason people leave Logseq (research/13 §3.5) and the markdown mirror is
nooklet's answer — but inside the app there is no way to get a page's text out. `block.copySelection`
copies selected blocks only; `nooklet export` and the mirror directory are server-side and
invisible to a person in the browser or on a phone. No palette command, no control on the page.

---

### B-221 · Printing a page prints the app chrome and silently drops collapsed children
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, exposure audit §2 #10 · **Test:**
pending

There is no print stylesheet and no print command. Cmd/Ctrl+P prints the top bar, the sidebar,
the shelf and the help button around the page, and a collapsed block's children are not in the
DOM at all (`editor/tree.ts#flattenVisible` skips them), so a printed or PDF'd page loses content
with no mark that anything is missing.

---

### B-222 · Favourites can only be set from /pages; the sidebar's recent list is labelled "Pages"
**Status:** open · **Severity:** low · **Found:** 2026-09-13, exposure audit §1.7 and §2 #13 ·
**Test:** pending

The only favourite control is the star column in `views/AllPagesView.tsx`. The page itself and
the palette have none, so on a fresh graph the sidebar's Favourites section never appears and
nothing hints that it could. The sidebar section under it is titled "Pages" but lists the twelve
most recently edited pages — a second "Pages" right under the nav link of the same name that
opens the full list.

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
