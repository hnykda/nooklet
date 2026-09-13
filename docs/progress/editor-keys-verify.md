# editor-keys verification (M10) — progress

Adversarial verification of `m10/editor-keys` (B-282, B-294, B-295, B-344, B-346), on the same
branch and worktree. Scratch: `scratchpad/m10/editor-keys-verify/`. e2e port 6400.

## Done

- Branch's four new specs rerun on `67ae509`: 9 passed. Web unit 1,152 passed.
- Browser probes (throwaway, `e2e/tests/zz-ekv-probe.spec.ts`, not committed) on 17 edges:
  rapid Cmd+Enter ×5 and undo ×5; Cmd+Enter ×2 in selection mode and after typing; Mark DONE on a
  selection with a `repeat:: 1d` task, undo, redo; nested selection; Alt+Enter on a link to the page
  already shown; Cmd+[ then typing; Alt+Enter with the popup open; `/mermaid` in a block with
  children, right after Enter, and on a zoom root; `/template` on a zoom root; caret right before a
  link's `]]`; walking into a link to a page that does not exist.

## Found

- B-382 (logged, fixing): walking into `[[Walkin Unmade Page]]` and pressing Enter on the "New page"
  row deletes the rest of the name — `alpha [[Walkin Unm]] omega` — and creates a page "Walkin Unm".
  Red e2e added to `autocomplete-inside-link.spec.ts`.

## In flight

- B-382 fix in `commands/autocomplete/AutocompletePopup.tsx`.

## Next

1. Fix B-382, unit test, e2e green, commit.
2. Log the zoom-root `/mermaid` (and `/template`) out-of-view insert.
3. Full e2e run in halves; typecheck; biome.
