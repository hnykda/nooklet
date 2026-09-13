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
| Q1 live mirror misses renames/moves/props | B-260 | high | fixed |
| Q2 UI title rename skips link rewrite + alias | B-261 | high | fixed |
| Q3 export trusts mirror_file over disk | B-262 | medium | fixed |
| Q4 `tag:task` query finds nothing | B-263 | medium | fixed |
| Q5 `$$…$$` display math | B-264 | low | fixed |
| Q6 collapsed template copy | B-265 | low | fixed |
| Q7 unpadded SCHEDULED dates | B-266 | low | fixed |
| Q8 page_merge dry-run text | B-267 | low | next |
| Q9 `javascript:` hrefs | B-268 | low | queued |

## Done (commits)

- `693f000` inbox entries B-260..B-268 logged
- `2577a3e` B-260 live mirror follows `changes` (unit + `e2e/tests/mirror-live.spec.ts` 3/3)
- `2416e9e` B-261 title rename through `page.update` (`e2e/tests/page-rename.spec.ts` 2/2, `pages.spec.ts` 14/14)
- `bd6ef6f` B-262 export rewrites files missing on disk (unit; real graph copy 952/952)
- `a287309` B-263 derived Task tag in queries (`core/refs.ts#TASK_TAG`; unit + `e2e/tests/query-task-tag.spec.ts` 2/2; real graph 686)
- `cf5ae1c` B-264 `$$…$$` display math (core tokenizer + MathView + MathWidget + spec; unit + `e2e/tests/math-display.spec.ts` 2/2)
- `8bc4179` B-265 template roots inserted unfolded (`core/templates.ts#templateRoots`; unit + `e2e/tests/template-collapsed.spec.ts` 1/1, `templates.spec.ts` 8/8; real graph Meeting)
- B-266 unpadded org timestamps (`core/outline.ts`; unit + importer test; real data 20/20; existing DB rows not repaired — owner)

## In flight

- Q8/B-267.

## Decisions

- B-260: the mirror follows `changes` rows by seq cursor, not `updated_at` timestamps; core reducer
  untouched. First sweep after start is a full render (~200 ms on the real graph).
- Scripts for real-graph checks: `<scratch>/serve.sh <name>` (fresh copy served on 6462) and
  `<scratch>/q1-real.mjs`. The sandbox refuses `bash $VAR/...`; call scripts by literal path.
- e2e specs share one graph per run: `template-collapsed.spec.ts` deletes its library page in
  `afterAll`, because `templates.spec.ts` asserts the exact template list Settings offers.
- B-261: the title calls the server op (push → `page.update` → pull → navigate); an offline rename
  is refused with an alert rather than done locally without the link rewrite.

## How to resume

1. `git log --oneline da85cfb..` on the branch; this file's table says what is left.
2. Real-graph copy: `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"`,
   never a nooklet command on `~/.nooklet/default`.
3. Before each commit: biome on changed files, `pnpm -r typecheck`, unit tests of touched packages,
   e2e specs touched with `NOOKLET_E2E_PORT=6462`.
4. Real-graph browser checks: `bash <scratch>/serve.sh <name>` then `node <scratch>/q4-real.mjs`
   (helpers in `<scratch>/rlib.mjs`; the served client is whatever `apps/web/dist` the last e2e
   run built). Kill with `lsof -ti :6462 | xargs kill`.
