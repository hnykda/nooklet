# Server security review (M7 code) — fix pass, 2026-09-13

Brief from the coordinator (M8 workflow): fix the findings of the server security review of the M7
code, each already confirmed by an independent skeptic; reproduce each first with a failing test,
fix the cause, one commit per finding, high severity first; if one does not reproduce, say so and
leave it. Branch `m8/rv-server-security`, from `da85cfb`.

This document is the record of that pass: what the findings were, what was changed, what was not
and why, and what is still unverified. Bug entries (B-125..B-129, plus a follow-up on B-109) are
in `docs/bugs-inbox/rv-server-security.md`, to be folded into `docs/BUGS.md` by the integrator.
The resumable state of the work is `docs/progress/rv-server-security.md`.

## Scope

Seven findings: F1, F2, F3, F5, F6, F7, F8. F4 belongs to another branch and was not looked at.

Read for this pass: `packages/server/src/ops/graph-replace.ts` and its tests, `ops/trial-lock.ts`,
`ops/dry-run.ts`, `ops/batch.ts`, `ops/registry.ts#runOpHandler`, `apply-ops.ts#serverApplyOps`
(to know what can interleave with an `await`), `mirror/export.ts`, `mirror/live.ts`,
`importer/logseq.ts` (asset and file listing), `cli.ts` (`gc`, `restore`, `export`),
`cli-args.ts`, `packages/core/src/query.ts` (parser, `parseQuery`, `queryPrefilter`),
`apps/web/src/views/FindReplaceView.tsx`, `apps/desktop/build-sidecar.mjs` (how the server is
bundled, which decided how the worker is loaded), `e2e/global-setup.ts`.

Real data used: a `.backup` copy of `~/.nooklet/default` (952 pages, 18,628 blocks, 2.9 M
characters of block text, 20,411 ops) and a read-only import of the owner's Logseq graph
(`~/notes-graph`) into a scratch data dir.

## Findings, by severity

| # | Bug | Severity | Where (at `da85cfb`) | What |
|---|---|---|---|---|
| F1 | B-125 | high | `packages/server/src/ops/graph-replace.ts:160` (`compileQuery` 27–47) | A user regex runs synchronously over every live block on the only thread. `(a+)+$` over 25 `a`s held `/healthz` for 5,010 ms; on the real graph `(\w+\s?)+:`, `(\S+\s*)+\?`, `^(.*?,)*x$` did not finish in 60 s. FindReplaceView's debounced dry run makes a half-typed pattern enough. |
| F2 | B-126 | medium | `packages/server/src/mirror/export.ts:186`, `:215`, `:278` | No byte limit on the mirror file name. A page name past 255 bytes throws `ENAMETOOLONG` at the rename, leaks the temp file, aborts `exportAll` before later pages and the prune; the live mirror repeats it every sweep; `nooklet export` throws. |
| F3 | B-127 | medium | `packages/server/src/importer/logseq.ts:363` | `statSync(...).isFile()` follows symlinks: `assets/pic.png -> ~/.ssh/id_ed25519` in a received graph becomes an asset served unauthenticated at `/assets/:id`; a dangling link throws `ENOENT` out of the whole import. |
| F5 | B-125 | low | `packages/server/src/ops/graph-replace.ts:168` | Every replaced string is built before `max_blocks` is checked, and nothing checks the result against the content cap. On the real graph `e` → 2,000 chars peaked at 1,091 MB rss to answer 413; with `max_blocks: 20000` it succeeded at 2,001 MB and would have written blocks of 250,949 characters. |
| F6 | B-109 (existing) | low | `packages/server/src/cli.ts:594`, `cli-args.ts:29` | After B-109, `--no-backup` sets `backup=false` but gc read `no-backup`; `--flag=value` was never split, so `gc --dry-run=true` ran for real. Reproduced on a graph copy: a backup under `--no-backup`, 20,404 of 20,411 ops dropped under `--dry-run=true`. |
| F7 | B-129 | low | `packages/core/src/query.ts:657`, `:735`, `:1107` | No depth or filter limit in the query-fence parser: 20k `(` or 30k `not` throw `RangeError` out of `parseQuery` (which promises never to throw); ~1,000 words exceed SQLite's expression depth. In Chromium both fences rendered as raw code with no error. |
| F8 | B-128 | low | `packages/server/src/ops/graph-replace.ts:28`, `apps/web/src/views/FindReplaceView.tsx:42` | Regexes compiled without `u`: `\p{Lu}` is literal text and silently matches nothing (`Č\p{Ll}+` matched 0 blocks on the real graph, 17 with `u`). |

All seven reproduced; none was left for not reproducing.

### Found while fixing

