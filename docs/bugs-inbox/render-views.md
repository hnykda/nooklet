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
**Status:** in progress · **Test:** —

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
