# Progress: retiring, restoring and replacing a server graph (B-713)

Branch: `worktree-agent-ab7505fe4c4eb2f03`, based on `010fa65`, with
`worktree-agent-a43102892280a2b63` (cli-fixes, flag allowlists) merged first.

## Done

All in `663c7ba` (`feat(server): retire, restore and
replace a graph (B-713)`).

- `packages/server/src/graphs/retire.ts`: `retireGraph` (renames `graphs/<id>` to
  `graphs-retired/<id>-<YYYYMMDDTHHMMSSZ>[-n]`, refuses `default` without force), `listRetired`,
  `unretireGraph` (never overwrites, `--as`, rewrites `graph.json` id), `replaceGraph` (copies the
  source into `graphs-incoming/`, `carryTokens` with `INSERT OR IGNORE` over the shared columns,
  keeps the old label, retires old, renames new into place, puts the old back if that rename fails).
- `graphs/server-lock.ts`: `serve` writes `<data>/serve.pid` once listening and removes it on exit.
  `liveServer()`: stale pid ignored; `EPERM` or another hostname counts as live.
- `GraphRegistry`: `retire()` (marks retiring so `resolve()` 404s, evicts, then moves), `#evict()`
  (`onClose` hook, plugin `deactivateAll`, `closeGraphSockets(4410)`, `closeDb`), and a stale-handle
  check in `resolve()` (dev:ino of `graph.sqlite` vs. what the handle opened; mismatch or gone means
  evict and reopen whatever is there).
- `db.ts#closeDb` (WeakMap driver -> raw connection; `SqlDriver` unchanged, core untouched).
- `auth/token-sockets.ts`: `trackGraphSocket`/`closeGraphSockets`, `GRAPH_RETIRED_CLOSE_CODE = 4410`;
  `/sync/live` and `/ui/live` track every socket at `onOpen` (pre-hello ones too).
- `DELETE /graphs/:id` (root token; `?force=true` for default; 404/409/400 from `GraphRetireError`).
- `serve`: per-graph mirror map; `onClose` flushes + stops the mirror and stops the indexer.
- CLI: `graph retire <id> [--force]`, `graph unretire <name> [--as <id>]`, `graph list --retired`,
  `graph replace <id> --from <dir>`; per-subcommand strict flags (`GRAPH_SUBCOMMAND_FLAGS`), the
  union `GRAPH_FLAGS` in `cli-flag-audit.test.ts`. Retire and replace refuse while serve.pid is live.
- Docs: `docs/guide/self-hosting.md` "Retiring, restoring and replacing a graph" (+ data dir tree),
  `docs/guide/faq.md` (two entries), `docs/spec/security-inventory.md`, `docs/guide/security.md`,
  `docs/guide/agents.md`, `docs/OPERATIONS.md`.
- Tests: `graphs/retire.test.ts` (10), `cli-graph-retire.test.ts` (4, real `tsx cli.ts`, one with a
  real `serve` on port 6561), route-inventory asserts `DELETE /graphs/:id` exists and is 401.
  Mutation-checked: with the stale-handle check or the socket close removed, the matching tests fail.
- Probe: `tools/probes/graph-retire-live-mirror.mjs` (real serve, mirror on, port 6562): the page
  written inside the mirror debounce is in the retired folder's `pages/`, healthz 404 after, no
  server errors, `serve.pid` gone after SIGTERM. Ran 2026-10-04: all as expected.

## Verification run (2026-10-04)

- `pnpm -r test`: core 479, plugin-api 17, server 865, web 1640, all passed.
- `pnpm -r typecheck`: clean.
- `pnpm exec biome check . --diagnostic-level=error`: 2 errors, both in
  `apps/web/src/sync/http-transport-stall.test.ts` (from `c9d993bb`, B-707), not in this change.
- `node tools/leak-check.mjs --tree`: clean.
- Not run: `pnpm e2e` (no UI change), `nooklet verify` against a real graph.

## Decisions

- Live-server detection is a pid file, not a SQLite lock: in WAL mode a second connection opens
  and writes a database the server holds without error, so there is nothing to probe.
- `unretire` is allowed while serving (it only adds a folder under an unused id; the server opens
  it lazily, and the stale-handle check covers an id it had cached). There is no API unretire.
- Close code 4410 for retired-graph sockets. The web client treats unknown codes as offline and
  reconnects; the reconnect then gets 404 (see follow-up below).
- `replace` copies (not moves) the source, so a scratch dir on another filesystem works and
  survives; device rows are not carried (they describe replicas of the old instance).
- Couldn't run `git config core.hooksPath tools/git-hooks` here (the worktree sandbox refuses any
  command naming git twice). Ran `node tools/leak-check.mjs --staged` by hand before committing.

## BUGS.md updates to fold in

**B-713** -> Fixed:

```
### B-713 · There is no supported way to retire/delete a graph on the server
**Status:** fixed (2026-10-04, graph-retire agent, `663c7ba`) · **Severity:** medium · **Found:** 2026-10-04, owner asked; coordinator had to swap production `alpha` by hand · **Test:** `packages/server/src/graphs/retire.test.ts` (API: root-token only, sockets closed 4410, handle closed, 404 after, unretire data intact + verify; stale handle after a by-hand swap; replace keeps tokens), `packages/server/src/cli-graph-retire.test.ts` (CLI retire/unretire/list --retired/replace, default needs --force, refusal while a real serve runs), `http/route-inventory.test.ts`

`nooklet graph retire <id> [--force]` moves `graphs/<id>` to `graphs-retired/<id>-<UTC timestamp>/`
(nothing deleted; `default` needs --force); `graph unretire <name> [--as <id>]`; `graph list
--retired`; `graph replace <id> --from <scratch>` (carries token rows, retires the old, swaps the
new in). Retire/replace refuse while `<data>/serve.pid` names a live server. Root-token
`DELETE /graphs/<id>` retires from a running server: closes the graph's sockets (4410), plugins,
mirror, indexer and SQLite handle first. The registry also drops a cached handle whose
`graph.sqlite` was moved or replaced underneath it (dev/inode check per request). Docs:
self-hosting.md "Retiring, restoring and replacing a graph", faq.md.
```

**New, open (found in passing):**

```
### B-7xx · The web client shows a retired graph as plain "Offline"
**Status:** open · **Severity:** low · **Found:** 2026-10-04, graph-retire agent (B-713) · **Test:** none

`DELETE /graphs/<id>` closes the graph's live sockets with 4410 and the graph then 404s, but the
client only knows 4401/4403 (`LIVE_AUTH_REJECTED_CODES`), so it shows "Offline" and retries forever.
It could say "This graph was removed from the server" and stop retrying.
```

```
### B-7xx · biome check fails on main: unsafe optional chaining in http-transport-stall.test.ts
**Status:** open · **Severity:** low (lint gate red) · **Found:** 2026-10-04, graph-retire agent · **Test:** `pnpm exec biome check . --diagnostic-level=error`

`apps/web/src/sync/http-transport-stall.test.ts:49-50` (`(init?.signal as AbortSignal).…`, from
`c9d993bb`, B-707) trips `lint/correctness/noUnsafeOptionalChaining`, 2 errors.
```

## How to resume

Nothing in flight. Coordinator: fold the BUGS.md text above in (B-7xx numbers to assign).
