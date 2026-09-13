# M11 progress — mirror-escape (B-342, owner option b)

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief: B-342 — a block content line shaped like a property or a Logseq timestamp (`scheduled::
…`, `foo:: bar`, `marker:: DONE`, `SCHEDULED: <…>`) is written to the markdown mirror verbatim and
read back as a real property, so the mirror is not lossless. Owner-approved fix, option (b): the
serializer escapes such content lines with a backslash (`scheduled\:: 2026-09-20`) and the parser
un-escapes them, in `packages/core/src/outline.ts`, rule added to `docs/spec/markdown-grammar.md`.
Probe `tools/probes/serialize-property-shaped-content.ts` must say lossless=true for every shape;
round-trip tests; `block.update` old_str/new_str on such lines; Logseq importer unaffected for real
files; `pnpm nooklet verify` and a mirror export on a real-graph copy (how many files change).

Branch `m11/mirror-escape` from `52e5d20`, worktree
`<repo>/.claude/worktrees/wf_975bcd44-fae-4`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/mirror-escape/`
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 17:34; `graph-before/` = a copy of it
with the mirror exported by the BASE code (953 files); `data/` = NOOKLET_DATA). E2E port 6413.
Bugs go to `docs/bugs-inbox/mirror-escape.md` (new numbers B-470..B-479), never `docs/BUGS.md`.

## Baseline measurements (base code, 52e5d20)

- Probe `serialize-property-shaped-content.ts`: lossless=false for all 5 shapes.
- `tools/probes/mirror-roundtrip-graph.ts` on the graph copy: 953 pages, 18,630 blocks; 2 pages / 20
  blocks read back differently — the pre-B-266 literal `SCHEDULED: <…>` content lines. These are
  B-342 on the owner's real data: exactly what the fix must bring to 0.
- `nooklet export` of the copy with base code: 953 files, into `graph-before/`.
- Real Logseq graphs (`~/notes-graph` journals+pages, and the DB mirror
  `~/logseq/graphs/alphadb/mirror/markdown`): 0 lines with a backslash before a property's `::`,
  before `SCHEDULED:`/`DEADLINE:`'s colon, or before `:LOGBOOK:` (grep). 1,388 property-shaped
  lines in the file graph. So un-escaping on read changes nothing for the owner's real Logseq files.

## Design (decided here)

- Shapes: exactly what `finalizeNode` consumes by shape — a property line (OUT-18 regex), an org
  `SCHEDULED:`/`DEADLINE: <…>` line (OUT-23 rule 5 regex, validity of the date NOT considered: an
  invalid one is text either way, escaping it is harmless and keeps the rule simple), and a
  `:LOGBOOK:` opener (OUT-23 rule 3 — silently DROPS every content line up to `:END:`; same class,
  same fix, included).
- Escape point: a backslash right before the colon that makes the shape (`key\:: v`,
  `SCHEDULED\: <…>`, `\:LOGBOOK:`). CommonMark renders `\:` as `:`, so the file still reads right
  in any markdown viewer. Escape of the escape: a line with the shape plus k>=0 backslashes at that
  point gets one more on write; on read, k>=1 loses one. Lossless for every string.
- Applied to every content line outside a fence, line 1 included and independent of the block's
  head or id, so `page_read` (ids) and `block.update`'s `before` (no ids) show the same text for the
  same line. Parser: continuation lines un-escaped as they are kept; line 1 after its
  marker/priority/id are stripped.

## Done (committed)

- Step 1 (commit "fix(outline): escape content lines…", hash in the next commit's progress):
  `core/outline.ts` (`SHAPED_LINE_RES`, `escapeShapedLine`/`unescapeShapedLine`,
  `escapeContentLines` in `serializeOutline`, un-escape in `finalizeNode`); spec OUT-23a (+ OUT-23
  rule 6 and its serializer sentence), corpus case 49; tests `core/src/outline.test.ts` › "content
  lines shaped like a property, a timestamp or a drawer (B-342, OUT-23a)" (6; 5 red on the old
  code, the Logseq guard green on both) and 4 new contents in the lossless matrix (both matrix
  tests red on the old code); probe extended to 36 cases (27 lossless=false on base, 0 after).
- After step 1: `mirror-roundtrip-graph.ts` on the graph copy → 0 pages differ (was 2 / 20
  blocks). Unit: core 416/416, server 676/676, web 1138/1138; typecheck clean. One core run had
  `sync.property.test.ts` "converges regardless of interleaving" time out at 5.4 s under load;
  12/12 on rerun alone (does not touch outline).

## Next steps

1. Log the other lossy shapes found by `scratchpad/.../other-shapes.ts` (bullet-shaped
   continuation lines `- `/`* `/`+ `/`1. ` become child blocks; a text starting with a task-marker
   word or `[#A]` becomes a task/priority) as B-470/B-471, with a probe in `tools/probes/`.
2. mcp-tools.md §3.2 rule 5 sentence; `block.update` description sentence (check snapshot tests).
3. `block.update` old_str/new_str http test on an escaped line; importer test (real Logseq
   property line still a property, escaped one text).
4. `pnpm nooklet verify` on `graph/`; `nooklet export` with the fix into `graph/`, diff vs
   `graph-before/`, count files.
5. e2e: not a UI change; decide whether a mirror/page-read e2e is warranted (probably an http test
   is the right level).
