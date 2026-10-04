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
- [ ] probes against a real `nooklet serve`, e2e specs, docs

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

## BUGS.md updates to fold in

(filled in at the end)
