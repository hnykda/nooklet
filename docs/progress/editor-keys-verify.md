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

- B-382 (fixed, `dc86f5b`): walking into `[[Walkin Unmade Page]]` and pressing Enter on the "New
  page" row deleted the rest of the name — `alpha [[Walkin Unm]] omega` — and created a page "Walkin
  Unm". The row now names the whole link. e2e red before, green after; 2 unit tests.
- B-383 (open, logged): `/mermaid` and `/template` on a zoom root insert outside the zoomed view.
- Added guard e2e: Mark DONE on a selection with a repeating task, one undo (`task-marker-keys`).
- Confirmed working: rapid Cmd+Enter ×3/×4/×6 under CPU throttling ×6 (CDP), and interleaved with
  typing; five rapid presses and five undos; Mark DONE with `repeat:: 1d` in a selection, undo, redo.
- Unit (`pnpm -r test`) after `dc86f5b`: core 398, 17, server 667, web 1,154 — all passed.
  `pnpm -r typecheck` clean.

- Probe round 2 (`e2e/tests/zz-ekv2-probe.spec.ts`, `zz-ekv3-probe.spec.ts`, not committed):
  text typed straight before Alt+Enter is kept in the block left (and after reload); Clear marker on
  a mixed selection writes only the marked blocks, undo restores `TODO/null/DONE`, redo clears;
  Mark DOING from the palette while editing touches only the edited block, undo keeps typed text.
- B-384 (fixed): Enter on the popup a walk into a complete link opened re-pointed the link — to a
  shorter page name, to today's date (caret just after `[[`), or for `((ref))` to the edited block
  itself. The row that keeps the link is now first; block variant lists nothing inside a closed ref.
  3 e2e + 4 unit red before, green after. Web unit 1,159 passed; web typecheck clean.

## In flight

- Commit B-384, then the full e2e run in halves on the head.

## Next

1. Full e2e `tests/[a-l]` and `tests/[m-z]`; rerun any failure alone once.