- **The first F5 fix could abort the server.** Commit `8ddae71` capped the scan worker's heap
  (`resourceLimits.maxOldGenerationSizeMb: 256`) as a backstop. Checking which limit a test had
  actually hit showed that one 199,000-character block times a 2,000-character replacement —
  reachable over HTTP, `page.create` allows 200,000 characters — did not end the worker but
  aborted the whole process ("FATAL ERROR: Reached heap limit", exit 134). Fixed in `3d01f11` by
  computing each block's replaced length before building it and dropping the cap;
  `tools/probes/worker-heap-cap-abort.mjs` reproduces the abort. Logged in B-125's entry.
- **Moving the scan off the event loop opened a write race.** Before F1 there was no `await`
  between reading the candidate rows and `applyOps`. Awaiting the worker lets a `/sync/push` —
  which does not take `writeLock` — change a matched block in between, and the replacement,
  computed from the old text, would have overwritten the device's edit. The real run now re-reads
  the matched blocks right before `applyOps` (no `await` in between) and answers 409 `conflict`.
  Covered by `ops/graph-replace.race.test.ts`. `graph.replace` has no savepoint open across that
  `await` (it is not built on `runWithDryRun` and is not a `batch` step), so the
  `ops/trial-lock.ts` invariant is untouched.
