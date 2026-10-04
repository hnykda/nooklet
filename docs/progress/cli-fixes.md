# cli-fixes — B-671 (restore --graph), B-685 (EADDRINUSE), B-696 (version) (2026-10-04)

Branch: the agent's own worktree branch, based on `6d56c8f`. Not merged, not pushed.

## Status

**Done**: `0ab83d2` on top of `6d56c8f`. Nothing
in flight. Coordinator: fold the section at the bottom into BUGS.md.

## What changed

- **B-671.** `packages/server/src/cli-args.ts`: new `GRAPH_COMMAND_FLAGS = ["data", "graph"]`;
  `RESTORE_FLAGS`, `GC_FLAGS`, `REPAIR_FLAGS` and the new `PAIR_FLAGS` (moved out of `cli.ts`)
  all start from it. Usage text in `cli.ts` names `--graph` for backup/restore/gc/verify/repair.
- **Flag-allowlist audit.** Only four commands validate flags (`restore`, `gc`, `repair`, `pair`);
  every other command ignores unknown flags (no allowlist, so no allowlist drift possible — a typo
  there is silently ignored, which is the older, separate behaviour, not changed here). Of the four,
  **three had the B-671 hole**: `restore` (reads `graphIdFlag`), `gc` and `repair` (read `--graph`
  through `open(args)`) all rejected `--graph`. `pair` was correct. No allowlist had a dead entry.
  `src/cli-flag-audit.test.ts` scans `cli.ts`/`cli-args.ts` source and cross-checks each strict
  command's allowlist against what its case reads, both directions, and fails if a new case starts
  validating flags without being added. Verified it fails on the old allowlists (restore + gc
  reported missing `graph`).
- **Found on the way (new bug, fixed because it is on the exact path B-671 asks to work):**
  `restore --force` over a graph whose previous server was killed (stale `graph.sqlite-wal`) left
  the WAL in place; the next open replayed the OLD database's frames onto the restored file.
  `tools/probes/restore-stale-wal.mjs` before the fix: `verify exit 1: nooklet: database disk
  image is malformed`. `backup/index.ts#restoreBackup` now removes `-wal`/`-shm` before writing the
  archive's `graph.sqlite`. After: `verify exit 0 … OK`, blocks=2 as backed up.
- **B-685.** `cli.ts` serve: `server.on("error")` → `nooklet: port N on <host> is in use — stop the
  other server, or pick another with --port <n>`, exit 1 (EACCES gets its own line; anything else
  `could not listen on host:port: <message>`).
