# tables-images — B-702 (tables) and B-703 (image boxes), 2026-10-04

Branch: the agent's own worktree branch, based on `6d56c8f`. Not merged, not pushed.

## Status

**Done.** One commit (see `git log`), then nothing in flight. Coordinator: fold the section at
the bottom into BUGS.md.

## B-702 — a leading-pipe table rendered every cell as `|`

**Cause.** `classifyTables` (was `classifyTable`, `packages/core/src/tokens.ts`) tokenized each
cell with `tokenizeLine(cell)` at offset 0. Every inline token is an offset into the block's whole
`content`, and the renderer slices `content` with them, so each cell showed `content[0..len]` —
the leading `|` for `| a | b |`; the no-pipe form only looked right because its first cell happens
to start at 0. The corpus case 48 expectation had the wrong offsets written into it, and the
renderer test checked structure only.

**Second cause, found on the real graph.** Every table in the owner's graph (4 of 4) sits in a
block whose first line is prose, then a blank line, then the table. The classifier only knew a
table that starts on line 1, so all four rendered as a paragraph of pipes even with offsets fixed.

**Fix.**
- Cells keep their offset in the line; rows are tokenized at the line's base offset.
- GFM rules: outer pipes optional, `\|` inside a cell is a literal pipe, alignment colons, ragged
  body rows padded/truncated (rendering only; the stored text is untouched), table ends at a blank
  line or a pipe-less line.
- New `BlockContent` kind `mixed` (`parts`: paragraph and table, in order; a paragraph part carries
  `firstLine` so the renderer's `<br>` offsets stay right). Blank lines that only separate prose
  from a table are not rendered. `tokenizeContent` of a `mixed` block is the old paragraph stream,
  so search hits / backlinks / block-ref previews read as before. Spec: CLS-T and CLS-T-mixed in
  `docs/spec/markdown-grammar.md`, the `BlockContent` type, the rendering table, corpus case 50.
- Consumers updated: renderer (`mixed` renders each part), shelf outline, live preview (prose parts
  of a `mixed` block get the usual marker hiding; table lines stay raw while editing, as before).

**Mirror.** Already lossless for tables; now pinned: `export.test.ts` "reads back GFM tables exactly
as written" (outer pipes, alignment, `\|`, ragged rows, prose+table, a task with properties).
Caveats, not fixed (logged below): a no-outer-pipe delimiter written `- | -` is B-470's shape; a
table-first block's `^id`, and any properties, land on/after the header line in the mirror.

**Real graph (counts only, `parseOutline` + `classifyBlockContent` over every page):** 4 blocks with
a delimiter-looking line; 4 tables, all `mixed` (prose + blank + table); 2 with 3 columns, 1 with 2,
1 with 5; 17 body rows; 5 empty cells; 0 alignment colons; 0 escaped pipes; 3 tables with `**bold**`
in cells; 0 cells rendering a bare pipe; 0 delimiter-looking blocks left unclassified. Before the
fix: 0 of 4 rendered as a table.

**Tests.** `tokens.test.ts` CLS-T block (B-702 offsets with/without outer pipes, inline markup,
escaped pipe, ragged, prose+table, trailing blank); corpus 48 (offsets corrected) and new 50;
`tokens.test.tsx` "B-702: a leading-pipe table renders each cell's own text…" and "prose then a
table"; e2e `tables.spec.ts` (render: leading pipes, alignment via computed style, escaped pipe,
wikilink in a cell, prose+table, no-pipe form; edit: enter/leave unchanged, type into a cell →
exact text written back).

## B-703 — images had no reserved size

**Cause.** `<img loading="lazy">` with no size is 0×0 until loaded; the server never recorded
sizes (the `asset.width/height` columns existed since M1 but were never written).

**Fix.**
- `packages/server/src/assets/image-size.ts`: header parser for PNG, GIF, WebP (VP8/VP8L/VP8X) and
  JPEG (marker walk to SOFn, skipping DHT/JPG/DAC); EXIF orientation 5-8 swaps width/height, since
  browsers display rotated. No dependency.
- `storeAssetBytes` (upload AND Logseq import) records width/height; a dedupe hit fills a missing
  size from the bytes in hand. `asset.upload` returns `width`/`height`.