- **`e2e/tests/views.spec.ts:461`** ("opening the palette while editing and closing it hands focus
  back to the editor") fails on this branch, and fails the same way with every source file this
  branch changed checked out at `da85cfb`. Not caused here and not investigated; no bug number was
  left in this branch's range to log it under.

## What changed (commits, oldest first)

1. `c533125` fix(server): graph.replace scans in a worker with a 2 s budget (B-125) — F1.
   `ops/replace-scan.ts`: the scan runs in an eval'd `worker_threads` Worker, terminated after
   2 s; a regex timeout is 400 `invalid`. The worker body is a JavaScript string, because tsx
   injects `__name` helpers into a TS function's `toString()` (`tools/probes/tsx-function-tostring.ts`)
   and a worker file would not survive the sidecar's single-file esbuild bundle. Literal queries go
   through it too: ~20 ms of worker overhead on the real graph when idle, and one implementation.
   Pre-write re-check and 409 `conflict` (above). Spec §4.3.28 and the op description updated.
2. `3f77bf9` fix(server): the mirror survives a page name past NAME_MAX (B-126) — F2.
   `pageFilePath` shortens a base past 200 UTF-8 bytes to a code-point-safe prefix (never cutting
   a `%XX`) plus `~<8 hex of sha256(name)>`, and `exportPage` writes the full name as `title::` so
   the mirror stays lossless; `exportAll` isolates per-page failures (`failed: [...]`) and still
   prunes; the temp file is removed when the rename fails; `nooklet export` exits 1 on failures.
3. `3389bd1` fix(server): the Logseq importer never follows a symlink in assets/ (B-127) — F3.
   Dirent (lstat) types; a link is skipped with a warning; a symlinked `assets/` is not followed.
4. `8ddae71` fix(server): graph.replace stops building text it will refuse (B-125) — F5. Past
   `max_blocks` the worker stops holding text but keeps counting; a 20 M-character output budget;
   a block grown past 100,000 characters (`block.update`'s cap) is refused, while an already
   longer block may still be edited if the edit does not grow it (the real graph has a
   120,016-character block). Also added the heap cap that item 7 removes.
5. `fe5837a` fix(cli): gc --no-backup and --flag=value work; gc and restore refuse unknown flags
   (B-109) — F6. `parseArgs` splits `--key=value`; `parseGcFlags` lives in `cli-args.ts` where it
   is tested; `checkFlags` for `gc`/`restore`; `booleanFlag` rejects values it does not know.
   `docs/OPERATIONS.md` §5.
6. `e377269` fix(core): query fences refuse more than 32 levels of nesting or 100 filters (B-129)
   — F7. Checked before recursing; errors in words; ADR 011 records the limits; new
   `e2e/tests/query-limits.spec.ts`. `joinSql` still emits a flat chain — at 100 filters its SQL
   depth is far inside SQLite's 1,000, so a balanced tree was not needed.
7. `47186b3` fix(server,web): graph.replace regexes run in Unicode mode (B-128) — F8. `gu`/`giu`
   on the server and in FindReplaceView's highlight; the description says `\w`/`\b` stay
   ASCII-only and gives `(?<![\p{L}\p{N}_])word(?![\p{L}\p{N}_])`. New
   `e2e/tests/replace-unicode.spec.ts`.
8. `6b492d2` docs(progress): the heap-cap abort found, before fixing it.
9. `3d01f11` fix(server): graph.replace refuses an oversized block before building it; no worker
   heap cap (B-125). Exact replaced length per block from the matches — literal lengths, or
   ECMA-262 GetSubstitution lengths for `$`-templates — checked before `String.replace` runs; the
   worker throws if a built string ever disagrees. A table test pins every template form (removing
   the two-digit `$nn` rule fails it).
10. `25e3951`, `2d384e4` docs(probes): `worker-heap-cap-abort.mjs`, `tsx-function-tostring.ts`.
11. This document.

## Verification

- Every fix was red first: the new unit tests failed on the unfixed code (the F1 case at 25 `a`s
  with `/healthz` at 5,010 ms; F2 `ENAMETOOLONG`/`EISDIR`/leaked `.tmp`; F3 an asset row and
  `ENOENT`; F5 200 instead of 413; F6 missing wiring; F7 `RangeError`; F8 zero matches; the heap
  cap a SIGABRT of the vitest worker). The two new e2e specs failed against the unfixed sources
  (fences rendered as raw code; "No matches.") and pass with them. F6 was also reproduced
  end-to-end with the CLI on a graph copy, and re-run after the fix.
- `pnpm -r typecheck`: clean at every commit. `pnpm exec biome check`: no new diagnostics (the two
  `useOptionalChain` warnings in `core/query.ts` predate this branch).
- `pnpm -r test` at `2d384e4` (the last code commit): 149 files, 1,579 tests, all passing (core
  334, plugin-api 17, server 544, web 684). Each package's suite was also green before each
  commit that touched it.
- e2e on port 6471, Chromium: `replace`, `replace-unicode`, `query`, `query-limits`, `refactor`,
  `views` — 48 passed, 1 failed (`views.spec.ts:461`, pre-existing, above). After `3d01f11`:
  `replace`, `replace-unicode`, `query-limits`, `refactor` 11/11.
- Real graph copy: `nooklet verify` OK (20,411 ops); a real `graph.replace` of `TODO` → `TO-DO`
  (168 blocks) and its `batch.undo`, then `verify` OK again (22,765 ops); `nooklet export` wrote
  952 pages with `failed: []`; the three patterns killed at 60 s before answer `invalid` in
  2.1–2.3 s; `e` → 2,000 chars peaks at ~225 MB rss (1,091 MB before). The owner's Logseq graph
  imports as before: 127 pages, 825 journals, 18,628 blocks, 171 assets, no symlink warnings.

## Left alone, and why

- **F3, `pages/` and `journals/` as symlinked directories** are still followed. Their files were
  already listed by Dirent (a symlinked `.md` file is skipped), and what they produce is block
  text behind authentication, not an unauthenticated asset URL.
- **F6, unknown-flag refusal** covers `gc` and `restore`, the two destructive commands, as the
  finding asked — not `serve`, `import` or the rest.
- **F1, a warm worker pool.** A fresh worker per call costs ~16 ms of spawn when idle and was
  ~50–150 ms under the shared machine's load of 24. Not worth a pool's lifecycle and respawn logic
  for a debounced preview.
- **F1, a regex that overflows V8's backtracking stack** would reach the worker's `error` event
  and come back as a 500 `internal` rather than 400 `invalid`. Not reproduced; not handled.
- **F2, Windows-specific names** (reserved names like `CON`, trailing dots or spaces) are not
  handled; only the length is.
- **F8, FindReplaceView's highlight** still runs the regex on the browser's main thread, over at
  most 200 returned blocks the server already scanned within its budget.
- **`views.spec.ts:461`** — pre-existing, another area; reported to the coordinator.

## Still unverified

- **The desktop sidecar.** The eval'd worker was exercised under vitest, under tsx (`nooklet
  serve` in e2e and every probe), but not in the esbuild-bundled `server.mjs` the Tauri app ships.
  The reasoning — the worker body is a string and `require("node:worker_threads")` inside an eval
  worker is Node's own loader, untouched by the bundle — was not tested by building the sidecar.
- **The 2 s budget under load.** No legitimate scan was measured anywhere near it (a `TODO` dry
  run on the real graph was ≤ 255 ms at load 24), but a much larger graph on a slow machine could
  see a literal search refused as `too_large`, or a regex as `invalid`, that would have finished.
- **The pre-write re-check against a real race** is tested by holding the scan open with `vi.mock`
  and pushing through `/sync/push`, not by two real devices against a running server.
- **NTFS.** The 200-byte file-name base was chosen to fit APFS/ext4's 255 bytes and NTFS's 255
  UTF-16 units; only macOS (APFS) was exercised.
- **Browsers other than Chromium** for the query-fence error and the Unicode highlight.
- **Exactness of the replaced-length computation** is pinned by a table of templates, compared
  against V8's own `String.prototype.replace`, and backed by the worker's mismatch check; it was
  not fuzzed.
