# impl-render (m8) — progress

Branch `m8/impl-render`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-9`, started from `da85cfb`
(the worktree was created at an older commit, `41666ee`; the fresh branch was reset to `da85cfb`
before any work). Task: B-100 numbered lists render, B-101 block properties visible + `/property`
writes a real property, B-99 `/image` opens a picker and uploads. e2e port 6401.

## Done
(nothing but this file yet)

## In flight
- Logged B-150 (paste upload has no token) in `docs/bugs-inbox/impl-render.md`.

## Next, in order
1. Data seam: worker page tree carries generic `properties`; `EditableBlock.properties`;
   numbering from `list:: number` (B-100) + e2e.
2. Editor buffer = content + property lines, split on flush (B-101), chips in `BlockRowView`,
   `/property` placeholder selected; undo/optimistic/history for generic props.
3. `/image` (B-99) + B-150.
4. Real-graph check (numbered pages render), verify, inbox Fixed paragraphs.

## Design decisions
1. **Data seam.** Generic `block_prop` rows (non-null values) are projected into
   `BlockTreeNode.properties` by the worker's page-tree query (`db/worker-core.ts`), and from there
   into `EditableBlock.properties`. Core's `BlockRow` is untouched (server code shares it).
   `listNumber` is derived: `properties.list === "number"`.
2. **Editor buffer = content + generic property lines** (Logseq's raw edit mode, and the same
   shape the server's `block.update` raw text uses): line 1, then `key:: value` lines, then the
   rest of the content. On flush the buffer is split back (fence-aware, OUT-18/19 regex and key
   normalization) into `block.text` + one `block.prop` per changed key (`null` for a removed one),
   diffed against the snapshot the edit started from — never against live props, so a property an
   agent set meanwhile is not clobbered.
3. **Reserved keys stay out of the buffer** (`id collapsed marker priority scheduled deadline
   repeat done`, plus `heading`): a typed `scheduled:: …` line stays content text as before. Dates
   have their own workstreams (B-96 picker, B-102 chips); typed-date parsing needs validation the
   reducer would otherwise reject mid-typing.
4. **Chips go below the whole rendered content**, not literally between line 1 and line 2: the
   rendered view's click-to-caret offsets (`caret.ts`, `data-from`) assume one `BlockContentView`
   over the whole content. Only 33 of ~400 non-`list` property blocks in the owner's graph are
   multi-line.

## How to resume
`git log --oneline da85cfb..m8/impl-render`, then this file. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-render/`
(real-graph copy in `graph/`).
