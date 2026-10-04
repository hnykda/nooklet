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

## Decisions

- **Enter in the middle (or at the start) of the root**: split at the caret; the root keeps the
  text before it, the rest becomes the root's FIRST child, caret at its start. Same as Logseq (see
  above). Why: the top stays fixed, and what you were typing moves down into the view where you
  can see it; any "insert above" would have to go outside the view.
- **Collapsed root**: always rendered open in its view (`flattenVisible` ignores the root's
  `collapsed`), no collapse arrow on its row, `block.collapse` on it is a no-op. Otherwise Enter on
  a collapsed root (now a first child) made a block nobody could see. Its stored flag is untouched,
  so zooming out shows it as it was.
- **Delete / Cut with the root selected** (e.g. select all + Delete): the root stays, the selected
  blocks under it go. Deleting the root emptied the view under a breadcrumb naming a gone block.
- **Paste on the root**: first children, above existing ones (where Enter puts a block). An empty
  root is kept rather than replaced by the first pasted block.
- **Root as title** (larger font, as Logseq): not done — logged as B-821. It is a font change on
  the row that hosts the editor, interacting with headings/markers/images; not "tiny".
- Duplicate on the root returns `null` (signature `OpsFocusResult | null`); three existing tests
  cast.

## Command audit — "stays inside the zoom root"

Every structural command in `editor/commands.ts`, the keymap (`commands/registrations/structural.ts`),
gestures (swipe → `doIndent`/`doOutdent`, long-press drag → `doMoveStep`), the phone toolbar (same
commands), and selection mode:

| Command | At the root | At a direct child | Status |
|---|---|---|---|
| `block.split` (Enter) | sibling, outside → now first child | sibling, inside | FIXED |
| `block.newline` | text only | text only | fine |
| `block.indent` (Tab, swipe) | moved root under its prev sibling → no-op | inside | FIXED |
| `block.outdent` (Shift+Tab, swipe, toolbar) | already no-op | went beside the root → no-op | FIXED |
| `block.mergeWithPrevious` (Backspace) | visible rows start at root → no-op | merges into root, inside | already OK, tested |
| `block.deleteForwardMerge` (Delete) | last visible row → no-op | inside | already OK, tested |
| `block.moveUp/Down` (Alt+arrows, drag) | swapped with outside siblings → no-op | among siblings, inside | FIXED |
| `block.focusPrevious*/Next*` (arrows) | index −1 → falls through to CM6, caret stays | inside | already OK, e2e |
| `block.collapse/expand` | root always open; collapse no-op | inside | FIXED |
| `block.collapseAll/expandAll` | scoped to zoom root already (B-97) | — | fine |
| `block.zoomIn/zoomOut` | view change, no ops | — | fine |
| `block.duplicate` | copy was a sibling → no-op | inside | FIXED |
| `block.deleteSelected`/`cutSelection` | deleted the root → root kept | inside | FIXED |
| `block.indentSelected` | root moved → skipped | inside | FIXED |
| `block.outdentSelected` | NOT guarded at all → root and children skipped | — | FIXED |
| `block.selectAll`/`copySelection` | no ops | — | fine |
| `edit.paste` (multi-line) | siblings; empty root deleted → first children | siblings, inside | FIXED |
| `edit.paste` (image) | text insert only | — | fine |
| `/template` (`block.insertTemplate`) | siblings, outside | inside | **B-820, open** |
| `block.moveToPage` | moves the root to another page | — | explicit command, left as is |
| `task.*`, dates, properties | props only | — | fine |

## Done

- `605d8297` fix(web): the zoom root is the fixed top of a zoomed view (B-788). `commands.ts`
  (`ZoomScope`), `paste.ts`, `tree.ts`, `BlockTree.tsx`, `BlockRowView.tsx`; tests
  `editor/zoom-root.test.ts` (22), `e2e/tests/zoom-root.spec.ts` (3), `e2e/tests/phone-zoom-root.spec.ts`
  (3); `zoom-root` added to the WebKit project's `testMatch`.
- Against the unfixed source (`git checkout 7d9781ab -- <5 source files>`): unit 13 of 22 fail
  (the 9 passing pin behaviour that was already right); e2e 12 of 12 fail (after making the
  "middle" test use a collapsed root — with an open root with children it passed unfixed, since
  R16 already made a first child there).
- Unit: core 506, plugin-api 17, server 951, web 1768 — all pass. Typecheck clean. Biome: no errors.

- Full `pnpm e2e` (port 6500): 868 passed, 6 skipped, 1 failed — `popups.spec.ts:181` "Escape
  closes the popup…", which timed out in its setup (`openEditing`: no `.vr-row` appeared) during a
  ~38-minute stall of the machine (that test and one other show a 38.4m duration; the run took
  1.1h). Re-run alone with `caret-after-link.spec.ts`: 71/71 passed. All 12 zoom-root e2e passed in
  the full run.
- Docs: BUGS.md B-788 fixed, B-820 (template on the root) and B-821 (root as title) open; spec
  `commands-and-keymap.md` R27.1. `leak-check --tree` clean.
- `pnpm nooklet verify` not run: no op kinds, sync or schema touched (the commands only emit
  existing `block.create`/`block.place`/`block.delete`).

## Next steps

None for B-788. Follow-ups: B-820, B-821.
