# Progress — pairing link, serve hardening (D3, B-602, B-604, B-603, B-607)

Branch `worktree-agent-a1a8803e8c967f3b2` (reset to main @ edacbc4, later `git merge main` at the
coordinator's request). Ports used: 6316 only.

## Status

- [x] D3 / B-600 remainder — `nooklet serve --no-loopback-token`. `b233294`.
- [x] B-602 — failed WS upgrades answered at once. `b233294`.
- [x] B-607 (coordinator add-on) — command before first `serve`. `228f942`.
- [ ] B-604 — print LAN addresses on `--host 0.0.0.0`.
- [ ] B-603 — `nooklet://connect` pairing link + `token create --link`.
- [ ] Runbook (`real-device-test.md`) + OPERATIONS updates; full verification.

## Decisions

- **`--no-loopback-token` is on by default in the container image (Dockerfile CMD) and in the
  draft Helm chart.** No browser runs inside a container, so the auto-token has no legitimate
  user there, while a sidecar proxy, `kubectl port-forward` or `docker exec … curl` all arrive
  over the pod's loopback. Cost: none known; devices already need a minted token over the network.
  Not the CLI default: the local desktop/`pnpm nooklet serve` case relies on it.
- **B-602 root cause was B-589's fix**, not routing: `@hono/node-server`'s `setupWebSocket` only
  rejects a failed upgrade `if (server.listenerCount("upgrade") === 1)`. B-589 added a second
  `'upgrade'` listener, so EVERY failed upgrade hung — bare `/sync/live` and also
  `/g/<unknown>/sync/live` (measured: both "NEVER" after 4 s on a real `serve`). The B-589 guard
  now attaches at `'connection'` (`packages/server/src/http/upgrade-guard.ts`); bare-path upgrades
  additionally get a 404 with a message instead of a useless 307.
- **B-607**: CLI commands go through `openGraphForCommand` (registry.ts), which writes
  `graph.json`; only `default` may be created by a CLI command (a `--graph` typo now fails rather
  than making an orphan db). `GraphRegistry.list()` adopts a db with no `graph.json`, so existing
  broken data dirs recover. Did not route CLI commands through a full `GraphRegistry` handle: that
  builds the per-graph app and loads plugins, which one-shot commands don't need.

## BUGS.md updates to fold in

- **B-600** → D3 done: `nooklet serve --no-loopback-token` (`b233294`), set in the Dockerfile and
  the Helm chart. Test: `http/host-guard.test.ts` "--no-loopback-token (B-600, decision D3)".
  Status can become fixed.
- **B-602** → fixed (`b233294`). Root cause: B-589's second `'upgrade'` listener (see Decisions);
  affected every failed upgrade, not only bare paths. Test: `graphs/mount.test.ts` "answers a
  failed upgrade with 404 at once instead of leaving it hanging (B-602)" (fails with the old
  listener: `expected 'hung' to be 404`) and "survives a client resetting the TCP connection
  mid-upgrade" (B-589 kept: without any guard vitest reports the unhandled ECONNRESET). B-589's
  entry should point to `http/upgrade-guard.ts` now.
- **B-607** → fixed (`228f942`). Tests: `graphs/registry.test.ts` (5), `cli-first-run.test.ts`
  (2: token create → serve, import → serve; both failed before the fix with `serve exited 1`).
  README and OPERATIONS §2 data layout updated.
- **(new, open, low)** `packages/server/src/mcp/stdio-main.ts` defaults to
  `~/.nooklet/default/graph.sqlite`, the pre-ADR-025 flat layout. Run without `--data`, it would
  create a stray legacy database beside `graphs/`. Not the path `nooklet mcp --stdio` uses (that
  goes through `cli.ts`), so dev-only. Not fixed (out of scope).
