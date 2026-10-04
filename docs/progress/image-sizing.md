# image-sizing — B-789: resize handle, ⋯ menu, alignment (2026-10-04)

Branch: the agent's own worktree branch, fast-forwarded to `1082163c`. Not merged, not pushed.
e2e port 6510. New bug numbers from B-840 (used: B-840 fixed, B-841 open).

## Status

Built and committed; full verification in progress (see Verification).

- `0cfdff8c` docs: B-789 in progress, this file.
- `99846316` core + importer: the `{:width …}` map in the inline grammar (`image-meta.ts`,
  corpus case 51), `setImageMeta`, the DB-version importer restoring `resize-metadata`/`align`.
- `11853589` web + shell: `render/ImageView.tsx` (box, handle, ⋯ menu), `BlockTree#onRewrite`,
  `noteUndoTarget`, `reveal-asset` in `main.rs`, e2e `image-resize.spec.ts` + a phone test.
- docs commit: ADR 034, BUGS (B-789 fixed, B-840 fixed, B-841 open), import guide row.

## Decisions (ADR 034)

- Size: Logseq's own text map after the image, `{:width N}` (whole px); an existing `:height` is
  rescaled; unknown keys kept. Alignment: `:align "center"|"right"` in the same map (Logseq has
  alignment only as a DB property; left = no key).
- One `block.text` per gesture through `BlockTree`'s commit: no new op, one undo step.
- Click opens the viewer (B-736), ⋯ on hover acts, edge resizes. ⋯ sits beside pictures < 120 px.
- Touch: no handle, no ⋯ (as Logseq). The tap opens the viewer.
- Show in Finder: shell request with graph key + asset id only; shell finds the file in
  `<data>/graphs/<id>/assets/`, no symlinks, `open -R`. Shown only with `reveal: true`, on the
  bundled server, on a This-Mac graph, for an uploaded asset.

## Findings (sources)

- Logseq file graphs (0.10.9) store an image's size as an EDN map written straight after the
  image, no space: `![alt](path){:height 236, :width 500}`. Writer: `editor-handler/resize-image!`
  (`src/main/frontend/handler/editor.cljs` at tag 0.10.9, line ~1843) does
  `(str image-part (pr-str (merge metadata size)))`; mldoc's grammar
  (`lib/syntax/inline.ml`, `let metadata = between "{" "}"`) takes `{` up to the first `}` right
  after the `)`. The reader merges the map into the `<img>` attributes.
- Logseq DB version (master) stores size as `:logseq.property.asset/resize-metadata` (`{:width w}`
  only, `resize-image!` in `editor.cljs`) and alignment as `:logseq.property.asset/align`
  (keyword, `:left`/`:center`/`:right`, `asset-container` in `components/block.cljs`; schema in
  `deps/db/src/logseq/db/frontend/property.cljs`) on the asset entity.
- Logseq hides the resize handles on native mobile, shows a ⋯ (`dots-vertical`) action bar on
  hover, and a click on the `<img>` opens the lightbox.
- nooklet's importer already kept `{:height …}` verbatim (unit test now pins it); the renderer
  showed it as text (B-840).
- Undo of a write made from a rendered row with nothing edited reached no tree (B-841 for the
  task marker; fixed for images with `noteUndoTarget`). Probe: a throwaway e2e, recorded in B-841.

## Verification

- `pnpm -r typecheck`: clean. `pnpm exec biome check .`: no diagnostics in changed files (31
  pre-existing warnings elsewhere).
- `pnpm -r test`: core 523, plugin-api 17, server 952, web 1756 — all passed.
- `cargo test` (apps/desktop/src-tauri): 34 passed, 1 ignored (the real keychain).
- Targeted e2e (port 6510): `image-resize`, `phone-images`, `image-viewer`, `image-layout`, both
  projects: 25 passed.
- Full `pnpm e2e`, `pnpm nooklet verify`, leak-check: see below once run.

## Not verified

- A real desktop window (Tauri/WKWebView): drag, ⋯ menu, Show in Finder never driven in the app;
  Show in Finder is covered by the Rust unit test (request parsing, file lookup) and the web unit
  test (when it is offered), not by running `open -R`.
- A real phone (Capacitor on iOS/Android): only Playwright's iPhone 13 emulation in Chromium and
  WebKit.
- Logseq itself opening a nooklet-written `{:width N, :align "right"}`: by reading its source only.

## How to resume

Everything is committed. Remaining: full e2e, `pnpm nooklet verify`, leak-check, then report.
