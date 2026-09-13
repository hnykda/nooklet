# M10 progress — core-ops (server, core and data bugs)

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief: B-310 (task block opening with a code fence loses its marker in the mirror / code lines
become children without ids; fix serializer+parser, round-trip test, OUT-14 in
markdown-grammar.md), B-311 (web paste of outline text with a page-properties pre-block drops those
lines), B-322 (`page.backlinks` for an uncreated journal day named by a non-ISO title finds no
linked refs), B-370 (`batch.undo` of rename A→B + create new A fails with page-key-collision; http
test), B-324 (Tasks view row shows one date; show scheduled and deadline when both exist). Then
`pnpm nooklet verify` on a real-graph copy.

Branch `m10/core-ops` from `70c9bb9`, worktree
`<repo>/.claude/worktrees/wf_ced35de1-fb8-3`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m10/core-ops/`
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 13:08; `data/` = NOOKLET_DATA for any
nooklet command). E2E port 6401. Bugs go to `docs/bugs-inbox/core-ops.md` (new numbers
B-390..B-399), never `docs/BUGS.md`.

## Done (committed)

(nothing yet)

## In flight

- B-310: `packages/core/src/outline.ts` (parser opens a fence after marker/priority on line 1;
  OUT-14 lone line keeps the head), `outline.test.ts`, spec OUT-14/OUT-18.

## Findings

- Real graph copy: 0 blocks with marker + fence-first content; 1 live block (`LATER`, id
  `1m287mdbgs5v8t`) whose content opens with a newline — serialized as `- LATER ^id` + continuation,
  and today it re-parses with content `^1m287mdbgs5v8t\n> …` and no id (the ` ^id` suffix regex
  needs the space the marker strip removed). Logging as B-390; same parser line as B-310.

## Next steps

1. B-310 (+B-390) in core, tests, spec, commit.
2. B-322 server `page-backlinks.ts` + http test.
3. B-370 `batch.undo` ordering + http test.
4. B-324 Tasks view both dates + component/e2e test.
5. B-311 web paste pre-block + unit test (+ e2e if cheap).
6. `pnpm nooklet verify --data <scratch>/graph`.
