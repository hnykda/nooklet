# Bugs inbox — impl-embeds

Entries in `docs/BUGS.md` format, to be merged by the coordinator. Numbers from B-210..B-219.

---

### B-210 · `{{embed [[Page]]}}` and `{{embed ((id))}}` show a box with the target's name, never its content
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md` §1.9 and §2 item 8) · **Tests:** `e2e/tests/embeds.spec.ts`
(nine tests, from "a block embed shows the block and its children, read-only, root unfolded" to
"an embed of a block that does not exist says so", including "on the shelf, a self-embedding block
shows the notice rather than a copy of its page"); `apps/web/src/editor/render/embed.test.tsx`;
`apps/web/src/editor/render/embedRows.test.ts`; `apps/web/src/data/embeds.test.ts`

Write `{{embed ((id))}}` in a block (or pick "Embed block" from the slash menu): the rendered
block is a dashed box reading `Embed: ((1m287mdbkcaggj))` — the id, not the embedded block or its
children. `{{embed [[Page]]}}` likewise reads `Embed: [[Page]]`. The owner's graph has six embeds,
each a journal day carrying forward an earlier day's task list (6–60 blocks); every one of them
reads as an opaque id. `editor/render/tokens.tsx#EmbedView` is a placeholder with no data seam
behind it (its header lists it under "Known gaps"), and `docs/spec/markdown-grammar.md` §4 promises
the target's blocks.

**Fixed 2026-09-13.** Read-only, as the audit proposed; editable transclusion is not built.
`data/embeds.ts#loadEmbed` reads the target through the worker's `getPageTree` (a block embed finds
its node in its page's tree; a page resolves by key, then by journal day), `useEmbed` re-reads on any
page/block/block_prop change and never rejects. `editor/render/EmbedView.tsx`, lazy behind its own
Suspense in `tokens.tsx`, renders an outline: a row click navigates to the block (Shift shelves it),
the source line opens the page, a click on the frame still edits the host. The embedded root always
shows its children (two of the owner's five working embeds point at a block collapsed on its own
day); deeper collapsed blocks stay folded with a view-local toggle; 250 rows at most. Termination:
`MAX_REF_DEPTH` (2, shared with block refs) and `RenderCtx.embedPath` — `BlockRowView` passes the row's
id (so does the shelf's `ShelfOutline`, whose card otherwise painted the page inside itself once —
seen failing with 2 rows before that line), each embedded row adds its own, and an embed whose
target tree contains one of them shows a notice (`embedRows.ts#embedReachesPath`). Rows carry `data-embed-block-id`, not `data-block-id`
(see B-211). On a copy of the owner's graph (`tools/probes/embeds-real-graph.mjs`) all five
well-formed embeds render (6, 12, 27, 27 and 31 rows, no page errors); the sixth, written
`{{embed ((id))}` with one closing brace, is not an embed to the tokenizer and still renders as text
plus a block reference. The e2e tests would have caught it: on `da85cfb` there is no `.vr-embed-item`.

---

### B-211 · A ```` ```query ```` result on the same page can be scrolled to instead of the real row
**Status:** open · **Severity:** low · **Found:** 2026-09-13, reading `data-block-id` users while
building embeds · **Test:** —

Not reproduced in a browser — found by reading. `render/QueryFenceView.tsx#HitView` puts
`data-block-id="<id>"` on every result row, the same attribute the outliner's rows carry
(`BlockRowView.tsx`). `shell/Shelf.tsx#revealOnPage` and `live/RemoteFlashOverlay.tsx` both find a
row with `document.querySelector('[data-block-id="…"]')`, which returns the first match in document
order. A query block above its own results on the same page (a page of tasks with a
`TODO` query at the top) therefore makes "reveal this block" from the shelf outline, and an agent's
change flash, land on the result inside the query instead of on the block. Fix: a distinct
attribute on hits (`data-query-hit-id`), as embedded rows use `data-embed-block-id`.

---

### B-212 · A finished task inside a query result strikes through the whole query block
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, rendering the owner's embeds on a
copy of the real graph · **Test:** `e2e/tests/embeds.spec.ts` "a finished task inside an embed or a
query result does not strike through its host (B-212)"

