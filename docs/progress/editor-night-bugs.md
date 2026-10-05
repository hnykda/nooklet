# Editor night bugs — B-841, B-820 (+B-383), B-821

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Own worktree, based on `81d8a618`. E2E port 6520. New bug numbers start at B-860.

## Brief

1. **B-841**: a task-marker click with nothing edited cannot be undone. Fix every click/gesture
   write on a rendered row the same way (`noteUndoTarget`, as B-789's image resize).
2. **B-820 / B-383**: zoomed in, `/template` and `/mermaid` on the zoom root insert outside the
   view. Any slash command that inserts blocks must respect R27.1: on the root, the new blocks are
   its first children.
3. **B-821**: the zoom root should look like the view's title (larger), without breaking caret
   geometry, headings, markers, images. Verify Chromium + WebKit, desktop + phone.

## Audit — writes from a click or gesture on a tree's rows (B-841)

| Write | Path | Undo target before |
|---|---|---|
| Task marker click | `BlockRowView` → `BlockTree#onToggleMarker` → `commitStep` | **missing** |
| Collapse arrow click | `Bullet` → `BlockTree#onToggleCollapse` → `commitOne` | **missing** |
| Image resize / ⋯ menu | `ImageView` → `onRewrite` → `commitStep` + `noteUndoTarget` | ok (B-789) |
| Swipe indent / outdent (touch, row not edited) | `doIndent`/`doOutdent` → `runStructural` | **missing** |
| Long-press drag reorder | `Bullet` → `doMoveStep` → `runStructural` | **missing** |
| Date chip (date picker) | `commitOps` → `commitThroughEditor` (sets `recent`) | ok (B-142) |
| Inline `[ ]` checkbox | rendered `disabled`, no write | n/a |
| Priority badge | a `<span>`, no click | n/a |
| Properties under a row | click enters editing | n/a |
| Read-only outline / embed toggles | view-local, no write | n/a |
| Tasks view checkbox (`views/TasksView.tsx`) | `applyOps`, no tree, no history at all | out of scope → B-860 |

## Decisions

- **B-841, one helper**: `BlockTree#byPointer(write)` runs the write and calls
  `noteUndoTarget(editorHost)` only if `commit` recorded something (a counter in `commit`). Why the
  check: `noteUndoTarget` ends another tree's standing session; a refused write (swipe on the zoom
  root, a locked page) must not do that. Used by marker, collapse arrow, swipe, long-press drag and
  the image rewrite (B-789's direct call folded in).
- **B-820, how a command learns the zoom root**: a new `EditorHost.zoomRoot()` (the focused tree's
  `effectiveRoot`), not a new field in `CommandContext` — the context has `zoomed` (a boolean for
  `when` clauses), and the commands that need the id already hold the editor host.
- **Template on the root with text**: its top-level blocks become the root's FIRST children (above
  existing ones), caret to the first — where Enter on the root puts a block (R27.1).
- **Template into an EMPTY root**: the first node fills the root (unchanged); the rest of the
  template's top level go under the root after the first node's children (template order kept),
  above the root's existing children. Siblings would be outside the view.
- **`/mermaid` / plugin `insertBlockAfter(root)`**: first child of the root. The plugin API keeps its
  name; the doc comment on `EditorApi.insertBlockAfter` says what happens on a zoom root.
- Other slash items were checked: code fence, table, query, image, embeds, dates, properties all
  insert TEXT into the current block; only `/template` and plugin `insertBlockAfter` create blocks.

## Done

- B-841 + B-820 + B-383 code, tests, BUGS entries, spec R27.1 (commit below).
  - `e2e/tests/click-undo.spec.ts` (3, Chromium): all 3 fail with `BlockTree.tsx` reverted to HEAD,
    pass with the fix.
  - `zoom-root.spec.ts` B-820 ×2 + B-383 ×1, Chromium + WebKit: all 6 fail with
    `commands/registrations/templates.ts` and `plugins/host.ts` reverted, pass with the fix.
  - Unit: `templates.test.ts` "B-820" (2), `host.test.ts` "B-383" (1) fail without the fix;
    `editor-host.test.ts` B-841 (2) + zoomRoot (1) pin the seam.
- Found and logged, not fixed: **B-860** (Tasks view tick not undoable), **B-861** (emptying a
  bullet and inserting a template at once leaves the server's bullet empty; the e2e waits around it).

- `11e29851` — the commit above.
- B-821 (CSS only): `.vr-row-zoom-root { font-size: var(--text-xl) }` plus three fix-ups (marker
  font size inherits, priority chip margin, headings at the title size in the root). Decided
  against bold: it would hide the block's own `**bold**`. e2e: `zoom-root.spec.ts` "B-821" ×4 and
  `phone-zoom-root.spec.ts` "B-821" ×1, Chromium + WebKit, 10/10 pass; with `editor.css` at HEAD
  4 of 10 fail (title size, phone); the caret/click/arrow tests pass either way (guards).
  Throwaway probes (not committed): screenshots of task / heading / wrapped / property / image
  roots, desktop and iPhone 13, rendered and editing — no shift between the two; image box 300×120
  before and after zooming. Found in passing: **B-862** (zoom trail shows raw markdown).
- New e2e helper `e2e/helpers/text-geometry.ts` (character boxes, font size, line height).

- `9b1b1425` — B-821.
- Checks on `9b1b1425`: `pnpm -r typecheck` clean; `biome check .` no errors (31 warnings, none in
  files touched here); `pnpm -r test` core 523, plugin-api 17, server 952, web 1835, all pass;
  `leak-check --tree` clean.
- FULL `pnpm e2e` (port 6520): **902 passed, 1 failed, 6 skipped** (26.2 min). The failure:
  WebKit `focus-log.spec.ts:36` (no "LOST editor focus" line in the log yet). Another agent's full
  run on its own worktree failed on the same test the same morning. Passes alone (3/3) and in a
  WebKit-only run of the whole project (88 passed, 0 failed). Logged as B-863 (with the sibling test
  not being re-run safe). Not touched by these changes, as far as I can tell (it clicks into a
  block, types, opens Diagnostics). (A first full run's log was overwritten by another agent writing
  the same scratch file name and is not counted.)
- `pnpm nooklet verify` not run: no op kinds, sync or schema touched (only existing
  `block.create`/`block.text`/`block.prop` ops, placed elsewhere).

## Next steps

None. Open follow-ups logged: B-860, B-861, B-862, B-863.
