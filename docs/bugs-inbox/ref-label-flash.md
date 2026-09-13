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
id nobody shows is re-read on its next lookup. Tests, all failing on the old cache and passing in
Chromium and WebKit: `e2e/tests/ref-label-flash.spec.ts` › "block reference labels stay resolved
across refreshes from pulls (B-500)", "… while typing in another block (B-500)", "a refresh
changes nothing on screen but the block that changed, and rebuilds nothing else (B-500, B-511)",
"a label changes when its target's text does, and never passes through ((id)) (B-500)" — each
records every DOM state with a MutationObserver and fails on any snapshot holding an unresolved
`((id))`; `apps/web/src/data/block-ref-cache.test.ts` (8). The webkit project now runs this spec.
Real-graph numbers (per refresh, 150-row page with 50 refs): 2,550 resolver calls → 0, 50 queries
→ 1, 3,206 DOM mutation records → 4 — `docs/progress/ref-label-flash.md` › Measurements.

---

### B-510 · The references panel shows `((id))` for every block reference, never the block's text
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, ref-label-flash (recording what a
refresh does to the references panel) · **Test:** `e2e/tests/ref-label-flash.spec.ts` › "the
references panel shows a block reference's text, not its id (B-510)"

A linked reference whose text contains `((some-block))` shows the raw `((1m2d…))` placeholder in
the references panel, where the outliner row itself shows the referenced block's text. The panel
renders through `InlineContent`, which passes no block-reference resolver.

**Fixed 2026-09-13.** `InlineContent` takes an optional `resolveBlockRef` (a prop, so the
component still imports no replica client); `ReferencesPanel` passes
`block-ref-cache.ts#resolveBlockRef`. The e2e test failed on the B-500 commit (`((1m2d…))`
received) and passes in Chromium and WebKit. Other `InlineContent` callers (search snippets, the
tasks view, the agenda, property values) still show the placeholder — not changed here.

---

### B-511 · Every refresh rebuilds a query fence's result rows, the references panel's rows, and each row's date chips and property rows
**Status:** fixed · **Severity:** low (identical content; cost grows with the page) · **Found:**
2026-09-13, ref-label-flash · **Test:** `e2e/tests/ref-label-flash.spec.ts` › "a refresh changes
nothing on screen but the block that changed, and rebuilds nothing else (B-500, B-511)"

Nothing visible changes, but the DOM is thrown away and recreated on every refresh (a pull, or a
local write anywhere on the page). Counted with a MutationObserver over 5 pulls of an unrelated
edit on one page: all `.vr-query-hit` elements (10 = 2 hits × 5), every `.reference-item` (5), the
outliner's `.vr-date` chip (5) and `.vr-prop` row (5) were new elements each time. Each list is a
keyed `<For>` over objects rebuilt by the re-read, so equal content still counts as a new item.
Anything stateful inside them (an image, a hover, a text selection in a result) is reset on every
sync. On the owner's `OmnivoreSync` page (556 block properties) a single refresh created 856
elements.

**Fixed 2026-09-13.** The four memos feeding those lists compare by value
(`data/same-json.ts#sameJson`, JSON-shaped data only): `DateChips`' chips, `BlockProperties`'
entries (was a plain function), `QueryFenceView`'s `latest`, `ReferencesPanel`'s `data`. Equal data
passes the previous array on, so `<For>` has nothing to diff. The e2e test's mount count failed on
the B-500 commit (`queryHits` 10, `referenceItems` 5, `dateChips` 5, `propRows` 5, `blockRefs` 10)
and is `{}` after, Chromium and WebKit. Not changed: when a query result or a reference really does
change, its lists are still rebuilt whole (they are keyed by object, not by block id).

The per-row half, no DOM involved: every refresh also re-ran each outliner row's marker, priority,
date-chip and property derivations, because `BlockTree`'s per-row `row`/`block` memos handed every
`BlockRowView` a new object. Those memos now compare field by field (`editor/same-fields.ts`, one
level into `properties`; anything uncomparable counts as a change). Measured on the real-graph copy
(`tools/probes/refresh-render-count.mjs`): per-row re-derivations per refresh 252 → 1 on a 252-row
page, and the synchronous tree update 3.3 → 2.2 ms (201 rows 2.9 → 1.5, 150 rows 2.1 → 1.1). Test:
`apps/web/src/editor/same-fields.test.ts` (the comparator); the saving itself is measured, not
asserted by a test. e2e editing/parity/selection/tasks/dates/block-properties/merge/redo/focus/
journal-stream/embeds/page-find/read-only/context-menu + this spec: 156/156.
