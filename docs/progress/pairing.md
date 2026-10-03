# Progress — pairing link, serve hardening (D3, B-602, B-604, B-603, B-607, B-616)

Branch `worktree-agent-a1a8803e8c967f3b2` (reset to main @ edacbc4, then `git merge main` twice at
the coordinator's request: `e22c2c9`, `b07ecdd`). Ports used: 6316–6319. Not merged to main.

## Status — all done

| item | commit | test |
|---|---|---|
| D3 / B-600 remainder: `serve --no-loopback-token`, on in Dockerfile + Helm chart | `b233294` | `http/host-guard.test.ts` "--no-loopback-token (B-600, decision D3)" |
| B-602: failed WS upgrades answered at once | `b233294` | `graphs/mount.test.ts` (2 new) |
| B-607: command before first `serve` (coordinator add-on) | `228f942` | `graphs/registry.test.ts` (5), `cli-first-run.test.ts` (2) |
| B-604: LAN addresses on `--host 0.0.0.0` | `f19a64b` | `serve-banner.test.ts` (7) |
| B-603: `nooklet://connect` pairing link + `token create --link` | `0399e4e`, `fb31593` | `connect-graph.test.ts` parsePairingLink (5), `PairingLinkPrompt.test.tsx` (5), `platform/launch-url.test.ts` (4), `auth/pairing-link.test.ts` (3), `cli-first-run.test.ts` --link (1); Simulator probe `tools/probes/pairing-link-ui/` |
| B-616: MCP Host guard only on `/mcp`, follows `--allow-host` (coordinator add-on) | `f177b35` | `http/web-client.test.ts` "serves the app shell behind a same-host proxy that rewrites Host (B-616)" |
| Runbook (owner's Option L decision) + OPERATIONS §1.1/§2/§8 + README | last commit | — |

## Decisions

- **`--no-loopback-token` is on by default in the container image (Dockerfile CMD) and the draft
  Helm chart**, not in the CLI. No browser runs inside a container, so the auto-token has no
  legitimate user there, while a sidecar proxy, `kubectl port-forward` or `docker exec … curl`
  arrive over the pod's loopback. The local desktop / `pnpm nooklet serve` case relies on it, so
  the CLI default stays on. The client explains the new `reason: "loopback_token_disabled"`.
- **B-602's root cause was B-589's fix.** `@hono/node-server` 2.1.1's `setupWebSocket` rejects a
  failed upgrade only `if (server.listenerCount("upgrade") === 1)`. B-589 added a second
  `'upgrade'` listener, so EVERY failed upgrade hung: bare `/sync/live` and `/g/<unknown>/sync/live`
  (measured on a real `serve`: both "NEVER" after 4 s; after the fix 22 ms / 2 ms). The B-589 guard
  now attaches at `'connection'` (`http/upgrade-guard.ts`); bare-path upgrades also get a 404 with a
  message instead of a useless 307. Both regressions are pinned by tests (checked by swapping the
  guard back: "expected 'hung' to be 404"; with no guard, vitest reports the unhandled ECONNRESET).
- **B-607**: CLI commands open graphs via `openGraphForCommand` (registry.ts), which writes
  `graph.json`. Only `default` may be created by a CLI command; a `--graph` typo now fails rather
  than leaving an orphan db. `GraphRegistry.list()` adopts a db with no `graph.json` (existing
  broken data dirs recover; verified the CLI test passes with the old CLI + new registry). Not
  routed through a full `GraphRegistry` handle: that builds the per-graph app and plugins.
- **B-604**: VM/container bridge interfaces (`bridge*`, `docker*`, `vmnet*`, …) are skipped; on the
  dev Mac they outnumbered en0 2:1. Tailscale's `utun` is kept.
- **B-603**: the link is parsed strictly (`parsePairingLink`): `nooklet:` + `connect`, http(s) only,
  no `user:pass@` (would disguise the host), token `[A-Za-z0-9_-]{8,256}`, both params required;
  other `nooklet://` links are ignored, not claimed. `PairingLinkPrompt` is mounted outside the
  token gate, so it works on a fresh install, a local-only device and one synced elsewhere.
  Connecting goes through `connectToGraph`, which adds a remote entry and keeps local graphs. The
  server builds the link with an explicit `/g/<graph>` path. **No QR**: no QR library is in the
  dependency tree; adding one is an owner decision.
- **Found on the Simulator, fixed (`fb31593`)**: Capacitor's `App.getLaunchUrl()` is really
  `ApplicationDelegateProxy.lastURL` (`@capacitor/ios` 8.5.1 `CAPBridge.swift`), set by every open
  and surviving `location.reload()`, so after Connect the confirm screen reappeared. Delivered URLs
  are now recorded (FNV hash only, never the token) in `sessionStorage`; `getLaunchUrl()` skips
  them, and a live `appUrlOpen` always fires.
- **B-616**: the MCP sub-app is mounted at `/mcp` instead of `/`, always given loopback +
  `--allow-host`, and fronted by nooklet's own Host check, whose 403 names the `--allow-host` to add.
  The server logs the same hint on stderr once per refused name, for any bind. The old
  `web-client.test.ts` case "refuses a LAN Host by default" encoded B-616 itself (loopback bind);
  it now binds `0.0.0.0`, where nooklet's own guard refuses. On a loopback bind the app shell is
  served for any Host: it holds no secret, and `/api/session` still requires a loopback Host.

## Verification (2026-10-03, after the second merge of main)

- `pnpm -r test`: core 426, plugin-api 17, server 98 files / 812, web 170 files / 1442 — all pass.
- `pnpm -r typecheck`: clean.
- `pnpm exec biome check . --diagnostic-level=error`: **fails, only on files from main**
  (format-only: `tools/probes/sweep-core/search-trash.mjs`, `tools/probes/sweep-devices/*.ts|mjs`,
  7 files); none of this branch's files. Left alone (other agents' files).
- e2e (port 6316) `connectivity graph-switcher remote-device`: 8 passed, 1 failed =
  `connectivity.spec.ts:36` "search returns rather than spinning forever", 3/3 on re-run. That is
  the known pre-existing B-543/B-593 signature (draft not yet visible at the `isVisible()` check);
  this branch touches no journal code.
- Real `serve` checks: B-602 (`ws-fail.mjs`), B-604 banner, B-607 (`graph.json` present after
  `token create` on a fresh dir, then `serve` OK), B-616 with the sweep's `host-proxy.mjs`
  (shell 200, `/api/session` 200 without token, `/mcp` 403 with the hint, `/mcp` on loopback with a
  token lists tools).
- **Simulator (iOS 26.5, real app build)**: `tools/probes/pairing-link-ui/` (XCUITest, headless);
  `pairing-confirm.png` shows the pre-filled confirm screen with the address, and
  `pairing-after-connect.png` shows Today with both sync dots green. Server token "last used"
  confirmed the connect.
- **Incident**: an early attempt used `open -g -a Simulator` (to tap SpringBoard's "Open in
  nooklet?" alert via accessibility). That put a Simulator window on the owner's screen, and the
  owner closed it; I reopened it once more before the coordinator's message. Never again: the probe
  is headless. While that window was up, a page "something" was written to my scratch server from
  the shared iPhone 17 Pro device (17:13:20). It was not from this code; someone tapped through on
  the visible device. Another agent's `simctl shutdown all` later killed my test mid-run, so the
  probe uses a private simulator device (created and deleted).

## Still unverified

- Physical iPhone: tapping a `nooklet://` link in Notes/Messages (does iOS linkify the custom
  scheme?), pasting into Safari's address bar. The Simulator path used `XCUIDevice.system.open`.
- `kubectl port-forward` actually arriving as a loopback peer in the pod (the reason given for
  setting `--no-loopback-token` in the chart) is from how CRI port-forward works, not tested here.

## BUGS.md updates to fold in

- **B-600** → D3 done: `nooklet serve --no-loopback-token` (`b233294`), set in the Dockerfile and
  the Helm chart. Test: `http/host-guard.test.ts` "--no-loopback-token (B-600, decision D3)".
  Status → fixed.
- **B-602** → fixed (`b233294`). Root cause: B-589's second `'upgrade'` listener; affected every
  failed upgrade, not only bare paths. Tests: `graphs/mount.test.ts` "answers a failed upgrade with
  404 at once instead of leaving it hanging (B-602)" and "survives a client resetting the TCP
  connection mid-upgrade (B-589, kept by the new guard)". B-589's entry should point to
  `http/upgrade-guard.ts` now.
- **B-603** → fixed (`0399e4e`, `fb31593`). Tests listed in the Status table; Simulator probe
  `tools/probes/pairing-link-ui/`. QR left out (no library; owner decision).
- **B-604** → fixed (`f19a64b`). Test: `serve-banner.test.ts`.
- **B-607** → fixed (`228f942`). Tests: `graphs/registry.test.ts`, `cli-first-run.test.ts` (both
  orders failed before the fix with `serve exited 1`). README and OPERATIONS §2 updated.
- **B-616** → fixed (`f177b35`). Test: `http/web-client.test.ts` "serves the app shell behind a
  same-host proxy that rewrites Host (B-616)" (403 vs 200 on the old code).
- **(new, fixed, found here)** After a deep link's `location.reload()`, `App.getLaunchUrl()`
  re-delivered the same URL (it is Capacitor's `lastURL`), so the pairing confirm screen came back
  after every Connect. Fixed `fb31593` (`platform/launch-url.ts`). Test:
  `platform/launch-url.test.ts`; found by `tools/probes/pairing-link-ui/`.
- **(new, open, low)** `packages/server/src/mcp/stdio-main.ts` defaults to
  `~/.nooklet/default/graph.sqlite`, the pre-ADR-025 flat layout. Run without `--data` it would
  create a stray legacy database beside `graphs/`. Dev-only (`nooklet mcp --stdio` goes through
  `cli.ts`). Not fixed.
- **(new, open, low, test hygiene)** `biome check --diagnostic-level=error` fails on main because of
  formatting in 7 probe files under `tools/probes/sweep-core/` and `tools/probes/sweep-devices/`.
