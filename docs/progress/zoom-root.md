# B-788 — the zoom root is the fixed top of a zoomed view

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Branch `worktree-agent-a2f7efe3c5c8e9a5f` (own worktree), based on `7d9781a`. E2E port 6500. New
bug numbers start at B-820.

## Brief

Zoomed into a block, Enter at its end made a SIBLING, outside the zoomed subtree, so the new block
never showed (owner, phone). Wanted, Logseq's model: the zoomed block is the fixed top; Enter on it
makes its first child; nothing done in the zoomed view lands outside the zoomed subtree.

## What Logseq does (source, checked 2026-10-04)

`logseq/logseq` @ `22a29b30dee3b3930cf49bba50454650c31d2a07`,
`src/main/frontend/handler/editor.cljs`:

- `block-self-alone-when-insert?` is true when the block being edited IS the route's block (the
  zoomed block: `(:id config)` or the current page's uuid).
- In the Enter handler, `insert-fn` is `insert-new-block-aux!` when `block-self?` — the
  "insert above" path (caret at the start) is skipped for the zoom root.
- `insert-new-block-aux!` splits the text at the caret (`compute-fst-snd-block-text`: the text
  before stays, the text after goes to the new block) and passes
  `sibling? (or (get-in block [:block/link :block/collapsed?]) (when block-self? false))`, i.e.
  not a sibling.
- `deps/outliner/src/logseq/outliner/core.cljs#get-block-orders`: with `sibling? false` the new
  order is between nil and the first child's order — so the new block is the FIRST child.

So: Enter anywhere in the zoom root splits it at the caret and the rest becomes its first child.
nooklet does the same (also for Enter at offset 0 — the root keeps "", the old text moves down,
exactly what Logseq's skipped insert-above implies).

## Command audit — "stays inside the zoom root"

(filled in as each is handled; see "Done")

## Done

## In flight

## Next steps

1. Pure commands take `zoomRootId`; unit tests per command.
2. BlockTree wiring; flattenVisible always expands the zoom root.
3. e2e desktop + phone (Chromium, WebKit); run against unfixed code first.
4. Full gates; BUGS.md to fixed.
