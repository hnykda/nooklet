# Bugs inbox — rv-server-security (M8 server security review fixes)

Entries in `docs/BUGS.md` format, to be folded in by the integrator. Numbers from this branch's
range B-125..B-129. Seven findings, five numbers: F1 and F5 (both "graph.replace does unbounded
work before refusing") share B-125, and F6 is logged against B-109, whose fix introduced it.
Findings, evidence and verifier notes: `docs/review/2026-09-13-m7-rv-server-security.md`.

---

### B-125 · `graph.replace` does unbounded work on the server's only thread: a backtracking regex freezes it, a long replacement balloons memory
**Status:** time half fixed, memory half open · **Severity:** high · **Found:** 2026-09-13, server
security review (F1, F5) · **Test:** `packages/server/src/ops/graph-replace.test.ts` "a backtracking
pattern is refused within the time budget, and the server answers meanwhile (B-125)";
`graph-replace.race.test.ts`

**Time (F1).** `compileQuery` rejects only invalid patterns and patterns that match the empty
string. The handler then runs `matchAll`/`replace` synchronously over every live block (18.6k on
the owner's graph). A pattern with nested quantifiers backtracks exponentially on ordinary text,
and while it does, the one Node process answers nothing: not `/healthz`, `/sync`, the web UI, or
MCP. `(a+)+$` over one block of 24 `a`s and a `!` took 2.3 s and `/healthz` was answered only
after it; `(\w+\s?)+:` against a copy of the real graph was killed after 60 s (`\w` is ASCII-only,
so every Czech letter is a backtracking point). `FindReplaceView` sends a `dry_run` 250 ms after
typing stops, so a half-typed pattern is enough; `dry_run` runs the same scan.

**Memory (F5).** The handler builds the replaced text of EVERY matching block before comparing the
count with `max_blocks`. A one-letter query with a 2,000-char replacement on the real graph built
about 1 GB of strings (rss 1,074 MB) to answer 413 `too_large`, even with `dry_run`. When
`max_blocks` is raised and the call goes through, the rewritten text is written with no size
check (`block.update` caps content at 100,000 chars; `graph.replace` checked nothing).

**Fixed 2026-09-13 (time).** The scan — literal and regex alike — runs in a `worker_threads`
Worker (`ops/replace-scan.ts`) that is terminated after 2 s; a regex timeout is 400 `invalid`
("the pattern took too long to run"). The worker body is an eval'd JavaScript string: tsx injects
`__name` helpers into a TS function's `toString()`, and a worker file would not survive the
desktop sidecar's single-file bundle. Awaiting the worker opened a gap between the SELECT and
`applyOps` in which a `/sync/push` (which does not take `writeLock`) could edit a matched block, so
the real run re-reads the matched blocks just before writing and answers 409 `conflict` if any
changed. Before the fix the new test, at 25 `a`s, saw `/healthz` answered after 5,010 ms; after,
the 40-`a` case is refused in ~2 s with `/healthz` answered at once. On a copy of the owner's graph
`(\w+\s?)+:`, `(\S+\s*)+\?` and `^(.*?,)*x$` (each killed after 60 s before) return `invalid` in
2.1–2.3 s. Cost: a `TODO` dry run went from ~75 ms to ~120–250 ms with the machine at load 24
(~20 ms of worker overhead idle). Tests: `graph-replace.test.ts` "a backtracking pattern is refused
within the time budget, and the server answers meanwhile (B-125)"; `graph-replace.race.test.ts`
(fails with 200 instead of 409 when the re-check is disabled).

---

### B-126 · A page name longer than NAME_MAX stalls the live mirror, leaks a temp file per sweep, and makes `nooklet export` throw
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, server security review (F2) ·
**Test:** `packages/server/src/mirror/export.test.ts` "pages whose file cannot be written as named
(B-126)"; `mirror/live.test.ts` "a page name past NAME_MAX neither stalls later sweeps nor leaves
temp files behind (B-126)"

`pageFilePath` names the file `pageNameToFileName(name) + ".md"` with no byte limit. Page names
may be 512 characters, Czech letters take 2 UTF-8 bytes and unsafe characters become 3-byte
`%XX`, so a name easily exceeds the filesystem's 255-byte limit. `exportPage` writes the temp file,
`renameSync` throws `ENAMETOOLONG`, and the temp file is never removed. The error escapes
`exportAll`'s loop, so every page after it in the loop is not written and the stale-file prune
never runs (deleted pages keep their `.md`). The live mirror (B-95) sweeps after every commit and
the failing page never gets a `mirror_file` row, so each sweep leaves another `.xxxx.tmp` in
`pages/`; `nooklet export` aborts. `block.to_page` names a page after a block's first line, and
921 live blocks on the owner's graph have a first line over 252 bytes.

**Fixed 2026-09-13.** Three changes in `mirror/export.ts`. `pageFilePath` shortens a file-name base
past 200 UTF-8 bytes to a prefix cut on a code-point boundary (never inside a `%XX` escape) plus
`~<8 hex of sha256(name)>`, and `exportPage` then writes the full name into the file as `title::`
(what the Logseq importer reads a page name from), so the mirror stays lossless. `exportAll`
catches per page, reports `failed: [{ pageId, error }]` and still runs the prune; the live mirror
logs failures, `nooklet export` exits 1 when there were any. `exportPage` unlinks its temp file
when the rename throws. The new tests fail on the old code with `ENAMETOOLONG`, `EISDIR` and a
leaked `.tmp`. On a copy of the owner's graph (longest page name 111 bytes) `nooklet export` wrote
all 952 pages with `failed: []` and no shortened names. Tests: `mirror/export.test.ts` "pages whose
file cannot be written as named (B-126)" (3); `mirror/live.test.ts` "a page name past NAME_MAX
neither stalls later sweeps nor leaves temp files behind (B-126)".

---

### B-127 · The Logseq importer follows symlinks in `assets/` out of the graph, and one dangling symlink aborts the import
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, server security review (F3) ·
**Test:** `packages/server/src/importer/logseq.test.ts` "does not follow a symlink in assets/ out of
the graph (B-127)", "a dangling symlink in assets/ is a warning, not an aborted import (B-127)",
"does not follow assets/ itself when it is a symlink (B-127)"

`importAssets` checks `statSync(path).isFile()`, which follows symlinks, then reads the target. A
symlink in a graph's `assets/` pointing anywhere (say `~/.ssh/id_ed25519`) is stored as an asset,
served without authentication at `/assets/:id` (unauthenticated by design, `http/assets.ts`) and
synced to every device. A graph received from someone else is where such a link would come from.
Separately, the `statSync` sits outside the `try`, so a broken symlink (common in synced folders)
throws `ENOENT` out of `importLogseqGraph` after some assets were already stored.

**Fixed 2026-09-13.** `importAssets` lists `assets/` with `withFileTypes` (Dirent types come from
lstat) and skips a symbolic link with the warning `assets/<name>: a symbolic link, not followed`,
so a dangling one no longer throws; an `assets/` directory that is itself a link is not followed
either (warning, nothing imported). Pages and journals were already listed by Dirent and so never
followed links. The owner's Logseq graph has no symlinks in `assets/` (180 entries, 0 links):
importing it into a scratch data dir gave 127 pages, 825 journals, 18,628 blocks, 171 assets,
0 dangling asset links, no symlink warnings. Tests: `importer/logseq.test.ts` "does not follow a
symlink in assets/ out of the graph (B-127)", "a dangling symlink in assets/ is a warning, not an
aborted import (B-127)", "does not follow assets/ itself when it is a symlink (B-127)" — the first
and third failed on the old code with an asset row created, the second with `ENOENT … stat`.

---

### B-128 · `graph.replace` regexes are compiled without the `u` flag, so Unicode classes silently match nothing
**Status:** open · **Severity:** low · **Found:** 2026-09-13, server security review (F8) ·
**Test:** —

Flags are `g`/`gi`. Without `u`, `\p{Lu}` is an identity escape for the literal text `p{Lu}`, so
`\p{Lu}\p{Ll}+` previews zero matches on "Schůzka s Alešem: Černá kniha" with no error. `\w` and
`\b` are ASCII-only either way, so `Ale\w+` misses "Alešem" and `\bAleš\b` matches inside it — a
real run would rewrite part of a longer word — and the op description does not say so.
`FindReplaceView`'s highlight matcher uses the same flags.

---

### B-129 · A deeply nested or very long query fence throws out of `parseQuery` or breaks the SQL prefilter
**Status:** open · **Severity:** low · **Found:** 2026-09-13, server security review (F7) ·
**Test:** —

`query.ts` promises "never throws", but `Parser.parseUnary` recurses once per `(` and `not` with no
depth cap: 20,000 nested parentheses or 30,000 `not`s overflow the stack, and `parseQuery` re-throws
the `RangeError` instead of returning `{ ok: false }`. `joinSql` emits a flat `a AND b AND …`, so
1,001 `not`s or ~1,000 juxtaposed words produce SQL that SQLite refuses ("Expression tree is too
large (maximum depth 1000)"). Query fences are block content, sync to every device, and any writer
(an MCP agent included) can author one; the client parses them in a `createMemo`
(`QueryFenceView.tsx`).

---

### B-109 (existing)
**Status:** open (regression of the B-109 fix) · **Severity:** low · **Found:** 2026-09-13, server security review (F6) ·
**Test:** —

Follow-up: B-109's fix (`--no-x` becomes `flags.x = false`) left `nooklet gc` reading
`flags.get("no-backup")`, a key that no longer exists, so the documented `--no-backup` silently did
nothing (fails safe: a backup was always taken). The grammar also never split `--flag=value`, so
`nooklet gc --dry-run=true` became a flag named `dry-run=true`, `dryRun` was false, and gc dropped
ops and unlinked orphan assets — the flag meant to make gc safe ran the destructive action.
