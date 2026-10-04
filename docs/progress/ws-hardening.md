# WebSocket hardening (B-676 H4 + H12)

Branch: `worktree-agent-a6303bedc623dd43a`, based on `6d56c8f`.

Scope: `/g/<id>/sync/live` and `/g/<id>/ui/live` authenticate in their first message. Add a hello
timeout, per-token and total connection caps, a `maxPayload`, and make the web client back off on
the new close codes. Docs: `docs/spec/security-inventory.md`, `docs/guide/security.md`.

## State

- [x] measure the largest legitimate inbound frame: `tools/probes/security/ws-frame-sizes.mjs`
- [x] shared close codes + limits: `packages/core/src/live-socket.ts`
- [x] server: `packages/server/src/live-limits.ts`, wired into `sync/live.ts`, `live/live.ts`,
      `cli.ts` (`createLiveWebSocketServer`, `--ws-max-per-token`, `--ws-max-total`)
- [x] client: `apps/web/src/sync/live-backoff.ts` (both sockets), `SyncStatus.liveNote` + indicator
      label, `state.result` trimming (`live/message-handler.ts#stateResultFrame`)
- [x] unit/integration tests; `pnpm -r test` green (core 479, server 845, web 1649)
- [x] probes against a real `nooklet serve --port 6525 --ws-max-per-token 3`:
      `ws-revocation.mjs` (A closed 4401 at revoke; silent socket now closed 4408) and the new
      `ws-limits.mjs` (4408 after 10.0 s; 4th socket 4429; 600 KiB frame 1009; 20 KiB pre-hello
      1009; 400 KiB after hello stays open). `--ws-max-total 0` exits with a one-line error.
- [x] e2e: connectivity, remote-device, qr-pairing, sync-connection-states, sync-indicator,
      sync-timeout, sync-conflict, journal-draft-sync: 20 passed. New `e2e/tests/live-limits.spec.ts`
      (a device at its token cap: label says live updates paused, one `/sync/live` attempt in 10 s):
      passes; not run red against the old client.
- [x] docs: security-inventory (limits table), guide/security (known gaps), guide/self-hosting
      (tier 2), OPERATIONS (flags), security-review (H4/H12 done, tier-2 checklist), mcp-tools
      (`focus.selected_block_count`)
- [x] `pnpm -r typecheck`, `biome check --diagnostic-level=error`, `leak-check --tree`: clean

Commits: `59897202` (code + tests), then the docs/probes/e2e commit.

## Decisions

| Limit | Value | Why |
|---|---|---|
| Hello timeout | 10 s, close **4408** | A real client sends hello in the same tick as `open`. |
| Per token | 20, close **4429** "too many connections for this token" | `--ws-max-per-token`. Both endpoints count. A `/ui/live` re-hello is not a new connection. The loopback auto-token is exempt: every local tab and the desktop app share it. |
| Total | 500, close **4429** "server connection limit" | `--ws-max-total`. Per process (all graphs), counted at `open`, so unauthenticated sockets count. |
| `maxPayload` | 512 KiB, close **1009** (sent by `ws`) | Probe: every client frame is < 2.1 KB except `/ui/live` `state.result`, 954 B + 17 B per selected block id. Largest real page ~9.4k lines (docs/review/2026-10-03-sweep-core.md) -> select-all at most ~160 KB. 512 KiB fits ~30,800 ids (3x). 64 KiB (the backlog's suggestion) fits only 3,798, which a select-all on a big page exceeds. The client also trims the id list rather than exceed the limit. |
| Pre-hello frame | 16 KiB, close **1009** | A hello is < 1 KB; stops an anonymous socket making the server parse 512 KiB frames for 10 s. |

Close codes live in `LIVE_CLOSE` (`@nooklet/core`). 4401/4403 unchanged.

Client reconnect policy (`live-backoff.ts`): 4401/4403 stop; 4429/1009 wait 30 s doubling to 5 min,
±20% jitter; anything else (incl. 4408) 1 s doubling to 30 s as before. Delays reset only after a
socket stayed open 15 s (> hello timeout), not on `open`: a refused socket opens first, so the old
reset-on-open made a capacity refusal a 1 Hz reconnect loop. Sync indicator: 4429/1009 do not change
the state (push/pull still work; the B-614 grace probe decides); the label gains "live updates paused
(…); other devices' changes arrive every few minutes", cleared by the next poke or a different close.

## Still unverified

- That the largest real page has at most ~9.4k blocks: taken from the line count in
  docs/review/2026-10-03-sweep-core.md, not measured on the real graph here. If a page had more
  than ~30,000 blocks, a select-all `state.result` would be trimmed (with the real count), not
  refused.
- `/ui/live`'s consent badge flickers "connected" for the moment between `open` and a 4429; not
  looked at in a browser.

## BUGS.md updates to fold in

- **B-676**: status -> fixed. Append: "2026-10-04: H4/H12 fixed by ws-hardening — hello timeout
  10 s (4408), 20 sockets per token / 500 total (4429, `--ws-max-per-token`/`--ws-max-total`;
  loopback auto-token exempt from the per-token cap), `maxPayload` 512 KiB (1009) and 16 KiB before
  hello. Client backs off 30 s -> 5 min on 4429/1009 and stops on 4401/4403. Tests:
  `packages/server/src/live-limits.test.ts`, `apps/web/src/sync/live-backoff.test.ts`,
  `http-transport-live.test.ts`, e2e `live-limits.spec.ts`. Probes `ws-revocation.mjs`,
  `ws-limits.mjs`, `ws-frame-sizes.mjs`."
- **New, low (docs)**: `docs/guide/self-hosting.md` tier 2 still says "After revoking a device's
  token, restart the server" (pre-H3). Since H3 an in-app revoke closes the sockets at once and a
  CLI revoke closes `/sync/live` at the next commit; a CLI revoke does not reach `/ui/live` until
  it closes. Left as is here; needs a sentence that says exactly that.
- **New, low**: before this, both live sockets reset their reconnect delay on `open`, so any server
  that accepted and then closed a socket (a proxy dropping WebSockets after the upgrade) got a
  reconnect a second. Fixed in passing by `live-backoff.ts` (delay resets only after 15 s open).