- **B-696.** `src/version.ts` exports `NOOKLET_VERSION` from `packages/server/package.json` via a JSON
  import (esbuild inlines it, so the desktop/Docker bundle works with no package.json beside it —
  checked: a bundle built with build-sidecar.mjs's options prints `nooklet 0.0.1` from a scratch dir).
  Used as the MCP `serverInfo.version` default (`mcp/server.ts`; the HTTP and stdio paths both fall
  through to it), `nooklet --version` / `-V` / `version` (answered before any data dir is opened),
  and the serve banner's first line (`nooklet <v> serving <dir>`). **Not on `/healthz`**: the
  security inventory's unauthenticated surface is deliberately minimal; an exact build version on a
  public probe is fingerprinting. Recorded in `docs/spec/security-inventory.md` ("What an
  unauthenticated visitor can learn"), and the CLI test asserts `/healthz` does not carry it.
- **Docs:** `docs/guide/self-hosting.md` (per-graph backup examples, restore touches only
  `graphs/<id>/`, stale WAL, `--version` before upgrades), `docs/OPERATIONS.md` (§1 banner + port in
  use, §3 `--graph` and per-graph restore/verify, strict-flag list), `deploy/README.md` (per-graph
  restore runbook replacing the "restore rejects --graph" caveat), `RELEASING.md` (where the server
  version comes from; per-graph restore on rollback).

## Tests (each named in the BUGS entries below)

- `packages/server/src/cli-ops.test.ts` (real CLI via tsx, like `cli-first-run.test.ts`):
  - "backup --graph alpha, change alpha, restore --graph alpha --force: alpha is back, default
    untouched, both verify" and "restore without --force still refuses to clobber the graph it
    targets" — both fail on `6d56c8f` (`nooklet: unknown flag --graph`).
  - "prints one line naming the port and --port, and exits 1 — no stack trace" — fails on `6d56c8f`.
  - "serve's banner and MCP initialize's serverInfo both carry the package version" and
    "--version / -V prints the package version and opens no data dir". The package is still at
    0.0.1, the same as the old hard-coded default, so these were checked to be discriminating by
    temporarily setting `packages/server/package.json` to `9.9.9-probe`: all three passed (MCP
    reported `9.9.9-probe`), then reverted.
- `src/cli-flag-audit.test.ts` (above).
- `src/backup/backup.test.ts` "--force over a database whose writer died with an un-checkpointed
  WAL…" — without the fix the restored graph reads back empty (old WAL replayed).
- `src/serve-banner.test.ts` "names the version on its first line".

## Round-trip probe (B-671), `node tools/probes/restore-per-graph.mjs`, 2026-10-04

Scratch mkdtemp data dir, two graphs, invented pages, no server. Output (temp paths elided):

```
$ nooklet graph create alpha --label Alpha
$ nooklet import <src>                 (default: Garden Plan, Reading List)
$ nooklet import <src> --graph alpha   (alpha: Alpha Kept One, Alpha Kept Two)
default: {"pages":["Garden Plan","Reading List"],"blocks":4,"ops":6}
alpha:   {"pages":["Alpha Kept One","Alpha Kept Two"],"blocks":4,"ops":6}
$ nooklet backup --graph alpha --out <data>/alpha-nightly.tar.gz
backed up <data>/graphs/alpha -> …/alpha-nightly.tar.gz
  schema version 8, 2 file(s), 11113 bytes
$ nooklet import <src> --graph alpha   (adds Alpha Added Later)
alpha after mutation: {"pages":["Alpha Added Later","Alpha Kept One","Alpha Kept Two"],"blocks":6,"ops":9}
$ nooklet restore …/alpha-nightly.tar.gz --graph alpha --force
restored 1 file(s) into <data>/graphs/alpha (archive schema version 8)
alpha after restore:   {"pages":["Alpha Kept One","Alpha Kept Two"],"blocks":4,"ops":6}
default after restore: {"pages":["Garden Plan","Reading List"],"blocks":4,"ops":6}
$ nooklet verify --graph alpha
verify: OK - rebuild() from the op log matches live state exactly.
$ nooklet verify
verify: OK - rebuild() from the op log matches live state exactly.
PASS  alpha changed by the mutation
PASS  alpha restored to the backed-up state
PASS  default untouched
```

("2 file(s)" in the archive = manifest.json + graph.sqlite; restore counts graph.sqlite only.)

## Verification (on the commit)

- `pnpm -r test`: core 479, plugin-api 17, server 849 (104 files), web 1637 — all passed.
- `pnpm -r typecheck`: clean. `pnpm exec biome check . --diagnostic-level=error`: clean (one
  pre-existing warning in `data-api.ts`, not touched). `node tools/leak-check.mjs --tree`: clean.
- `pnpm e2e` not run: no UI change.

## Still unverified

- Restoring while `serve` is still running remains unsupported (docs say stop it first); not
  re-tested. The WAL deletion does not make that safe.
- The Helm CronJob names archives `.tar` though they are gzip; `restore` reads them regardless
  (checked by reading `readTarGz`, not by running the chart).

## BUGS.md updates to fold in

### B-671 → fixed
**Status:** fixed (2026-10-04, cli-fixes) · **Test:** `cli-ops.test.ts` "backup --graph alpha,
change alpha, restore --graph alpha --force: alpha is back, default untouched, both verify";
`cli-flag-audit.test.ts` (allowlist vs reads, all strict commands).
Audit: `gc --graph` and `repair org-dates --graph` were refused the same way (they read `--graph`
through `open()`); fixed with the shared `GRAPH_COMMAND_FLAGS`. `pair` was already right. Round
trip with two graphs: `tools/probes/restore-per-graph.mjs` (output in docs/progress/cli-fixes.md).

### B-685 → fixed
**Status:** fixed (2026-10-04, cli-fixes) · **Test:** `cli-ops.test.ts` "prints one line naming the
port and --port, and exits 1 — no stack trace".

### B-696 → fixed
**Status:** fixed (2026-10-04, cli-fixes) · **Test:** `cli-ops.test.ts` "serve's banner and MCP
initialize's serverInfo both carry the package version", "--version prints the package version…";
`serve-banner.test.ts` "names the version on its first line". `src/version.ts` reads
`packages/server/package.json` (bumped by `tools/release.mjs`). Deliberately not exposed on the
unauthenticated `/healthz` (fingerprinting); recorded in `docs/spec/security-inventory.md`.

### NEW · `restore --force` over a graph with a stale `-wal` produces a corrupt database
**Status:** fixed (2026-10-04, cli-fixes) · **Severity:** high (data: the restore you reach for after
a crash is the one that hits it) · **Test:** `backup/backup.test.ts` "--force over a database whose
writer died with an un-checkpointed WAL: the stale WAL is not replayed onto the restored file" ·
**Probe:** `tools/probes/restore-stale-wal.mjs`.
`restoreBackup` wrote the archive's `graph.sqlite` but left the old `graph.sqlite-wal`/`-shm`. A
server killed hard leaves its WAL un-checkpointed; SQLite does not tie a WAL to its database file,
so the next open replayed the old frames onto the restored one. Probe before the fix: `verify exit
1: nooklet: database disk image is malformed`; the unit test's restored graph read back empty. Now
both files are removed before the database is written.
