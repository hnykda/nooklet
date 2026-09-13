# M9 progress — server-ops (server/core op bugs that bite agents over MCP)

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief: B-172 (`block.update` old_str/new_str rejects blocks with a property line or a second
line), B-151 (fence-first block loses properties when serialized without ids), B-235 (`page.create`
markdown drops a page-properties pre-block), B-236 (`page.update` refuses properties on a journal
day), B-148 (`ui_run` command errors come back as a timeout). Then `pnpm nooklet verify` on a
real-graph copy.

Branch `m9/server-ops` from `cf08d19`, worktree
`<repo>/.claude/worktrees/wf_e473942f-106-7`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/server-ops/`
(`graph/graph.sqlite` = backup of the owner's graph taken 10:48; `data/` = NOOKLET_DATA for any
nooklet command). E2E port 6403. Bugs go to `docs/bugs-inbox/server-ops.md` (new numbers
B-310..B-319), never `docs/BUGS.md`.

## Done (committed)

- `f075d2a` B-151 — `core/outline.ts#serializeOutline` places a fence-first block's property lines
  after the closed fence / on the bullet line (no ids). Test: `core/src/outline.test.ts` › "a block
  that opens with a fence, without ids (B-151)". Core 396/396, server 608/608. Logged B-310 (same
  block with a marker; probe `tools/probes/fence-first-task-roundtrip.ts`), not fixed.
- `ba8aa99` B-172 — `outline-bridge.ts#parseSingleBlockGrammar(text, "flush"|"auto")`. Tests:
  `server/src/ops/outline-bridge.test.ts` (13), `server/src/ops/block-update-text.http.test.ts` (9).
  Server 630/630. Spec: mcp-tools.md §3.2 rule 10.
- `d3e1672` B-236 — `page-update.ts` refuses only a real rename of a journal. Test:
  `server/src/ops/page-update-journal.http.test.ts` (3). Server 633/633.
- `51c1361` B-235 — `outline-bridge.ts#checkWriteMarkdown` / `prepareMarkdownInsert(…, "accept" |
  "refuse")`; page.create applies the pre-block as `page.prop` ops (minted AFTER `page.create`: HLC
  order), page.append/block.insert/page.create-append refuse it. Same commit: B-312 (logged + fixed:
  page.append checked markdown after creating its page) and B-172's second cause (empty block with
  only property lines read as a pre-block; sentinel first bullet). Test:
  `server/src/ops/markdown-page-properties.http.test.ts` (12). Logged B-311 (web paste drops a
  pre-block), not fixed. Server 647/647.
- `be17814` progress update.

- `0241b6a` B-148 — web `live/message-handler.ts` replies `command.result {error}` when the command
  throws; server `live/run-remote-command.ts` → `invalid`, `details.reason: "command_failed"`.
  Tests: `apps/web/src/live/message-handler.test.ts` (+2), `server/src/live/ui-run-error.test.ts` (3),
  and new `e2e/tests/agent-ops.spec.ts` (4 tests: B-172, B-235, B-236, B-148 in a real
  control-enabled window; the B-148 one fails with the old client exactly as reported — 500
  "did not respond in time"). Web 1002/1002.

## Real-graph checks (copy of ~/.nooklet/default taken 10:48, in scratch)

- `tools/probes/single-block-roundtrip-graph.ts`: 18,628 live blocks; 1,971 have a multi-line
  before-text; the pre-fix parser refused 1,929; now 0 refused; the only round-trip differences are
  the 20 blocks still holding a literal `SCHEDULED: <…>` line (pre-B-266 import) — re-parsing reads
  it as `scheduled::`.
- `nooklet verify` before any write: OK, 20,411 ops. Then `nooklet serve` on the copy (port 6493)
  and real ops (script `<scratch>/realgraph-ops.mjs`, output `realgraph-ops.log`): DONE→LATER→DONE on
  a scheduled task (scheduled kept, done stamped on the way back), a multi-line block with
  properties, an empty block with only properties, a fence-first block given a property then edited
  inside the fence (before-text shows the property after the fence), journal properties set and a
  journal rename refused, page.create with a pre-block (properties set), page.append with one
  refused and no page created. Server stopped; `nooklet verify` after: OK, 20,442 ops.

## Unit suites at the end (load average 64-110 on the shared machine)

- core: 396/396 on a quiet run after B-151; at the end 395/396 — `tokens.test.ts`'s perf budget
  (2,330 ms vs 500) failed inside the full run and passed alone (59/59); `tokens.ts` is untouched.
  One earlier full run also timed out two `sync.property.test.ts` cases at 30 s; they passed on
  the rerun.
- server: 650 tests; final full run 638 passed, 12 timed out at 5 s in `plugins/built-ins.test.ts`
  and `plugins/host.test.ts` (plugin bundling under load; also timed out alone); with
  `--testTimeout=60000 --hookTimeout=120000` those two files pass 17/17. The last clean full run
  was 647/647 (before B-148 added 3).
- web: 1002/1002 (after the B-148 change). typecheck: clean.

## E2E (port 6403)

- `agent-ops.spec.ts` alone: 4/4.
- Wide run — agent-ops, block-properties, embeds, history, history-later-edits, review-reactivity,
  mirror-live, views, journal-agenda, read-only, selection, page-export, context-menu, connectivity:
  132 passed, 1 failed, 1 skipped. The failure is views.spec.ts "opening the palette while editing
  and closing it hands focus back to the editor" — failed again when views.spec.ts was rerun alone
  (28 passed, 1 failed). That is the known B-161 (and its duplicates B-193/B-213/B-226/B-246/B-270),
  seen on base commits by five workstreams; nothing on this branch touches the palette or focus.

## In flight

(nothing)

## Next steps

All five bugs done. Left open, logged: B-310 (task block opening with a fence — core parser and
OUT-14 shape), B-311 (web paste drops a pre-block). If picking this up again: those two.

## Decisions

- B-172: `content` accepts both flush-left later lines (what `before` shows) and page_read's
  indented shape (every later non-blank line indented 2+ columns); `old_str` edits are always
  read flush. Rejected: flush-only (silently turns an agent's indented `scheduled::` line, the
  only shape that parsed before, into content text).
- B-151: placements copied from `joinBlockText` (after closed content, else bullet line) rather than
  always on the bullet line, so editing text and `ids: none` text agree.
- B-235: `page.create` applies a pre-block (explicit `properties` win); every write into an existing
  page refuses one with a hint. Rejected: applying it on append (silent change to page properties;
  a bullet with only property lines is a pre-block to the parser, so an agent that meant a block
  would never learn it); rejecting on create too (it is page_create's documented job).
- B-236: the simple check (`new_name` present and different → refuse on a journal). Rejected:
  treating a `new_name` that parses to the same day in another title format as no rename (extra
  code for a call nobody makes).
- B-148: a thrown command is `invalid` (retrying unchanged cannot help), not `internal`; the reply
  carries `error` in place of `when_result` so the server can tell them apart. Message capped at
  1,000 chars both sides.

## How to resume

`git log --oneline cf08d19..m9/server-ops`, then the first unticked step above.