- New op `asset.sizes` (HTTP-only, `read`, ≤500 ids) → `{assets: [{id, width, height}]}`.
- **Backfill: lazily, on the first `asset.sizes` read** (`assetSizes`), writing the size back.
  Not a migration: no schema change is needed (columns exist), and a startup migration would open
  every asset file of every graph before the server answers, for rows mostly nobody views soon. On
  the real graph's import: 171 assets, 143 images, all sized from files in 14 ms total; the 28
  non-images stay NULL (re-probed only if they have an image extension). Header reads are 64 KB,
  then 1 MB, then the whole file.
- Client: `apps/web/src/data/asset-sizes.ts` (batched per tick, per-id signals, kept in memory and
  `localStorage` — ids name immutable bytes, so sizes never go stale). `ImageView` in
  `render/tokens.tsx` sets `width`/`height` attributes and an inline
  `width: min(100%, Wpx, calc(70vh * W / H)); aspect-ratio: W / H` — the size B-682's rules give
  the loaded picture (scale down, never up, keep aspect). Inline because the stylesheet's
  `width: auto` beats a `width` attribute and is 0 before load.

**Verification.** Probe `tools/probes/image-size/compare-sips.ts`: real graph's 147 image files
(128 PNG, 17 JPEG, 2 WebP) 147/147 agree with `sips`; synthetic set 12/12 (+1 that sips cannot
read, `file` agrees with us). Import of the real graph: 143/143 images sized. Tests:
`image-size.test.ts` (each format, EXIF orientation II/MM, truncation never throws, >64 KB APP
segments), `asset-upload.http.test.ts` "B-703: image sizes" (4), `image-size.test.tsx` (3),
e2e `image-layout.spec.ts` (desktop + 390px + small image; Chromium and WebKit) — red without the
client fix: the row below moved 396 px (desktop) / 224 px (phone width) when the held image loaded.

## Verification (final)

- `pnpm -r test`: core 491, plugin-api 17, server 847, web 1642 — all passed.
- `pnpm -r typecheck` clean; `pnpm exec biome check . --diagnostic-level=error` clean;
  `node tools/leak-check.mjs --tree` clean.
- e2e (port 6515): `image-layout`, `tables`, `phone-images`, `image-insert`, `assets` — 23 passed
  (Chromium + WebKit where matched). Full `pnpm e2e` not run (another agent owns e2e flakiness).
- `pnpm nooklet verify` not run: no op/sync/schema change (assets are outside the op log).

## BUGS.md updates to fold in

- **B-702** → fixed (2026-10-04, tables-images). Test: `packages/core/src/tokens.test.ts`
  "B-702: …" (5), `apps/web/src/editor/render/tokens.test.tsx` "B-702: …" (2), corpus 50,
  `packages/server/src/mirror/export.test.ts` "reads back GFM tables exactly as written", e2e
  `tables.spec.ts` (2). Cause: cells tokenized at offset 0; and tables after prose (the real
  graph's only shape) were not recognized at all — new `mixed` content kind (CLS-T-mixed).
- **B-703** → fixed (2026-10-04, tables-images). Test: `packages/server/src/assets/image-size.test.ts`,
  `asset-upload.http.test.ts` "B-703: image sizes", `apps/web/src/editor/render/image-size.test.tsx`,
  e2e `image-layout.spec.ts` (red without the fix: 396 px / 224 px jump). Existing assets backfilled
  lazily on first `asset.sizes` read (no migration).
- **New, low — B-7xx · A table-first block's `^id` and properties land inside the table in the
  markdown mirror.** `- | a | b | ^id` then `  foo:: bar` then the delimiter row: nooklet reads it
  back exactly, but a GFM viewer or Logseq sees a 3-cell header (or a broken table). Same family as
  OUT-14's fence-first rule; a fix would put the head/id/properties alone on line 1 when line 1 is a
  table header. Found 2026-10-04, tables-images; 0 such blocks in the real graph (all its tables
  follow prose).
- **B-470 note:** a no-outer-pipe table whose delimiter row is written `- | -` is one of B-470's
  shapes (reads back as a child bullet). `---|---` and `| - | - |` are safe.
- **New, low — B-7xx · `\|` inside a code span in a table cell renders as `\|`.** GFM unescapes
  the pipe before inline parsing, even in code spans; our cell splitter respects the escape but the
  code-span token keeps the backslash. Not seen in the real graph.
