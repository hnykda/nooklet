# verify impl-render (m8) — progress

Adversarial verification of `m8/impl-render` (B-100 numbered lists, B-101 property chips and
editing, B-99 `/image`, B-150). Worktree `.claude/worktrees/wf_69b4f9a8-ee2-9`, e2e port 6401.
Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-render-verify/`
(real-graph copy in `graph/`, now carrying 7 probe ops).

**Status: done.** Verdict: fixed-up — the three bugs are fixed as claimed; three regressions the
new editing buffer introduced were found in the browser and fixed.

## Commits
- `87d2e5d` B-152: a property value with a line break (or surrounding whitespace, or a key the line
  regex cannot read back) leaked into the block's text on the first keystroke. `showsInEditText`.
- `6e7d781` B-153: `/code`, `/query`, `/h1`–`/h3` acted on the property lines too (numbering wrapped
  into the fence; property became the query; caret left on the property line). B-154: `/template`
  into an empty numbered item went in after it. `insert-logic.ts#onContent`.
- `483152e` e2e: an agent's property set mid-typing survives the flush.

## Browser checks that held (scratch spec, deleted)
Typed property + immediate Enter; agent property set while typing kept; `/property` undo/redo;
Czech text, non-ASCII key stays text, click at x=0 lands in content; `[[link]]` chip navigates;
`/image` into a block with properties; numbered Enter + Tab; agent-set value changed by typing;
Numbered list and Image from the Cmd+Shift+P palette; chooser cancel leaves no input behind;
Cmd+C of numbered blocks carries `list:: number` and other properties; two browser contexts — a
typed property shows as a chip on the other, and the other's value edit syncs back.

## Real graph (copy of the owner's)
- `tools/probes/real-graph-properties.mjs`: 6 pages, 171 numbered rows, 55 chip rows, 0 wrong.
- UI edits on the copy (Czech numbered list `zahradni-domek`: typed, Enter → numbered item, undo,
  redo; OmnivoreSync and a PDF-highlights block edited): 7 ops, all `block.text`/`block.create`
  with `list:: number`, no stray `block.prop`; properties unchanged. `nooklet verify`: OK, 20,418 ops.

## Final numbers
- Unit: core 360/360; web 714/714 (one full run had `render-seams.test.tsx` fail once, passes
  alone — load). `pnpm -r typecheck` clean. Biome on changed files: only the pre-existing
  `BlockRowView.tsx` error.
- e2e Chromium 6401: batch 1 (block-properties 11, image-insert, popups, editing, history,
  templates, query, assets, autocomplete) 86/86; batch 2 (selection, parity, focus, render,
  rendering, tasks, context-menu, journals, a-fresh-journal, shelf, shelf-outline, phone,
  remote-device) 114 passed, 1 skipped; batch 3 (references, references-filters, views, refactor,
  pages, navigation, replace, trash, link-unlinked, page-icons, help) 74 passed, 2 failed —
  `page-icons` passed on rerun (load); `views.spec.ts` "opening the palette while editing and
  closing it hands focus back to the editor" fails at `da85cfb` too (checked out and run): pre-existing,
  not this branch.
