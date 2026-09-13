# M10 progress — core-ops adversarial verification

Resilience log for the agent verifying branch `m10/core-ops` (B-310, B-311, B-322, B-324, B-370,
B-390). Updated after every meaningful step.

Worktree `<repo>/.claude/worktrees/wf_ced35de1-fb8-3`, e2e port 6401. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m10/core-ops-verify/`
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 13:44; `old/outline-old.ts` = 70c9bb9's
parser for old-vs-new comparisons; `fuzz-outline.ts`, `logseq-parse-diff.ts`). New bug numbers
B-391..B-399 in `docs/bugs-inbox/core-ops.md`.

## Done

- Re-ran unit suites on a016b31: core 406/406, server 673/673, web 1132/1132; typecheck clean;
  biome clean on the 17 changed files.
- Old-vs-new `parseOutline` on every `.md` of the owner's Logseq graphs (alpha 952 files, roam 759,
  beta 1, test 6): 0 files parse differently. The B-310 parser change does not touch Logseq import.
- Random round-trip fuzz (serialize → parse, both id modes, closed fences only), old vs new: new
  code fixes ~13k of 30k generated pages; the remaining "regressions" are the spec-documented
  ambiguity (content = blank line then fence, on a block with a head or id) and literal `^id` text.
- Read B-370 ordering (DFS over name claims), B-322 key change, B-311 pre-block, B-324 labels.

## In flight

- e2e of the related specs on port 6401; browser check of the Tasks view at phone width.

## Next

- Own tests for the riskiest edges; fix anything real; commit each green step.
