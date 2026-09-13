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

## In flight

(nothing)

## Next steps

1. B-148: web `apps/web/src/live/message-handler.ts` replies `command.result` with `error` when
   `runCommand` throws; server `live/run-remote-command.ts` surfaces it as `invalid` (not a
   timeout). Tests both sides (`message-handler.test.ts`, `live/ops.test.ts`), plus an e2e check if
   cheap (ui_run with a bad date against a real window).
2. `pnpm nooklet verify --data <scratch>/graph` with NOOKLET_DATA exported (after running the ops
   against the copy?) — at least verify the copy before and after a few real block.update calls.
3. e2e: specs that exercise block.update / page.create / page.append / ui_run.

## Decisions

- B-172: `content` accepts both flush-left later lines (what `before` shows) and page_read's
  indented shape (every later non-blank line indented 2+ columns); `old_str` edits are always
  read flush. Rejected: flush-only (silently turns an agent's indented `scheduled::` line, the
  only shape that parsed before, into content text).
- B-151: placements copied from `joinBlockText` (after closed content, else bullet line) rather than
  always on the bullet line, so editing text and `ids: none` text agree.

## How to resume

`git log --oneline cf08d19..m9/server-ops`, then the first unticked step above.
