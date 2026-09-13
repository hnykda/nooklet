# M11 progress — mirror-escape adversarial verification

Resilience log for verifying branch `m11/mirror-escape` (B-342, OUT-23a) from `52e5d20`. Updated
after every meaningful step. Worktree `<repo>/.claude/worktrees/wf_975bcd44-fae-4`,
e2e port 6413, scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/mirror-escape-verify/`
(`graph/` = `.backup` of the owner's graph 18:24, `graph-export/` = same + mirror exported with the
branch code, `reimport/` = that mirror re-imported, `outline-base.ts` = `52e5d20`'s outline.ts).

## Checked (no defect)

- Probe `serialize-property-shaped-content.ts`: 36/36 lossless=true.
- Fuzz, base vs branch `outline.ts` (scratch `fuzz.ts`, `fuzz2.ts`): 100k random blocks built from
  shape fragments (`::`, backslashes, `SCHEDULED`, `<…>`, `:LOGBOOK:`, `:END:`, fences, ids, `č`,
  markers) under every head/id/property combination: 0 blocks that round-tripped on base fail on
  the branch; `parse∘serialize∘parse = parse` on 100k raw texts; every raw text without a backslash
  parses identically on both. With the pre-existing lossy shapes filtered out (B-470/B-471 line
  shapes, leading whitespace after a head, whitespace-only lines, U+2028), 300k blocks: 0 lossy on
  the branch, 12,605 on base.
- Real Logseq files: all 2,158 `.md` files of `~/notes-graph` (journals, pages) and
  `~/logseq/graphs/alphadb/mirror/markdown` parse to identical trees with base and branch code; 0
  lines with a backslash at an escape point.
- Real graph copy (953 pages, 18,633 blocks): `mirror-roundtrip-graph.ts` 0 pages differ;
  `pnpm nooklet verify` OK (20,463 ops); `nooklet export` 953 files, 2 carry escapes
  (`journals/2022_12_16.md` 1 line, `journals/2023_02_17.md` 19 lines); base-vs-branch mirror text
  for every page: 2 pages / 20 lines change, all `SCHEDULED: <…>` → `SCHEDULED\: <…>`. Re-importing
  that exported mirror: same block count, same total content length, same scheduled count (4),
  property multiset equal except 2 `journal-template` tombstone rows (NULL value, not an escape
  matter).
- Unit: core 416/416 (tokens.test.ts perf assertion flaked once under load, green on rerun),
  server 681/681, web 1138/1138.
- Browser (Chromium, port 6413, page `MEV Poznámky/Čeština`): escaped markdown seeds text, mirror
  file shows `foo\::`, page_read shows escapes, focusing and leaving the block writes nothing, an
  agent's old_str dropping the backslash makes a real date that a second context sees.

## Found

- **B-474 (data loss, reachable because of this branch)**: one keystroke in a block whose TEXT has
  a `foo:: bar` line deletes that line outright (typing on another line), or writes `foo` as a
  property and keeps the text line too (typing on that line). 6/6 in the browser. Cause: the
  editor tree overlay (`BlockTree.tsx` tree effect → `withEditText(block, liveBuffer)`) splits the
  untouched buffer on attach, so `treeBefore` already holds `foo` as a property and the diff at
  flush misses it.
- **B-475 (pre-existing, not this branch)**: a content line 1 holding U+2028/U+2029 does not match
  `BULLET_RE` (`.` stops at line separators), so the bullet line reads back as a paragraph with
  `- ` in its text. Same on base.

## Done (committed)

- `a3098dc` this file; `2d48ca1` inbox B-474, B-475.
- `bd1d7f6` B-474 fixed: `withEditText` returns the block for its own editing text;
  `flushPendingEdit` writes nothing for a buffer equal to `before`'s editing text (the second half
  found by an undo/redo probe: the undo's buffer rewrite re-promoted the line 500 ms later and
  emptied redo). Tests: `e2e/tests/text-property-line-keystroke.spec.ts` (4; 3 red before the fix,
  the undo one red with only the first half), web `editText.test.ts` +1 (red before). Web unit
  1139/1139, typecheck clean, biome clean.

## In flight

- Whole Chromium e2e suite in chunks on port 6413 (flushPendingEdit is on every typing path).

## Next steps

1. Finish e2e chunks; rerun any failure once alone before debugging.
2. Report: verdict fixed-up.
