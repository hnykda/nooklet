# qafix-render-sync — progress

Branch `m8/qafix-render-sync`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-19`, based on `da85cfb`.
Task: fix the nine findings from exploratory QA on render, queries, mirror and sync (Q1–Q9), one
commit per finding, each with a reproducing test. e2e port **6462**. Bug entries go to
`docs/bugs-inbox/qafix-render-sync.md` (B-260..B-268 assigned, B-269 spare), never `docs/BUGS.md`.

Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/qafix-render-sync/`
(`graph/` = fresh backup of the real graph, 952 live pages, 20,411 changes rows, 0 mirror rows).

## Finding → bug number

| QA | Bug | Sev | State |
|---|---|---|---|
| Q1 live mirror misses renames/moves/props | B-260 | high | next |
| Q2 UI title rename skips link rewrite + alias | B-261 | high | queued |
| Q3 export trusts mirror_file over disk | B-262 | medium | queued |
| Q4 `tag:task` query finds nothing | B-263 | medium | queued |
| Q5 `$$…$$` display math | B-264 | low | queued |
| Q6 collapsed template copy | B-265 | low | queued |
| Q7 unpadded SCHEDULED dates | B-266 | low | queued |
| Q8 page_merge dry-run text | B-267 | low | queued |
| Q9 `javascript:` hrefs | B-268 | low | queued |

## Done (commits)

- (none yet)

## In flight

- Q1/B-260.

## Decisions

- (none yet)

## How to resume

1. `git log --oneline da85cfb..` on the branch; this file's table says what is left.
2. Real-graph copy: `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"`,
   never a nooklet command on `~/.nooklet/default`.
3. Before each commit: biome on changed files, `pnpm -r typecheck`, unit tests of touched packages,
   e2e specs touched with `NOOKLET_E2E_PORT=6462`.
