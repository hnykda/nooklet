# qafix-render-sync — progress

Branch `m8/qafix-render-sync`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-19`, based on `61279a2`.
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
| Q8 page_merge dry-run text | B-267 | low | fixed |
| Q9 `javascript:` hrefs | B-268 | low | fixed |

## Done (commits)

- `f3e04f0` inbox entries B-260..B-268 logged
- `959c505` B-260 live mirror follows `changes` (unit + `e2e/tests/mirror-live.spec.ts` 3/3)
- `318e7a7` B-261 title rename through `page.update` (`e2e/tests/page-rename.spec.ts` 2/2, `pages.spec.ts` 14/14)
- `f6993c3` B-262 export rewrites files missing on disk (unit; real graph copy 952/952)
- `1caf169` B-263 derived Task tag in queries (`core/refs.ts#TASK_TAG`; unit + `e2e/tests/query-task-tag.spec.ts` 2/2; real graph 686)
- `2c78732` B-264 `$$…$$` display math (core tokenizer + MathView + MathWidget + spec; unit + `e2e/tests/math-display.spec.ts` 2/2)
- `f35a712` B-265 template roots inserted unfolded (`core/templates.ts#templateRoots`; unit + `e2e/tests/template-collapsed.spec.ts` 1/1, `templates.spec.ts` 8/8; real graph Meeting)
- `0dce15f` B-266 unpadded org timestamps (`core/outline.ts`; unit + importer test; real data 20/20; existing DB rows not repaired — owner)
- `89efe21` B-267 MCP text says "dry run, nothing written" for every dry-run op (`ops/dry-run.ts#renderToolText`; unit)
- `9b4c7db` B-268 script-capable link schemes never become an href or a `window.open` (`editor/render/safe-href.ts`; unit + `e2e/tests/link-scheme.spec.ts` 1/1)
- `52162c6` B-261 follow-up: the missing-view flash after a title rename (guard cleared on resolve)
- Final pass on `9b4c7db`: `pnpm -r test` 343 + 17 + 529 + 688 passed; `pnpm -r typecheck` clean;
  16 e2e specs together (the 7 new + pages, query, tasks, templates, render, rendering, editing,
  refactor, references, parity) 88/88; `nooklet verify` on a real-graph copy OK (20,420 ops).
  After the follow-up: `pages.spec.ts` + `page-rename.spec.ts` 15/16 then 16/16 on rerun (the one
  failure was the sidebar "recently edited" test, a 15 s timeout, not rename-related).

## In flight

- Nothing. All nine findings fixed.

## Next steps (for whoever merges)

1. Move the nine inbox entries into `docs/BUGS.md` (all fixed); amend B-95's fix note there — it
   describes the `onlyChanged` sweep that B-260 replaced.
2. Owner: 20 already-imported blocks on the real graph still hold a literal `SCHEDULED:` line
   (B-266) — re-import or a one-off repair.

## Decisions

- B-260: the mirror follows `changes` rows by seq cursor, not `updated_at` timestamps; core reducer
  untouched. First sweep after start is a full render (~200 ms on the real graph).
- Scripts for real-graph checks: `<scratch>/serve.sh <name>` (fresh copy served on 6462) and
  `<scratch>/q1-real.mjs`. The sandbox refuses `bash $VAR/...`; call scripts by literal path.
- B-268: denylist of script-capable schemes (javascript, vbscript, data, blob, filesystem), not an
  allowlist — custom app schemes like `zotero://` keep working.
- e2e specs share one graph per run: `template-collapsed.spec.ts` deletes its library page in
  `afterAll`, because `templates.spec.ts` asserts the exact template list Settings offers.
- B-261: the title calls the server op (push → `page.update` → pull → navigate); an offline rename
  is refused with an alert rather than done locally without the link rewrite.

## How to resume

1. `git log --oneline 61279a2..` on the branch; this file's table says what is left.
2. Real-graph copy: `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph/graph.sqlite'"`,
   never a nooklet command on `~/.nooklet/default`.
3. Before each commit: biome on changed files, `pnpm -r typecheck`, unit tests of touched packages,
   e2e specs touched with `NOOKLET_E2E_PORT=6462`.
4. Real-graph browser checks: `bash <scratch>/serve.sh <name>` then `node <scratch>/q4-real.mjs`
   (helpers in `<scratch>/rlib.mjs`; the served client is whatever `apps/web/dist` the last e2e
   run built). Kill with `lsof -ti :6462 | xargs kill`.
