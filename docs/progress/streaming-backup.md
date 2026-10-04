# Streaming backup and restore (production incident 2026-10-04)

Branch: `worktree-agent-ac52b47091f4501ac`, built on c9d993b plus the cli-fixes branch
(`worktree-agent-a43102892280a2b63`: `restore --graph`, stale WAL/SHM deletion), merged first.

## Problem

A ~280 MB graph (50 MB db + ~230 MB assets) OOMKills `nooklet backup` in a 512 MiB job:
`createBackup` read the VACUUM'd db and every asset whole, `createTarGz` `Buffer.concat`ed them and
`gzipSync`ed the lot. Restore did the mirror image (`readFileSync` + `gunzipSync` + every entry as a
Buffer). Peak memory was a multiple of the graph size.

## Design (done)

- `tar.ts` keeps the old in-memory `createTarGz`/`readTarGz` (tests use `readTarGz` as "the old
  reader") and adds `writeTarGzFile` / `readTarGzFile`. Same byte format: one gzip member around a
  plain ustar stream, so old and new readers read each other's archives, and so does `tar`.
- Backup: `VACUUM INTO` a snapshot first (consistency argument unchanged in `index.ts`'s header),
  then stream manifest -> graph.sqlite -> assets through one `createGzip`, `createReadStream` per
  file (64 KiB), a for-await drain into the output FileHandle, `drain` waits for backpressure. One
  `drain` listener per wait (racing every wait against the drain promise leaked one reaction per
  wait: heap grew 12 -> 19 MB over 2 GiB before that was fixed). Sizes are checked against the
  header (a file that grows/shrinks mid-backup fails the backup rather than corrupting the archive).
- Output goes to `<out>.partial-<nonce>`, fsync, rename, fsync dir. The snapshot sits beside the
  output (`.nooklet-snapshot-<nonce>.sqlite`), not in `os.tmpdir()`, which can be a memory-backed
  emptyDir in a pod. Leftovers from a killed backup older than 6 h are swept by the next backup
  into the same directory (6 h so an overlapping nightly and pre-deploy backup never collide).
- Gzip level: stored (level 0) for already-compressed extensions (jpg/png/gif/webp/heic/video/
  audio/zip/…), level 6 for the db and everything else, switched between entries with
  `gz.params` (awaited, so nothing is in flight when it changes). Measured: 50 MiB random bytes take
  ~760 ms at level 1 or 6 and save 0 bytes, 21 ms at level 0; the 169 MiB test db is 63 MiB at
  level 1 (1.3 s) and 60 MiB at level 6 (2.7 s).
- Restore: refuse-to-clobber check first, then stream into `<graphDir>/.restore-<rand>/` (same
  filesystem, so renames are atomic). The manifest is the first entry and is validated as soon as
  it is read (wrong format / newer schema refused before extracting hundreds of MB). After
  extraction: manifest present, `graph.sqlite` present, opens and `user_version <= SCHEMA_VERSION`.
  The parser verifies every tar header checksum, requires the end-of-archive marker, and drains the
  gzip stream to its end so the CRC-32 trailer is always checked. Then swap: delete live
  `-wal`/`-shm` (cli-fixes), move old `assets/` aside, rename new `assets/`, rename `graph.sqlite`
  last; staging deleted. `PRAGMA quick_check` was tried and dropped: 5 s on 169 MiB, and the gzip
  CRC already proves the bytes are the archived ones.
- Behaviour change: `restore --force` now makes `assets/` exactly the archive's (old code wrote
  over files but kept extra ones). Documented in docs/OPERATIONS.md §3.
- `createBackup`, `restoreBackup` and `runGc` are now async; cli.ts and gc.test.ts updated.

## Measurements

Method: `tools/probes/backup-memory.mjs` builds a synthetic graph (1,500 imported Logseq-shaped
pages, 61,500 ops, 169 MiB db, plus random-byte "photos" of 2 MiB each), bundles `cli.ts` with
esbuild exactly as `apps/desktop/build-sidecar.mjs` does for the Docker image, and runs each command
as one node process under `/usr/bin/time -l` (macOS, peak RSS). Not tsx: under tsx the CLI costs
~190 MiB RSS just to print `--version`. The bundle's floor is 89 MiB (`--version`).
"Old" = the same graph through a bundle of c9d993b+cli-fixes code.

400 MB graph (169 MiB db + 230 MiB assets, 115 files), archive 284 MiB:

| | old | new (default flags, 3 runs) | new, `--max-semi-space-size=2` |
|---|---|---|---|
| backup peak RSS | **1465 MiB** | 183 / 194 / 205 MiB | **137 MiB** |
| restore peak RSS | **1382 MiB** | 182 / 185 / 230 MiB | **120 MiB** |
| backup wall | 12.0 s | 7.6–8.7 s | 8.5 s |
| restore wall | 0.9 s | 1.3–1.4 s | 0.9 s |

Earlier runs: 520 MB graph (350 MiB assets) old 1957 / 1775 MiB; new backup over 2 GiB of sparse
assets 239 MiB (tsx-free bundle) — bounded, with RSS creeping ~25 MiB over 2 GiB while JS heap and
`external` stayed flat (malloc arenas). `--max-old-space-size=128` makes no difference to the old
code (the buffers are off-heap) and little to the new.

What is left above the 89 MiB floor is GC slack: freed 64 KiB buffers wait for a scavenge, which
V8 triggers by JS-heap allocation, not by external memory. Measured in-process: heapUsed flat at
11–12 MiB, `external` peaking 34–54 MiB. Hence the semi-space flag result. The goal "<150 MB for
a 400 MB graph" is met with `--max-semi-space-size=2`, not with default flags (~180–230 MiB); both
fit a 512 MiB limit with room, and neither grows with the graph.

Recommendation for the infra repo: `NODE_OPTIONS=--max-semi-space-size=2` on the backup CronJob
and the pre-deploy backup Job only (not the server: smaller semi-space means more scavenges).

## Compatibility (tested)

- Old archive -> new restore: committed fixture `packages/server/src/backup/fixtures/v1-c9d993b.tar.gz`,
  written by the c9d993b `createBackup` (two invented pages, two assets). Test
  "restores an archive written by the old in-memory backup". Also the 400 MB archive from the old
  bundle restored by the new one (161 MiB RSS).
- New archive -> old reader: test "a new archive restores with the old reader" (readTarGz + write
  every entry, then `dumpAll` equality); `tar.test.ts` "new archives read with the old in-memory
  reader"; and the old bundle's `nooklet restore` on the new 400 MB archive, then `verify` OK.
- `tar xzf` extracts a streamed archive (test).

## Verification

- `tools/probes/backup-sigkill.mjs`: SIGKILL after 271 KB of partial archive -> final path absent;
  left: the partial + snapshot; a clean re-run to the same path succeeds, `tar tzf` lists 104
  entries.
- `tools/probes/restore-per-graph.mjs` (two graphs, backup alpha, mutate, `restore --graph alpha
  --force`): PASS x3, `verify` OK on both graphs.
- `pnpm -r typecheck` clean. `node tools/leak-check.mjs --tree` clean. `biome check
  --diagnostic-level=error`: 2 errors, both in `apps/web/src/sync/http-transport-stall.test.ts`
  (from c9d993b, not this branch).
- `pnpm -r test`: all green (core 479, plugin-api 17, server 863, web 1640).

## Audit: other paths that hold a whole graph in memory (coordinator request)

Measured on the same synthetic graph (60,000 blocks, 61,500 ops, 169 MiB db), bundle or
in-process `process.memoryUsage()` deltas (throwaway script, not committed).

| Path | Before | Now | What |
|---|---|---|---|
| `GET /sync/snapshot` (server) | +332 MiB per request (51 MiB JSON) | +40 MiB | **Fixed.** Streamed from a second read-only connection in one read transaction (WAL snapshot), pull-driven `ReadableStream`, byte-identical body, gzip still applies. In-memory dbs (tests) keep the old path. |
| `GET /sync/snapshot` (client worker) | whole body parsed, then inserted in one transaction | unchanged | **Logged** (B-NEW-2). Not contained: needs a streaming parser and a transaction across awaits. |
| `nooklet verify` / `verifyRebuildParity` | 582 MiB RSS, 4.0 s | 194 MiB, 4.5 s | **Fixed.** Ops replayed in `seq`-ordered batches of 2,000; tables diffed in key-range batches compared by SQLite on both sides; CLI puts the scratch replica in a file beside the graph (`.verify-scratch-<pid>.sqlite`, journal in memory, no fsync, deleted afterwards). Dev-mode startup check keeps an in-memory scratch. |
| `nooklet gc` (`runGc`) | loaded and JSON-parsed the entire op log to report two counts | two `SUM()`s in SQL | **Fixed.** `planGc` kept (tests use the materialised plan). Asset-reference scan loads only rows containing `assets/`. VACUUM is SQLite's own. |
| `nooklet export` / mirror | per page | — | OK: 118 MiB RSS for the full export of 1,500 pages. Holds only the list of live page ids. |
| Logseq importer core | parses every page file before importing any (`resolveFileEntries` keeps all `ParsedPage`s); each asset `readFileSync`ed whole, no size cap on import | — | **Logged** (B-NEW-3), 226 MiB for a 12 MB / 1,500-page source. Not fixed: another agent owns import. |
| `GET /assets/:id` | — | — | OK: `createReadStream` -> web stream. |
| `asset.upload` | — | — | OK, bounded: base64 JSON body capped by the large-body limit, 25 MB decoded; one asset at a time. |
| `GET /sync/pull` | — | — | OK: `LIMIT` 500 default, 5,000 max. |
| `graph.replace` op | loads the content of every block in scope (whole graph when unscoped) and scans it in one go | — | **Logged** (B-NEW-4); not measured. |
| backup / restore | 1465 / 1382 MiB | 183–230 MiB | Fixed, above. |

Cost of the snapshot change: the read transaction stays open while the client downloads, so a WAL
checkpoint cannot pass it for that long (the WAL may grow during a slow first sync). It ends when
the body is done or the client disconnects (the client's stall bound is 20 s since c9d993b).

Tests: `snapshot.test.ts` "streamed from a file-backed database" (4: byte-identical across chunks,
one consistent instant with a write committed mid-read, gzip, disconnect releases the read
transaction — the last checked by mutation: without `gen.return()` it fails); `verify.test.ts`
"batched replay and diff find the same divergences wherever the batch boundaries fall" (batch
sizes 1/2/3/7, divergences at the first, last, middle and past-the-end keys, two-column keys;
mutation-checked: dropping the past-the-end pass fails it); `gc.test.ts` dry-run asserts the SQL
counts equal `planGc`'s lengths.

## Status

- [x] Streaming backup + restore, tests, probes, docs (OPERATIONS.md §3). Commit bc640c0e.
- [x] Audit; snapshot (server), verify and gc fixed. Commit 2: see `git log`.
- [x] e2e, 6 sync specs against a real `nooklet serve` (file db, so the streamed snapshot): 13 passed. `pnpm -r test` green again (server 868).

## BUGS.md updates to fold in

### B-NEW-2 · The client parses the whole `/sync/snapshot` body before inserting any of it
**Status:** open · **Severity:** medium · **Found:** 2026-10-04, streaming audit · **Test:** none

`apps/web/src/sync/http-transport.ts` `fetchJsonStallAware` reads the body to the end and
`JSON.parse`s it; `sync-client.ts#bootstrap` then inserts every row inside one synchronous
`driver.transaction` (B-660's `defer_foreign_keys` depends on that one transaction). A 17 MB
snapshot is ~17 MB of string plus several times that as JS objects in the worker, on a phone. The
server side now streams (B-NEW-5), so this is the remaining half. Recommendation: a second
representation of the same route, `GET /sync/snapshot?format=ndjson` (one `{"t":"block",...}` row
per line, a first line with the cursor, a last `{"end":true}` line so truncation is detectable),
generated by the same streaming generator, old JSON kept as the default so old clients still work.
The client reads it with a line splitter over `res.body` and inserts in batches of ~1,000 rows
inside one `driver.savepoint()` (which spans awaits) with `defer_foreign_keys` set, committing at
the end line and rolling back on a stall or truncation. The B-641 ref-index rebuild already runs
after the insert and is unaffected.

### B-NEW-3 · The Logseq importer parses every page before importing any, and reads assets whole
**Status:** open · **Severity:** low · **Found:** 2026-10-04, streaming audit · **Test:** none

`packages/server/src/importer/logseq.ts#resolveFileEntries` reads and parses every file under
`pages/` and `journals/` and keeps all the `ParsedPage`s, because name resolution and dedup happen
before import. 226 MiB peak RSS for a 12 MB, 1,500-page source (synthetic). Each asset is
`readFileSync`ed whole with `maxBytes: Infinity`, so one 2 GB video in `assets/` is a 2 GB buffer.
Recommendation: a first pass that only reads each file's `title::` property (or the file name) to
resolve and dedup names, a second pass that parses and imports one page at a time; for assets,
`storeAssetBytes` from a stream (hash while copying to a temp file, then rename), or a size cap
with a warning. Coordinate with the in-app import upload work.

### B-NEW-4 · `graph.replace` loads every in-scope block's content at once
**Status:** open · **Severity:** low · **Found:** 2026-10-04, streaming audit · **Test:** none

`packages/server/src/ops/graph-replace.ts` selects id/page/content of every block matching the
scope (the whole graph when unscoped) and hands all contents to `runScan` in one call. O(graph
text) per request, reachable over HTTP and MCP. Not measured. Recommendation: scan in keyset
batches (`WHERE b.id > ? ORDER BY b.id LIMIT 2000`) and accumulate only the matches, which the op
already caps for its preview.

### B-NEW-5 · `/sync/snapshot`, `nooklet verify` and `nooklet gc` held the whole graph in memory
**Status:** fixed (this branch) · **Severity:** medium · **Found:** 2026-10-04, streaming audit ·
**Test:** `snapshot.test.ts` "GET /sync/snapshot, streamed from a file-backed database" (4);
`verify.test.ts` "batched replay and diff find the same divergences wherever the batch boundaries
fall"; `gc.test.ts` "dry-run reports counts and mutates nothing" (counts vs `planGc`)

Snapshot: +332 MiB server RSS per request for a 60,000-block graph, now +40 MiB, same bytes, still
one consistent read. Verify: 582 MiB -> 194 MiB. gc: no longer loads the op log to count it.

### B-NEW-1 · `nooklet backup` OOMKilled on a 280 MB graph; restore had the same shape
**Status:** fixed (this branch) · **Severity:** high · **Found:** 2026-10-04, production · **Test:**
`backup.test.ts` "streaming backup/restore: compatibility and failure modes" (6), `tar.test.ts`
"writeTarGzFile / readTarGzFile (streaming)" (7); probes `tools/probes/backup-memory.mjs`,
`tools/probes/backup-sigkill.mjs`

Backup buffered the snapshot and every asset, concatenated and gzipped in memory; restore
buffered the archive and every entry. Peak RSS 1465 / 1382 MiB on a 400 MB graph. Now streamed
both ways: 183–230 MiB with default flags, 120–137 MiB with `--max-semi-space-size=2`, flat in
graph size. Also: archive written to a temp name and renamed (killed backup leaves no truncated
archive); restore stages and validates before swapping (truncated/corrupt archive leaves the graph
untouched; the old reader silently accepted a tar stream that stopped early).
