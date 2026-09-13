# rv-server-security — fix the M7 server security review findings: progress

Brief (coordinator, M8 workflow): fix seven confirmed findings from the server security review
(F1, F2, F3, F5, F6, F7, F8; F4 is not this branch's), high severity first. Reproduce each with a
failing test, fix the cause, one commit per finding. Then write
`docs/review/2026-09-13-m7-rv-server-security.md` and commit it last. If this file exists when you
start, you were restarted: read it, then continue from "Next steps".

- Branch `m8/rv-server-security`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-21`.
  The worktree was created at an OLD commit (41666ee, 88 commits behind); the branch was reset to
  `da85cfb` (the agreed start) before any work.
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/rv-server-security/`
  — the reviewer's probes `p1`..`p7` are there; `graph-fix/` is this branch's real-graph copy.
- e2e port 6471. Bugs go to `docs/bugs-inbox/rv-server-security.md`, never `docs/BUGS.md`.

## Bug numbers

| Finding | Bug | Severity |
|---|---|---|
| F1 graph.replace regex on the event loop | B-125 (time half) | high |
| F2 page name > NAME_MAX stalls mirror | B-126 | medium |
| F3 importer follows asset symlinks | B-127 | medium |
| F5 graph.replace builds all output before max_blocks | B-125 (memory half) | low |
| F6 `gc --no-backup` / `--dry-run=true` | B-109 (existing) | low |
| F7 query fence depth/terms | B-129 | low |
| F8 graph.replace regex without `u` | B-128 | low |

## 1. Done

- Inbox entries logged for all seven before any fix.
- F1 (B-125 time half) — commit "fix(server): graph.replace scans in a worker with a 2 s budget".
  Red first: at 25 `a`s `/healthz` answered after 5,010 ms. Green: server suite 57 files / 523
  tests; e2e `replace.spec.ts` 3/3 on 6471 (the tsx-served server runs the eval worker); real-graph
  copy: the three 60 s-killed patterns answer `invalid` in 2.1–2.3 s, `TODO` dry run ~120–250 ms at
  load 24 vs ~75 ms before.

## 2. In flight

- F2.

## 3. Next steps, in order

1. F1 — scan in a `worker_threads` Worker (eval'd JS source) with a 2 s budget; test `(a+)+$`
   over 40 chars expects a prompt 400 `invalid` and `/healthz` answering meanwhile.
2. F2 — `pageFilePath` byte cap + hash suffix; `exportAll` per-page try/catch; `exportPage`
   unlinks the temp file on failure.
3. F3 — `lstatSync` inside the try; symlinks skipped with a warning.
4. F5 — stop at `max_blocks`, output budget, per-block content cap.
5. F6 — `noBackup` reads `backup === false`; `--key=value`; unknown flags rejected for gc/restore.
6. F7 — parser depth and term caps.
7. F8 — `u` flag server + FindReplaceView preview; description notes `\b`/`\w`.
8. Review doc, `pnpm nooklet verify --data graph-fix`, e2e replace spec on 6471.

## 4. Decisions

- F1: the scan runs in a Worker for literal queries too, not only `regex: true`. Measured on the
  real graph copy (`scratchpad/.../tostring/worker-cost.mjs`): a fresh eval worker scanning 18,628
  blocks costs ~20 ms (16 ms of it spawn) against ~2.5 ms inline. One implementation keeps "the
  preview IS the op" and means no pattern of any kind runs on the event loop.
- F1: the worker source is a plain JS string, not `fn.toString()` of a TS function. Probe
  (`tostring/fn.ts`): tsx's esbuild transform injects `__name(...)` into inner arrow functions and
  classes, which would be a ReferenceError inside the worker in dev only. A file-path worker would
  break the desktop sidecar, which esbuild-bundles the server into one `server.mjs`.
- F1: awaiting the worker opens a macrotask gap between the SELECT and `applyOps` that did not exist
  before; `/sync/push` does not take `writeLock`, so a device edit could land in between and be
  overwritten by text computed from the old content. The real run re-reads the matched blocks right
  before `applyOps` (no await in between) and answers 409 `conflict` if any changed.
