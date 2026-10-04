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

### Merge of main (WebSocket hardening B-676 H4/H12) and the client's 4410 state: `f588344`

Coordinator asked (2026-10-04) to merge `main` and resolve against the WS hardening:
- One socket registry: `live-limits.ts#admitted` (the hardening's) now records each socket's graph
  driver (`admitSocket(ws, driver)`), and `closeGraphSockets(driver, reason)` lives there: it
  releases each socket from the total at once and closes it with `LIVE_CLOSE.graphRetired` (4410,
  added to core's `LIVE_CLOSE`). My separate `graphSockets` set in `token-sockets.ts` is gone; the
  per-token map stays the hardening's (`tokenSocketCount`). Pre-hello and capped sockets are in
  `admitted`, so retire closes them too (a socket refused at admit is already closing).
- Client: 4410 is terminal (`LIVE_TERMINAL_CODES` in `sync/types.ts`, used by `live-backoff.ts`
  for both `/sync/live` and `/ui/live`). `SyncClient` has a sticky `graphRetired` -> state
  `retired`, checked before `unauthorized`; a sync request's 404 with the server's own
  `No graph "<id>"` body (`isGraphGoneResponse`) throws `SyncGraphRetiredError` -> `retired` too
  (what a reloaded page sees, having no socket to close). Cleared only by a push the server
  accepted or a successful pull. Indicator: danger dot, label "This graph was retired on the server
  — changes made here stay on this device", a "Graph retired" pill that opens diagnostics.
- Tests: `live-backoff.test.ts`, `sync-client.test.ts` (2), `http-transport-retired.test.ts` (3),
  `sync-indicator-state.test.ts`, `retire.test.ts` (other graph's socket stays open, total count
  drops), e2e `e2e/tests/graph-retired.spec.ts` (fails with 4410 not terminal: 3 sockets vs 1).

A second `git merge main` (`47863f2`, clean) picked up B-714's new mismatch screen ("The server has
a different graph now", with "Keep as a device-only graph"); the docs, FAQ and `graph replace`'s
message now quote it.

## Verification run (2026-10-04, after the second merge of main)

- `pnpm -r test`: core 491, plugin-api 17, server 906, web 1669, all passed.
- `pnpm -r typecheck`: clean.
- `pnpm exec biome check . --diagnostic-level=error`: clean (main fixed the stall-test lint).
- `pnpm e2e` `graph-retired`, `live-limits`, `qr-pairing`, `graph-mismatch-discard`: 7 passed
  (port 6560).
- `node tools/leak-check.mjs --tree`: clean.
- Not run: the full e2e suite, `nooklet verify` against a real graph.

## Decisions

- Live-server detection is a pid file, not a SQLite lock: in WAL mode a second connection opens
  and writes a database the server holds without error, so there is nothing to probe.
- `unretire` is allowed while serving (it only adds a folder under an unused id; the server opens
  it lazily, and the stale-handle check covers an id it had cached). There is no API unretire.
- Close code 4410 for retired-graph sockets; terminal on the client (see the merge section).
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
`graph.sqlite` was moved or replaced underneath it (dev/inode check per request). Sockets close
through the WS hardening's one registry (`live-limits.ts`), pre-hello and capped ones included.
The client treats 4410 (or a sync request's "No graph" 404) as terminal: no reconnect, indicator
"This graph was retired on the server" + "Graph retired" pill (`e2e/tests/graph-retired.spec.ts`).
Docs: self-hosting.md "Retiring, restoring and replacing a graph", faq.md.
```

No new bugs to log from this task.

## How to resume

Nothing in flight. Coordinator: fold the B-713 text above into BUGS.md.
