# verify impl-render (m8) — progress

Adversarial verification of `m8/impl-render` (B-100 numbered lists, B-101 property chips and
editing, B-99 `/image`, B-150). Worktree `.claude/worktrees/wf_69b4f9a8-ee2-9`, e2e port 6401.
Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-render-verify/`
(real-graph copy in `graph/`). Uncommitted scratch spec `e2e/tests/zz-verify-render.spec.ts` holds
the exploratory browser checks (V1–V13); it is deleted before the last commit.

## Done
- Baseline re-run: core 357/357, web 707/707, typecheck clean, biome on changed files = the one
  pre-existing `BlockRowView.tsx` error; `block-properties` 8/8 + `image-insert` 2/2 on 6401.
- Browser checks that held: typed property + immediate Enter (V2), agent property set while typing
  is kept (V3), `/property` undo/redo (V4), Czech text + non-ASCII key stays text + click at x=0
  lands in content (V5), `[[link]]` in a chip navigates (V6), `/image` into a block with properties
  (V7), numbered Enter + Tab (V8), agent-set value changed by typing (V9).
- `87d2e5d` B-152 fixed (multi-line / padded property values leaked into content on edit).

- B-153 fixed: `/code`, `/query` and `/h1`-`/h3` acted on the whole buffer, property lines included
  (V10–V12 red in the browser, green after). B-154 fixed: `/template` into an empty block with
  properties went in after it (V13).

## Next
1. Real-graph copy: rerun `tools/probes/real-graph-properties.mjs`, `nooklet verify`.
2. Broad e2e regression run; final numbers here.
