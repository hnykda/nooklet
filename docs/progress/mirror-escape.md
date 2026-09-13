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

- `49431ac` step 1:
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
- `eb2ac30` step 3: `e2e/tests/shaped-line-clipboard.spec.ts` — the bug's own steps (Shift+Enter,
  type `scheduled:: 2026-09-20`, click away), copy the row (`ids: "none"` text) and paste it.
  Base `outline.ts` swapped in: red at the clipboard text (`scheduled::` unescaped); a throwaway
  variant with a loose clipboard check showed the paste gives content `call mom` +
  a real `scheduled` = `2026-09-20` property. Green with the fix. Related e2e specs (block-properties,
  agent-ops, context-menu, mirror-live, page-export, selection, paste-page-properties,
  fence-task-clipboard, journal-agenda, embeds + the new one): 86 passed, 1 skipped, port 6413.
- `a770aaa` step 2: `server/src/ops/shaped-content-lines.http.test.ts` (4: page_read escaped +
  an unrelated old_str edit keeps the line text — on base it silently gave the task a scheduled
  date; old_str copied from page_read edits it and dropping the backslash makes it real; escaped
  markdown writes text next to a real property; content copied from page_read round-trips), and
  `server/src/importer/logseq.test.ts` › "still imports Logseq's property, SCHEDULED and LOGBOOK
  lines as such (OUT-23a)". All 5 red with base `outline.ts` swapped in (the importer one only on
  its escaped-line half; its Logseq half is a guard), green after. `block.update` description +
  mcp-tools.md (§3.2 rule 5, block_update description) name the escape. Server 681/681.
- Real graph copy (`graph/`): `pnpm nooklet verify` OK, 20,446 ops replayed. `nooklet export` with
  the fix vs `graph-before/` (base code): **2 of 953 files change** (`journals/2022_12_16.md`,
  `journals/2023_02_17.md`), 20 lines, every one `SCHEDULED: <…>` → `SCHEDULED\: <…>` — exactly
  the 20 blocks the round-trip probe flagged.
- `164bad9` step 4: inbox B-342 "Fixed 2026-09-13" paragraph with every test; new B-470
  (bullet-shaped later text line → child block), B-471 (`TODO `/`[#A]` text on a plain block →
  task/priority), B-472 (a `foo:: bar` TEXT line becomes a property on the first edit in the app —
  needs owner decision; B-342's fix makes it easier to reach). Probe
  `tools/probes/content-shapes-beyond-b342.ts` shows all three (16 lossless=false lines, 4 controls
  lossless, and the editor payloads). None fixed here: each is a grammar or editor-text decision
  beyond the brief.
- `4b4d279` wiki `Markdown format.md` names the escape.
- Step 5 (this commit), final suites on `4b4d279`: unit core 416/416, server 681/681, web
  1138/1138, other packages 17/17 (one `pnpm -r test` run had `tokens.test.ts` "stays far away from
  quadratic" fail at 817 ms under load; core 416/416 on rerun — tokens.ts untouched). Typecheck
  clean, biome clean on touched files. Whole Chromium e2e suite in three chunks on port 6413 (each
  its own fresh server): 118 passed + 1 skipped; 210 passed + 3 failed; 204 passed + 1 skipped. The 3
  failures are `editing.spec.ts` (3 of 4), reproduced with the six-spec prefix of chunk 2 with the
  BASE `outline.ts` too — a chunking artifact logged as B-473 (today virtual + agenda outliner →
  strict-mode violation; the file-order full run has `a-fresh-journal.spec.ts` first).
  `editing.spec.ts` alone: 4/4.

## Next steps

None — brief done. Left for the owner: B-472 (decision), B-470/B-471 (grammar additions of the
same kind), B-473 (test harness).
