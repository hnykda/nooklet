# Bug inbox — ref-label-flash (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-510..B-519.

---

### B-500 (existing)

**Fixed 2026-09-13.** Reproduced first with a MutationObserver recorder, identical in Chromium and
WebKit: 5 pulls of an unrelated edit on a page with four `((refs))` put every label back to
`((id))` in 25 of 30 DOM snapshots; typing six characters into another block, 4 of 13. The rows and
ref spans were not remounted — `data/store.ts` emptied the whole label cache
(`block-ref-cache.ts#invalidateBlockRefs`) on every change event naming the `block` table, so every
lookup missed until its re-read answered.

`data/block-ref-cache.ts` is now stale-while-revalidate: a change bumps a generation and re-reads
the ids some live label is showing, in one `IN (…)` query per tick, keeping the old text on screen
until the answer lands; a text that did not change notifies nothing (one signal per id, compared
with `===`), an older answer never overwrites a newer one, a failed re-read keeps the text, and an
id nobody shows is re-read on its next lookup. Tests: `e2e/tests/ref-label-flash.spec.ts` (3,
chromium + webkit; all 3 fail on the old cache), `apps/web/src/data/block-ref-cache.test.ts` (8,
all fail on the old cache).

---

### B-510 · The references panel shows `((id))` for every block reference, never the block's text
**Status:** open · **Severity:** low · **Found:** 2026-09-13, ref-label-flash (recording what a
refresh does to the references panel) · **Test:** none yet

A linked reference whose text contains `((some-block))` shows the raw `((1m2d…))` placeholder in
the references panel, where the outliner row itself shows the referenced block's text. The panel
renders through `InlineContent`, which passes no block-reference resolver.

---

### B-511 · Every refresh rebuilds a query fence's result rows, the references panel's rows, and each row's date chips and property rows
**Status:** open · **Severity:** low (identical content; cost grows with the page) · **Found:**
2026-09-13, ref-label-flash · **Test:** none yet

Nothing visible changes, but the DOM is thrown away and recreated on every refresh (a pull, or a
local write anywhere on the page). Counted with a MutationObserver over 5 pulls of an unrelated
edit on one page: all `.vr-query-hit` elements (10 = 2 hits × 5), every `.reference-item` (5), the
outliner's `.vr-date` chip (5) and `.vr-prop` row (5) were new elements each time. Each list is a
keyed `<For>` over objects rebuilt by the re-read, so equal content still counts as a new item.
Anything stateful inside them (an image, a hover, a text selection in a result) is reset on every
sync.
