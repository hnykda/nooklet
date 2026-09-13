# Bug inbox — m9/render-views

Entries in `docs/BUGS.md`'s format, folded in by the coordinator. New numbers B-320..B-329 only.

### B-224 (existing)
**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("a multi-line block renders each
line on its own line"), `apps/web/src/editor/render/tokens.test.tsx` ("a multi-line paragraph keeps
a <br> at each newline…", "quote -> <blockquote class=vr-quote>, one <br> between its lines")

Cause (read, then confirmed by a failing unit test and a failing e2e): `render/tokens.tsx#BlockContentView`
rendered a paragraph's and a quote's `lines` back to back with no `<br>` between them. The `br`
tokens exist only in `tokenizeContent`'s flat stream (used by `InlineContent`), never in
`classifyBlockContent`'s per-line arrays, which is what every outliner row, query hit, embed and
shelf card renders. It had been that way since the renderer was written (`b957731`); the existing
unit test `quote -> <blockquote class=vr-quote>` asserted the run-together text
`"line oneline two"`, so the defect was codified rather than caught.

**Fixed 2026-09-13.** `tokens.tsx#Lines` renders each line's tokens with a
`<br data-from data-to>` between consecutive lines, the offsets being that newline's own position in
`ctx.source` (read from the source rather than the neighbouring tokens, since an empty line has no
tokens). Heading trailing lines were already one `<p>` each and are unchanged. The e2e seeds the
entry's own two blocks through `page.create` markdown, checks `page.read` stores the `\n`, then
asserts one `<br>` per row and that the second line's first glyph sits below the first line's; it
failed on `cf08d19`'s `tokens.tsx` (`br` count 0) and passes with the fix. The unit tests failed
before (no `<br>`) and pin the offsets `27`/`39`/`40` for `Poznámka: **žluťoučký kůň**\nsecond
line\n\nfourth`.

---

### B-211 (existing)
**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("revealing a block lands on its
row, not on a query result above it"), `apps/web/src/editor/render/render-seams.test.tsx` ("lists
hits grouped by page with a count…")

Reproduced in a browser before fixing (Chromium, production build, `cf08d19`'s
`QueryFenceView.tsx`): a page whose first block is a ```` ```query TODO tag:rvreveal ```` fence
and whose third is the matching task. Shelving the page, switching the card to its outline and
clicking the task's entry put `shelf-reveal-target` on the `li.vr-query-hit` and never on the
task's `.vr-row`; `document.querySelectorAll('[data-block-id=<id>]')` returned
`["vr-query-hit", "vr-row"]`, in that order.

**Fixed 2026-09-13.** `QueryFenceView.tsx#HitView` marks a result `data-query-hit-id`, the way
embedded rows already use `data-embed-block-id`, so `[data-block-id]` only ever names outliner
rows. The e2e asserts that invariant for the task's id and then runs the real shelf-outline reveal;
both parts failed on the old file (the invariant with the two-element list above, the reveal with
the row's class never gaining `shelf-reveal-target`) and pass with the fix. The component test now
also asserts no `[data-block-id]` inside a rendered query. Moving hits off the attribute changed
what `PluginFence` finds for a fence inside a result — handled with B-320.

---

### B-320 · A plugin-drawn fence inside an embedded block is handed the host block, not its own
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `PluginFence.tsx`
while fixing B-211 · **Test:** `apps/web/src/editor/render/PluginFence.test.tsx` ("a fence inside
an embedded row / a query result is handed that block, not the host row's")

Not reproduced in a browser — found by reading. `render/PluginFence.tsx#fenceContext` finds the
fence's block as `el.closest("[data-block-id]")`. An embedded row (`EmbedView.tsx`) deliberately
carries `data-embed-block-id` instead, so a ```` ```mermaid ```` fence inside an `{{embed}}`
walks past its own row to the outliner row that holds the embed, and the renderer's
`RenderInfo.block`/`page` describe the host block and page. The B-211 fix moves query hits off
`data-block-id` too, which would give fences inside query results the same wrong answer (today they
get the right one, by the very attribute that causes B-211).

**Fixed 2026-09-13.** `fenceContext` looks for the nearest
`[data-query-hit-id], [data-embed-block-id], [data-block-id]` and reads whichever of the three the
match carries. The component test renders a fence inside an `li` carrying each inner attribute,
inside a `[data-block-id]` host: the embed case failed before (renderer got `bhost000000001`);
both pass. Not checked in a browser with a real mermaid plugin inside an embed —
`e2e/tests/plugins.spec.ts` (outliner rows only) still passes.

---

### B-321 · A journal agenda item carries `data-block-id`, so reveal and the agent flash can land on it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, `grep data-block-id` while
fixing B-211 · **Test:** `apps/web/src/views/JournalAgenda.test.tsx` ("a row click navigates to
the task, a heading click to its page")

Same trap as B-211. `views/JournalAgenda.tsx#EntryRow` puts `data-block-id="<task id>"` on each
`li.journal-agenda-item`. On the journal stream (`JournalStreamView.tsx`) Today's agenda is
rendered after Today's outline and before every older day's, so a task written on an older day and
scheduled for today appears in document order before its real row: `shell/Shelf.tsx#revealOnPage`
and `live/RemoteFlashOverlay.tsx#findBlockRow` (`document.querySelector('[data-block-id=…]')`)
pick the agenda entry. Nothing reads the attribute on the agenda item.

**Fixed 2026-09-13.** The item is marked `data-agenda-block-id`. The component test asserts no
`[data-block-id]` in the rendered agenda (failed before) and the new attribute's value. Believed
rather than browser-verified for the stream ordering itself: no e2e seeds a task on an older journal
day scheduled for today (journal-day offsets are shared across specs), and the agent flash has no
browser-side trigger short of a plugin; `e2e/tests/journal-agenda.spec.ts` still passes (6/6).

---

### B-225 (existing)
**Status:** in progress · **Test:** —

---

### B-200 (existing)
**Status:** in progress · **Test:** —

---

### B-171 (existing)
**Status:** in progress · **Test:** —

---
