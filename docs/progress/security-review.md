# Security review: public exposure behind a TLS reverse proxy (tier 2)

Started 2026-10-04 from `5cc2d9f`. Scope: what "public behind a TLS reverse proxy" needs, with
evidence; fix small defects in `packages/server/src/http` and `auth`; then (coordinator extension)
an enforced route inventory, deny-by-default auth, safe defaults, and a hardening backlog.
Scratch servers on ports 6455-6457 only, `NOOKLET_DATA` always a fresh `mktemp -d`. Probes in
`tools/probes/security/`.

## Done
- Verified checkout (hnykda/nooklet, fast-forwarded f7c9644 -> 5cc2d9f), `pnpm install`.
- Read tokens/root-token/pairing-link, http/*, graphs/mount, sync auth + WS, live WS, MCP gate,
  plugin routes, prior reviews (`rv-server-security.md`, `rv-web-security.md`).
- Probes (before/after results in each file's header):
  `unauth-surface.mjs`, `ws-revocation.mjs`, `body-size.mjs`, `csp-violations.mjs`.
- Client XSS sinks reviewed by a read-only sub-agent (findings below, item 5).
- `pnpm audit --prod` (item 8).
- Code (uncommitted at time of writing → see git log for the commit):
  - `http/guards.ts` (new): guards installed before ANY route; deny-by-default auth with
    `PUBLIC_ROUTES`/`OUTER_PUBLIC_ROUTES`; security headers; body limits; Host guard moved here.
  - `plugins/bootstrap.ts`: installs the guards before the plugin host mounts routes.
  - `plugins/routes.ts`: `auth: "none"` routes are recorded on the allowlist.
  - `http/app.ts`: `/api/v1/*` bearerAuth and the Host guard replaced by the guards;
    `loopbackTokenEnabled` (off by default for a non-loopback `--host`).
  - `http/web-client.ts`: `shellCsp` on the shell and on built `.html` files.
  - `graphs/mount.ts`: security headers + body limit on the process-level app.
  - `auth/tokens.ts`: `WWW-Authenticate: Bearer` on 401.
  - `cli.ts`: `--loopback-token` tri-state.
  - Tests: `http/route-inventory.test.ts` (5), `http/security-defaults.test.ts` (12).
  - `docs/spec/security-inventory.md` (new).
- Server unit suite: 99 files / 800 tests green; `tsc --noEmit` clean; biome clean.
- CSP checked in real Chromium against the production build (`csp-violations.mjs`): 0 violations
  from the app (KaTeX, code fence, mermaid fence, links, reload); an injected inline script was
  blocked.

- Committed `2e80cc7`; merged `main`; filled the two `TODO (security review)` blocks in
  `docs/guide/self-hosting.md` and `docs/guide/security.md` (only those blocks).
- After the merge: server unit 100 files / 809 tests green, `tsc` clean.
- First e2e attempt is void: a sibling agent wrote to the same scratchpad log name, so the
  output could not be attributed. Re-running with a unique log name.

- Full `pnpm e2e` (port 6457, merged tree, CSP + guards): 746 passed, 2 skipped, 2 failed:
  `journal-agenda.spec.ts:182` and `mermaid-lazy-cache.spec.ts:30`. Both pass when re-run alone
  (12/12), and mermaid-lazy-cache passes `--repeat-each=3` (6/6). A sibling agent's full run
  without these changes failed the same mermaid-lazy-cache test, so both look load-flaky, not
  caused by this branch. Believed, not proven.
- Scratch servers on 6455/6456 stopped.

## In flight
- Nothing. Done.

## Next steps
- Coordinator: fold "BUGS.md updates" and the backlog into BUGS.md / PLAN.md; merge the branch.

## For the docs agent (outside the TODO blocks, not edited by me)
- `docs/guide/self-hosting.md` flag table (`--no-loopback-token` row) and `docs/guide/security.md`
  around line 133 describe the auto-token as on unless `--no-loopback-token`. Since this branch,
  it is **off by default for a non-loopback `--host`** (`--loopback-token` turns it back on).
  The `serve` synopsis should gain `[--loopback-token]`.

## How to resume
Re-read this file; `git log 5cc2d9f..HEAD`; `git status` for uncommitted files listed above.

---

## Route inventory (summary)

Full table: `docs/spec/security-inventory.md` (enforced by `http/route-inventory.test.ts`).
Public without a token: `/healthz` (both levels), `/api/session` (graph instance id, journal
format, task workflow; a token only to a loopback peer with the auto-token on), `/openapi.json`
(op list, no data), `/assets/:id` (capability URL), `/plugins/:id/:file` (hashed bundles), the
WS handshakes `/sync/live` and `/ui/live` (token in first message), the static shell, `/sw.js`,
manifest, workbox chunk. Everything else: per-graph token (+ op scope / `can_sync`) or the root
token (`/graphs`). Unknown graph id answers 404 before auth, so graph ids are enumerable.

## Findings, ranked (with evidence)

1. **Medium — no request body limit** (fixed). 300 MB to `page.list` / `sync/push` with a valid
   token: server RSS 206 MB -> 1,463 MB, body fully buffered (`body-size.mjs`). A few parallel
   requests from any token holder (or a stolen read token) can OOM the process. Now 16 MB /
   48 MB caps, 413 in ~25 ms, RSS flat. Test: `security-defaults.test.ts` "request body limits".
2. **Medium — Host (DNS-rebinding) guard skipped for plugin routes** (fixed). Routes mounted by
   `createAppWithPlugins` before `createApp` ran ahead of the guard: `/g/default/plugins/...`
   answered 200 to `Host: evil.example` on a `0.0.0.0` bind while every other route 403'd
   (`unauth-surface.mjs`). Plugin API routes under `/api/plugins/<id>` had the same gap (they
   still required a token). Guards now install first. Test: `route-inventory.test.ts` exercises
   the plugin-loaded app; `host-guard.test.ts` unchanged and green.
3. **Medium — revocation does not close open WebSockets; unauthenticated sockets never time
   out** (logged, backlog H3/H4). `ws-revocation.mjs`: after `nooklet token revoke`, the token's
   next HTTP call is 401 at once, but its `/sync/live` socket stays open and keeps receiving
   pokes (seq numbers only — no note content). A socket that never says `hello` is still open
   after 12 s; nothing closes it.
4. **Medium — no security headers / CSP** (fixed). Now nosniff, `X-Frame-Options: DENY`,
   `Referrer-Policy: no-referrer` (page names in app URLs no longer leak to linked sites), HSTS
   behind TLS, and a hash-based script CSP on the shell. Tests: `security-defaults.test.ts`.
5. **Low — client XSS**: no script-execution path found from note content (sub-agent review):
   `safeHref` blocks `javascript:`/`data:`/`vbscript:`/`blob:` including case/whitespace/control
   tricks; no raw HTML in markdown; KaTeX `trust: false`; highlight.js escapes; mermaid
   `securityLevel: "strict"` (DOMPurify 3.4.15); custom CSS is local-only (`textContent`).
   Latent: `PluginFence.tsx` inserts plugin output via `innerHTML` unsanitised — safe only while
   client plugins are the compiled-in built-ins. Remote images load freely (IP leak / tracking
   pixel). The new CSP is the backstop for any future sink.
6. **Low — fail-open loopback auto-token on a non-loopback bind** (fixed, behaviour change).
   With `--host 0.0.0.0` the auto-token was still minted for anything that looked local, which
   behind a same-host proxy that rewrites Host without forwarding headers is everyone (B-600 D3
   relied on remembering `--no-loopback-token`). Now off unless `--loopback-token`. The desktop
   sidecar binds loopback (`main.rs#spawn_server` passes no `--host`) and is unaffected; the
   Dockerfile/chart already pass `--no-loopback-token`. **Behaviour change:** someone who runs
   `serve --host 0.0.0.0` and opens `http://localhost:6100` on the same machine now has to paste a
   token (or pass `--loopback-token`). Test: `security-defaults.test.ts` "loopback auto-token
   default".
7. **Low — no rate limiting or lockout anywhere** (B-654, backlog H1). `grep 429` finds only the
   error-code table; `docs/spec/mcp-tools.md:241` documents per-token limits that do not exist.
   Brute force against 192-bit tokens is infeasible, so this is about DoS cost and the asset
   capability (8), not token guessing.
8. **Low — `/assets/:id` is an unauthenticated capability URL** (B-659, backlog H5). Id = 45-bit
   ms time + 25 random bits (`packages/core/src/ids.ts`), monotonic within a millisecond.
   Blind guessing needs the upload millisecond and ~2^24 requests per candidate ms — impractical,
   not impossible without a rate limit. The real gap: a revoked device keeps every asset URL it
   has seen. Not fixed (signed URLs need a client change); served with `CSP: sandbox` + nosniff.
9. **Low — `admin` scope gates nothing** (B-655). `grep 'scopes: ['`: 19 ops `read`, 19 `write`,
   5 `ui:control`, 0 `admin`. Token management is CLI-only. Recommendation in backlog H6.
10. **Info — graph-id enumeration**: `/g/<unknown>/...` 404 vs 401/403. Low value; ids are names
    the owner chose.
11. **Info — root token printed to stderr on first start** (container logs keep it). Already
    documented for k8s (SOPS value). Recommend docs mention it.
12. **Info — tokens**: 192-bit `randomBytes`, stored as sha256, looked up by hash (no
    timing-dependent compare of secrets); root token compared with `timingSafeEqual`. OK.
    Device tokens live in `localStorage` (XSS-reachable — hence the CSP). Pairing link is only
    ever a `nooklet://` deep link, never loaded as an http page URL, so no Referer/history
    leakage from the server side; its own leakage (clipboard, chat) is documented (B-603).
13. **Info — server-side plugins**: full Node privileges in the server process; installed only by
    putting a directory in `<data>/plugins` (or the repo/bundled dirs). No API installs plugins.
    Anyone who can write the data dir already owns the graph. Backlog H8.
14. **Info — forwarded headers**: the server trusts none for identity. Forwarding headers only
    *disable* the loopback token (B-600) and enable HSTS. No `X-Forwarded-For`-based logic
    exists, so nothing to spoof.

### Dependencies (`pnpm audit --prod`, 2026-10-04)
3 advisories, all via the client-side mermaid plugin: lodash-es 4.17.23 (high: `_.template`
code injection GHSA-r5fr-rjxr-66jc; moderate: prototype pollution GHSA-f23m-r3pf-42rh) through
chevrotain, and dompurify 3.4.15 (low: GHSA-p98j-92pf-mc4p, IN_PLACE hook). None is reachable
with attacker input as used (chevrotain does not call `_.template` on user data; mermaid does not
use DOMPurify `IN_PLACE`) — unverified beyond reading the advisories' preconditions. Fix:
`pnpm.overrides` for `lodash-es >=4.18.1` and `dompurify >=3.4.16` (H9). No server-side
advisories.

## BUGS.md updates to fold in

- **B-654** (rate limiting documented, nothing returns 429): confirmed. Status stays open;
  recommendation H1. Until then the tier-2 docs require proxy-level limits.
- **B-655** (`admin` grants nothing beyond `write`): confirmed (0 ops require it). Recommendation
  H6; owner decision.
- **B-659** (`/assets/<id>` needs no token): entropy measured (25 random bits + ms time),
  not practically guessable blind; revocation gap confirmed. Open; recommendation H5.
- **NEW (needs a number) — no request body limit; 300 MB buffered to 1.46 GB RSS.** Fixed in this
  branch. Test `http/security-defaults.test.ts` "request body limits"; probe `body-size.mjs`.
- **NEW — Host guard skipped for routes mounted before `createApp` (plugin routes,
  `/plugins/:id/:file`).** Fixed (guards install first). Test `http/route-inventory.test.ts`;
  probe `unauth-surface.mjs`.
- **NEW — no security headers or CSP.** Fixed. Test `http/security-defaults.test.ts`; probe
  `csp-violations.mjs`.
- **NEW — loopback auto-token on by default for a non-loopback bind.** Fixed (behaviour change,
  above). Test `security-defaults.test.ts` "loopback auto-token default".
- **NEW — revoked token's open WebSockets stay open; unauthenticated sockets never time out.**
  Open; H3/H4. Probe `ws-revocation.mjs`.
- **NEW — mermaid dependency advisories (lodash-es, dompurify).** Open; H9.

## Hardening backlog

| # | Item | Severity | Effort | Recommendation |
|---|---|---|---|---|
| H1 | Rate limiting / lockout on failed auth (B-654) | Medium on a public server | M (1-2 days) | In-process token-bucket keyed by token id for authenticated calls (the limits `mcp-tools.md:241` already documents) and by client IP for 401s — the IP only from a configured `--trust-proxy` hop, never from raw `X-Forwarded-For`. 429 `rate_limited` with `Retry-After`. Until then: proxy-level limits (tier-2 checklist). Or amend the spec to say limits are the proxy's job. |
| H2 | Audit log of auth failures | Low | S | One stderr line per 401/403 with route, peer/forwarded-for, token id prefix if any; sampled (first N per minute per source) so it cannot flood logs. Lets fail2ban/CrowdSec act on it. |
| H3 | Close WebSockets on revocation | Medium | S | Re-check the token row on each poke/command send (cheap: one indexed SELECT) and close 4401 when revoked; or add a 60 s periodic sweep of registered sockets. Revocation happens in another process (CLI), so a notification will not reach the server. |
| H4 | WebSocket handshake timeout and connection caps | Medium | S | Close a socket that has not sent a valid `hello` within 10 s; cap sockets per token (e.g. 20) and total (e.g. 500); set `ws` `maxPayload` (default 100 MB) to e.g. 64 KB — these sockets only carry small JSON. |
| H5 | Asset access (B-659) | Low | M | Short-lived signed URLs: `/assets/:id?exp=..&sig=HMAC(graph secret, id, exp)` minted by an authenticated op the client calls when rendering; or an HttpOnly same-site cookie set by `/api/session` exchange for same-origin `<img>`. Either makes revocation cover assets. Rotating the graph secret revokes every outstanding URL. |
| H6 | Give `admin` a meaning or drop it (B-655) | Low | S-M | Recommended: keep it and gate server-administration ops on it as they land — token list/create/revoke over the API (needed to revoke a lost phone from another device), plugin settings, gc/backup triggers. Keep destructive *content* ops (delete, replace, merge, undo) at `write`: the phone app uses them with a device token and every one is undoable. Until then, document "admin = write today" and stop minting `admin` for `POST /graphs` creators (mint `write` + sync). |
| H7 | Host check on loopback binds | Low | S | Today the Host allowlist applies only to non-loopback binds (except `/mcp`). A loopback-bound server behind a same-host proxy accepts any Host. Enforcing always would require `--allow-host` for every proxy setup (B-616 trade). Recommend: enforce when `--no-loopback-token` is set (a proxied deployment by definition). |
| H8 | Server plugin sandboxing | Low (config-only install) | L | Server plugins run with full Node privileges. Acceptable while install = filesystem write. If remote install ever exists, run plugins in a worker with `--experimental-permission` or a separate process with a narrow RPC. Client plugins: sanitise `PluginFence` HTML (DOMPurify) before third-party client plugins are allowed. |
| H9 | Dependency update policy | Low | S | `pnpm.overrides` for lodash-es >=4.18.1 and dompurify >=3.4.16 now; CI job running `pnpm audit --prod --audit-level high` weekly and on lockfile changes; Renovate/Dependabot grouped monthly for minor/patch. |
| H10 | Vulnerability disclosure | Low | S | `SECURITY.md` with a private contact (GitHub private vulnerability reporting enabled on the repo), supported versions = latest release, 90-day disclosure. (Docs agent added a `SECURITY.md`; check it names the channel.) |
| H11 | Remote image loading | Low | S | Optional `img-src 'self' data: blob:` setting (privacy mode) — off by default because notes legitimately embed remote images. |
| H12 | `ws` `maxPayload`, Node `server.requestTimeout`/`headersTimeout` | Low | S | Node defaults (300 s / 60 s) are fine behind a proxy; set `maxPayload` as in H4. |

## For the docs (tier 2 checklist)

Tier 2: public internet, behind a TLS reverse proxy. Reasonable for a single owner **if every item
holds**:

1. **TLS at the proxy**, HTTP→HTTPS redirect, and the proxy sets `X-Forwarded-Proto: https`
   (nooklet then sends HSTS). Never expose nooklet's own port; bind it to loopback or a private
   network the proxy reaches.
2. **`--no-loopback-token`** (and with `--host` non-loopback it is off by default anyway). A
   same-host proxy that rewrites `Host` must also add `X-Forwarded-For`/`Forwarded`.
3. **`--allow-host <your public name>`**, and nothing broader.
4. **Per-device tokens**, `--scope write --sync` for devices, `read` for read-only agents; revoke
   with `nooklet token revoke` on any doubt. After revoking, **restart the server** if the device
   may still be connected (open WebSockets are not closed by revocation yet) — and treat any
   asset URLs that device saw as still readable (B-659).
5. **Proxy-level limits** (nooklet has none yet, B-654): request rate per IP (e.g. 10 r/s burst
   50 on `/g/*/api`, `/mcp`, `/sync`), concurrent connections per IP, WebSocket idle/connection
   limits, client body size ≤ 48 MB (nooklet enforces 16/48 MB itself), and optionally
   fail2ban/CrowdSec on repeated 401s.
6. **WebSocket upgrade** forwarded for `/g/*/sync/live` and `/g/*/ui/live`, with an idle timeout.
7. **Keep the root token off the network**: it is printed once on first start (container logs);
   `/graphs` should be reachable only from the operator, e.g. deny `/graphs` at the proxy.
8. **Do not install server plugins you have not read**: they run with the server's full rights.
9. **Backups** of the data dir (the op log is the history), and keep nooklet updated.
10. Know what is public without a token: health checks, the op list, graph ids, and any asset
    whose URL someone has (`docs/spec/security-inventory.md`).

**Verdict:** reasonable today for one owner with a few devices, under the checklist above — the
API is deny-by-default and enforced by a test, tokens are 192-bit and hashed, bodies are capped,
and the shell has a script CSP. Not yet reasonable for multiple users or a high-profile host:
missing in-process rate limiting (H1), WebSocket revocation/timeouts (H3/H4) and revocable asset
URLs (H5). The tailnet-only default remains the recommendation.
