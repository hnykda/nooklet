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
  — the reviewer's probes `p1`..`p7`, this pass's `p10`..`p12`, `graph-fix/` (real-graph copy,
  now with a replace + undo in its op log), `graph-gc/` (disposable, gc ran on it), `import-f3/`.
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

All seven fixed, each red first. Commits, oldest first:

- `c533125` F1 (B-125 time) — scan in an eval'd worker with a 2 s budget; pre-write re-check and
  409 `conflict`. Red: `/healthz` at 5,010 ms (25 `a`s). Real graph: the three 60 s-killed
  patterns answer `invalid` in 2.1–2.3 s.
- `3f77bf9` F2 (B-126) — shortened hash-suffixed file names + `title::`; per-page failure
  isolation; temp file cleanup. Real graph `nooklet export`: 952 pages, `failed: []`.
- `3389bd1` F3 (B-127) — assets listed by Dirent, symlinks skipped with a warning, symlinked
  `assets/` not followed. Owner's Logseq graph imports as before (171 assets, no warnings).
- `8ddae71` F5 (B-125 memory) — max_blocks stops holding text, output budget, per-block cap.
  Real graph: `e` → 2,000 chars 1,091 MB → ~210 MB rss. (Its heap cap was wrong — see `3d01f11`.)
- `fe5837a` F6 (B-109) — `--key=value`, `parseGcFlags`, unknown flags refused for gc/restore.
  Reproduced and re-checked with the CLI on a graph copy.
- `e377269` F7 (B-129) — parser depth 32 / filters 100; new `e2e/tests/query-limits.spec.ts`.
- `47186b3` F8 (B-128) — `gu`/`giu` server and web; new `e2e/tests/replace-unicode.spec.ts`.
- `6b492d2` progress note: heap-cap abort found in `8ddae71`.
- `3d01f11` B-125 correction — exact replaced length before building, no `resourceLimits`. Red:
  the 199,990-char test SIGABRTed the vitest worker.
- `25e3951`, `2d384e4` — `tools/probes/worker-heap-cap-abort.mjs`, `tools/probes/tsx-function-tostring.ts`.
- Last commit: `docs/review/2026-09-13-m7-rv-server-security.md` and this file.

Final numbers: `pnpm -r test` 149 files / 1,579 tests green; `pnpm -r typecheck` clean;
`nooklet verify` on graph-fix OK (22,765 ops after a real replace + undo); e2e on 6471: replace,
replace-unicode, query, query-limits, refactor, views 48/49 (the one failure, `views.spec.ts:461`,
also fails at `da85cfb`); after `3d01f11` replace, replace-unicode, query-limits, refactor 11/11.

## 2. In flight

- Nothing. Task complete.

## 3. Next steps

- None on this branch. For the integrator: fold `docs/bugs-inbox/rv-server-security.md` into
  `docs/BUGS.md`; `views.spec.ts:461` is failing on `da85cfb` and has no owner here.

## 4. Decisions

- F1: the scan runs in a Worker for literal queries too, not only `regex: true`. Measured on the
  real graph copy (`scratchpad/.../tostring/worker-cost.mjs`): a fresh eval worker scanning 18,628
  blocks costs ~20 ms (16 ms of it spawn) against ~2.5 ms inline. One implementation keeps "the
  preview IS the op" and means no pattern of any kind runs on the event loop.
- F1: the worker source is a plain JS string, not `fn.toString()` of a TS function —
  `tools/probes/tsx-function-tostring.ts`: tsx injects `__name(...)` into inner arrow functions and
  classes, a ReferenceError inside the worker in dev only. A file-path worker would break the
  desktop sidecar, which esbuild-bundles the server into one `server.mjs`.
- F1: awaiting the worker opens a macrotask gap between the SELECT and `applyOps` that did not exist
  before; `/sync/push` does not take `writeLock`, so a device edit could land in between and be
  overwritten by text computed from the old content. The real run re-reads the matched blocks right
  before `applyOps` (no await in between) and answers 409 `conflict` if any changed.
- F5: no `resourceLimits` on the worker — `tools/probes/worker-heap-cap-abort.mjs one` aborts the
  whole process at a 256 MB cap. Memory is bounded by computing each block's replaced length
  (literal lengths or GetSubstitution lengths) before building it.
- F5: the per-block cap refuses growth past 100,000 characters but allows an edit that does not
  grow an already longer block (the real graph has a 120,016-character block).
- F7: limits in the parser (32 levels, 100 filters) rather than a balanced `joinSql`; at 100
  filters the prefilter SQL is far inside SQLite's depth of 1,000.
- Bug numbers: seven findings, five numbers (B-125..B-129) — F1+F5 share B-125, F6 is logged
  against B-109, whose fix caused it.
