# editor-keys (M10) — progress

Branch `m10/editor-keys` from `70c9bb9`, worktree `.claude/worktrees/wf_ced35de1-fb8-2`.
Scratch: `scratchpad/m10/editor-keys/`. e2e port 6400.

Task: B-282 (Cmd+Enter twice cycles once), B-294 (Enter on autocomplete inside an existing link
duplicates its tail), B-295 (keys after Alt+Enter follow-link land in the block being left), B-346
(marker commands on a multi-selection: act on all selected blocks as one undo step — coordinator's
instruction), B-344 (`/mermaid` after existing text puts the fence inline). Failing Playwright test
first for each. Bug notes go to `docs/bugs-inbox/editor-keys.md`, not BUGS.md.

## Done

(nothing yet)

## In flight

- Reading code for all five.

## Next

1. B-346, B-282 (task.ts / dispatcher)
2. B-294 (autocomplete replace range)
3. B-295 (follow link ends editing)
4. B-344 (mermaid starter into its own block)

## Decisions

## How to resume

`git log m10/editor-keys` for landed commits; the inbox file names each test.
