# Bugs inbox — impl-embeds

Entries in `docs/BUGS.md` format, to be merged by the coordinator. Numbers from B-210..B-219.

---

### B-210 · `{{embed [[Page]]}}` and `{{embed ((id))}}` show a box with the target's name, never its content
**Status:** open · **Severity:** medium · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md` §1.9 and §2 item 8) · **Test:** —

Write `{{embed ((id))}}` in a block (or pick "Embed block" from the slash menu): the rendered
block is a dashed box reading `Embed: ((1m287mdbkcaggj))` — the id, not the embedded block or its
children. `{{embed [[Page]]}}` likewise reads `Embed: [[Page]]`. The owner's graph has six embeds,
each a journal day carrying forward an earlier day's task list (6–60 blocks); every one of them
reads as an opaque id. `editor/render/tokens.tsx#EmbedView` is a placeholder with no data seam
behind it (its header lists it under "Known gaps"), and `docs/spec/markdown-grammar.md` §4 promises
the target's blocks.

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