A ```` ```query ```` block whose results include a DONE or CANCELED task renders struck through
and dimmed from its first line to its last — the query text, the count, every open result. The
same happened to the new embeds on the owner's 2024-09-29 journal: one checked item in the
embedded list struck through the source line and every open item around it. The rule is
`editor/editor.css` `.vr-row:has(.vr-marker-DONE) .vr-block-view`: `:has()` with a descendant
combinator matches a marker anywhere inside the row, including the rendered results and embedded
rows nested in its content, not just the row's own marker pill. `shell/shelf.css`
`.shelf-block:has(.vr-marker-DONE) .shelf-block-text` has the same shape (a shelved block holding
an embed or a query).

**Fixed 2026-09-13.** Both rules now look only at the block's own marker through child combinators:
`.vr-row:has(> .vr-row-main > .vr-marker-DONE) .vr-block-view` and
`.shelf-block:has(> .shelf-marker.vr-marker-DONE) .shelf-block-text` (CANCELED likewise). The test
reads computed `text-decoration-line` on the host row of an embed, the host row of a query, and a
shelf card holding the embed; before the fix each of the three read `line-through` (checked one at a
time by reordering/reverting), after it `none`, while the finished item itself is still struck.
`tasks.spec.ts`'s own-marker strike test still passes.

---

### B-213 · e2e "opening the palette while editing and closing it hands focus back to the editor" fails at `da85cfb`
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, running neighbouring specs for
embeds · **Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it hands
focus back to the editor" (the failing test itself)

Not diagnosed. On port 6407 the test failed three runs out of three: twice on `m8/impl-embeds`, and
once with every existing web file this branch modifies checked out at `da85cfb` (its new modules
then unreferenced; client rebuilt by the run) — so it is not the embeds work. It fails at `expect(editor(page)).toBeFocused()` after Escape
closes the palette: `.cm-content` is still in the DOM but "inactive" for the full 10 s, so typing
afterwards would go nowhere — the B-72 symptom that test was written for. The other 118 tests in
journals/selection/context-menu/navigation/focus/phone/tasks/views passed in the same run.

---

### B-214 · Typing anywhere on a page collapses its embeds to the placeholder and back, and resets their expand toggles
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-embeds` on a copy of the owner's graph · **Test:** `e2e/tests/embeds.spec.ts` "typing
elsewhere on the page leaves an embed in place, unfolded rows included (B-214)"

On the owner's 2024-09-29 journal (an embed of 27 rows), one keystroke in the day's first block
made the embed's host row measure 775 → 51 → 775 → 51 → 775 px (a `ResizeObserver` on the row):
the embed is torn down and rebuilt twice per keystroke, and each rebuild shows the one-line
"Embed: ((id))" Suspense fallback until the new resource's first read lands. Typing in a block
*below* an embed (a page with `{{embed [[2024-09-29]]}}` above it) moved the editor on screen
between y=309, 875 and 1233 while typing six characters. A row unfolded with the embed's own toggle
folds again on the next keystroke anywhere on the page. Probes:
`impl-embeds-verify/probe-remount2.mjs`, `probe-flash.mjs`, `probe-toggle.mjs` (scratch).

Cause (verified by tagging DOM nodes): `BlockTree` hands every row a new `block` object whenever the
page tree re-reads (every write), and `BlockRowView`'s `content` memo and its `ctx.source` both read
`props.block.content` — so the row's `.vr-block-view` survives but everything rendered inside it is
rebuilt, including a fresh `EmbedView` whose `useEmbed` resource starts unresolved and suspends. The
same rebuild is what makes a ```` ```query ```` block flicker 78 → 45 → 78 px (pre-existing, same
cause); for plain text it was invisible.

**Fixed 2026-09-13.** `BlockRowView` memoizes `props.block.content` as a string and both the
classification and `ctx.source` read that memo, so the rendered view is rebuilt only when the row's
text changes. The e2e test (an unfolded embedded row, a tag on the outline element, the host row's
minimum height) failed before the change — "about the car" folded away — and passes after. Re-run
on the graph copy: the embed row's height stays 775 / 942 px through typing, the editor stays at one
y, the unfolded row stays open, and the query block's 78 → 45 px flicker is gone with it.

---

### B-215 · Shift+click on an embedded row shelves a card that says "This block is gone."
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-embeds` (reading `BlockTree.tsx#onShelfOpen`, then reproduced in Chromium) · **Test:**
`e2e/tests/embeds.spec.ts` "Shift+click on an embedded row shelves that block, from its own page
(B-215)"

B-210's summary promises "Shift+click puts it on the shelf". `EmbedRow` calls
`ctx.onShelfOpen({ kind: "block", id })`, and the only provider, `BlockTree.tsx#onShelfOpen`, fills
in the page id as `props.pageId` — the page the tree is showing, which for an embedded row is the
HOST page, not the page the block lives on. `Shelf.tsx#BlockCard` then reads the host page's tree,
does not find the block, and the card is titled with the host page and reads "This block is gone."
(seen in the e2e test: `" Embed Host Shelf RowThis block is gone."`). The component test only
checked the call's `{ kind, id }` against a mock, so it passed.

