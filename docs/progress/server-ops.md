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

(nothing yet)

## In flight

- Setup: inbox created with B-310 (found while reading B-151's serializer path; logged, not fixed).

## Next steps

1. B-151: `packages/core/src/outline.ts#serializeOutline` — fence-first block, no suffix id, no
   head: property lines after the content when its fences close, else on the bullet line before the
   fence (the placements `block-text.ts#joinBlockText` uses). Test in `outline.test.ts`.
2. B-172: `packages/server/src/ops/outline-bridge.ts#parseSingleBlockGrammar` — indent lines 2..n
   before parsing; `content` also accepts page_read's indented shape. Tests: outline-bridge unit +
   `ops.http.test.ts` block.update with property / multi-line / fence.
3. B-236: `page-update.ts` — journal check only for a real rename. Test in `ops.http.test.ts`.
4. B-235: page.create applies the markdown pre-block as page properties; page.append/block.insert
   reject one with a hint.
5. B-148: web `message-handler.ts` replies `command.result` with `error` when the run throws;
   server `run-remote-command.ts` surfaces it as `invalid`. Tests both sides.
6. `pnpm nooklet verify --data <scratch>/graph` with NOOKLET_DATA exported.

## Decisions

## How to resume

`git log --oneline cf08d19..m9/server-ops`, then the first unticked step above.
