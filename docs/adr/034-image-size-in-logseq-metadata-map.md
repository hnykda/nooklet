# ADR 034: An image's size and alignment live in Logseq's `{:width …}` map after the image

Date: 2026-10-04. Status: accepted (B-789, owner request). Work record:
`docs/progress/image-sizing.md`.

## Context

The owner wants Logseq's image handling: a handle on the picture's edge to make it bigger or
smaller, the size saved with the block; a ⋯ menu with Download (and on the desktop, Show in
Finder); optionally left / centre / right alignment. Whatever stores the size must survive the
Markdown mirror (ADR 002) and Logseq import (ADR 012, ADR 030), and an imported graph may already
carry sizes.

What Logseq does, read from its source on 2026-10-04:

- **File graphs (0.10.x)** write the size into the block text, straight after the image with no
  space: `![alt](../assets/x.png){:height 236, :width 500}`. Writer:
  `editor-handler/resize-image!` in `src/main/frontend/handler/editor.cljs` at tag `0.10.9`,
  `(str image-part (pr-str (merge metadata size)))`. Reader: mldoc,
  `lib/syntax/inline.ml`, `let metadata = between "{" "}"` — from the `{` to the first `}` right
  after the `)`; the map is then `safe-read-string`'d and merged into the `<img>` attributes
  (`image-link` / `resizable-image` in `components/block.cljs` at 0.10.9). Width can be
  fractional (whatever the drag measured).
- **DB version (master)** keeps both as properties of the asset entity:
  `:logseq.property.asset/resize-metadata` (a map, `{:width w}` from `resize-image!`) and
  `:logseq.property.asset/align` (a keyword, `:left`/`:center`/`:right`, set from the asset's ⋯
  menu, `asset-container` in `components/block.cljs`; schema in
  `deps/db/src/logseq/db/frontend/property.cljs`). Its file-graph importer
  (`deps/graph-parser/.../exporter.cljs`) turns the text map into `resize-metadata`.
- Logseq has **no text syntax for alignment**; it exists only in the DB version.
- Logseq hides the resize handles on native mobile (`resizable?` is
  `(not (mobile-util/native-platform?))`), shows its ⋯ action bar on hover, and a click on the
  `<img>` opens its lightbox.

Before this, nooklet's importer kept `{:height 236, :width 500}` verbatim (it only rewrites asset
paths) and the renderer showed it as text after the picture (B-840).

## Decision

1. **Store the size as Logseq does, in the text.** The inline grammar takes an EDN map straight
   after an image's `)` (mldoc's extent: up to the first `}`) as the image's metadata
   (`packages/core/src/image-meta.ts`, `docs/spec/markdown-grammar.md`, corpus case 51). Only a
   map that parses — keyword keys; number, string, keyword, `true`/`false`/`nil` values — counts;
   anything else stays visible text (mldoc would hide `{{embed …}` there too; hiding what a person
   typed is worse than showing a stray brace).
2. **nooklet writes `{:width N}`**, whole pixels, in `pr-str`'s shape (`{:height 118, :width 250}`).
   An existing `:height` is rescaled by the same factor (Logseq 0.10 puts it on the `<img>`, where
   a stale one would stretch the picture); a `:height` with no `:width` to scale from is dropped.
   Keys nooklet does not know are kept, in order. nooklet sizes by width and the picture's own
   aspect ratio and never by `:height`.
3. **Alignment is `:align "center"` / `:align "right"` in the same map**; left is the default and
   removes the key. This is nooklet's own key — the closest Logseq-compatible place, since Logseq
   keeps alignment only as a DB property — and the DB-version importer maps
   `:logseq.property.asset/align` (and `resize-metadata`'s `:width`) into it.
4. **One write per gesture through the normal path.** The handle previews the width locally and
   writes ONE `block.text` when the drag ends; the ⋯ menu's alignment and "Original size" are one
   write each. They go through `BlockTree`'s ordinary commit (`setBlockText`, `commitStep`), so
   each is one undo step and syncs like typing. No new op type, nothing in the `defineOp` registry
   or `serverApplyOps` changes. The tree that wrote becomes Cmd/Ctrl+Z's target
   (`noteUndoTarget`), as a command's batch already did (B-142).
5. **Click opens, ⋯ acts, the edge resizes** (Logseq's split). The B-736 viewer still opens on a
   click; the ⋯ (on hover, or keyboard focus) offers Copy image, Download, Show in Finder, Open in
   new tab, alignment and Original size, reusing `image-actions.ts`. On a picture narrower than
   120 px the ⋯ sits just outside its right edge, because over it it would cover where a click
   opens it.
6. **No handle and no ⋯ on touch.** A phone has no hover to reveal them, a sideways drag on a row
   is already swipe-to-indent, and a picture there is already as wide as the screen allows, so a
   handle could mostly only shrink it. Logseq makes the same call. The tap opens the viewer, which
   has Save / Share and Copy. Sizes chosen elsewhere still render, capped to the column (never
   wider than the screen, B-682/B-683).
7. **Show in Finder is the shell's, for This Mac only.** The page asks with a `reveal-asset` shell
   request naming the graph key and the asset id — never a path; the shell checks the graph is a
   `mac:` one, finds `<data>/graphs/<id>/assets/<asset>.<ext>` itself (no symlinks), and runs
   `open -R`. The item appears only when the shell says it answers (`reveal: true` in
   `__NOOKLET_DESKTOP__`), the page is on the bundled server, the open graph is on This Mac and the
   picture is an uploaded asset.

## Alternatives rejected

- **A block property (`image-width:: 500`).** Survives the mirror, but a block can hold several
  pictures, Logseq would show it as a property and drop it on export, and imported sizes would
  need translating both ways.
- **HTML `<img width>` or a `=500x` suffix (other Markdown dialects).** Not what Logseq reads or
  writes; imported sizes would still show as text.
- **A new op type (`block.imageSize`).** A second write path for what is a text edit; the mirror
  would still need a text form.
- **A resize handle on the phone.** See 6; can be revisited with a pinch gesture if the owner
  wants it.

## Consequences

- Logseq file graphs read nooklet's sizes as their own. A `:align` value goes onto the `<img>` in
  Logseq 0.10 as the old HTML `align` attribute: `"right"` floats the picture right there (text
  wraps beside it), `"center"` has no visible effect. Logseq DB's importer folds the whole map into
  `resize-metadata`, so the alignment is not carried into Logseq DB.
- The size map is part of the image token (`end` covers it, `metaAt` marks where it starts), so a
  click to the right of a sized picture still puts the caret after the map, and the editor's raw
  text keeps it verbatim.
- On a fine pointer every picture has two hover controls; a click exactly on them does not open the
  viewer.
