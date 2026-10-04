# image-sizing — B-789: resize handle, ⋯ menu, alignment (2026-10-04)

Branch: the agent's own worktree branch, fast-forwarded to `1082163c`. Not merged, not pushed.
e2e port 6510. New bug numbers from B-840.

## Status

In flight: research done, building core parser next.

## Findings so far (sources)

- Logseq file graphs (0.10.9) store an image's size as an EDN map written straight after the
  image, no space: `![alt](path){:height 236, :width 500}`. Writer: `editor-handler/resize-image!`
  (`src/main/frontend/handler/editor.cljs` at tag 0.10.9, line ~1843) does
  `(str image-part (pr-str (merge metadata size)))`; mldoc's grammar
  (`lib/syntax/inline.ml`, `let metadata = between "{" "}"`) takes `{` up to the first `}` right
  after the `)`. The reader merges the map into the `<img>` attributes.
- Logseq DB version (master) stores size as `:logseq.property.asset/resize-metadata` (`{:width w}`
  only, `resize-image!` in `editor.cljs`) and alignment as `:logseq.property.asset/align`
  (`:left`/`:center`/`:right`, `asset-container` in `components/block.cljs`) on the asset
  entity. The file-graph text format has no alignment.
- Logseq hides the resize handles on native mobile (`resizable?` is
  `(not (mobile-util/native-platform?))`), shows a ⋯ (`dots-vertical`) action bar on hover, and a
  click on the `<img>` opens the lightbox.
- nooklet's importer keeps `{:height …}` verbatim (only `](../assets/x)` is rewritten), and the
  renderer showed it as text after the picture.
