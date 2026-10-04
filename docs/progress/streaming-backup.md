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

## Status

- [x] Streaming backup + restore, tests, probes, docs (OPERATIONS.md §3).
- [ ] Commit 1 (backup/restore).
- [ ] Audit of other whole-graph-in-memory paths (coordinator request) — next.

## BUGS.md updates to fold in

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
