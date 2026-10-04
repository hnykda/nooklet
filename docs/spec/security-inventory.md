# Security inventory: every route and what it needs

**This list is enforced.** `packages/server/src/http/route-inventory.test.ts` enumerates the routes
actually registered on a graph's app (built-in plugins loaded, as `nooklet serve` runs it) and on
the process-level app. It sends each one a request with no token, and fails if a route answers
anything but 401 without being on the public allowlist in code:
`PUBLIC_ROUTES` / `OUTER_PUBLIC_ROUTES` in `packages/server/src/http/guards.ts`. If you add a
route, it is private unless you put it on that list with a reason, and then you update this page.

Last checked against the code: 2026-10-04 (security review, `docs/progress/security-review.md`).

## How auth is laid out (deny by default)

A graph's app installs `installRequestGuards` (`http/guards.ts`) **before any route**, plugin routes
included. For every request, in order:

1. **Security headers** on the response: `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and
   `Strict-Transport-Security: max-age=31536000` when the request arrived over TLS
   (`X-Forwarded-Proto: https` or `Forwarded: proto=https` from the proxy). The app shell adds its
   own CSP (below).
2. **Host allowlist**: with a non-loopback `--host`, a `Host` not in loopback + `--allow-host` is a
   403 (DNS rebinding). With a loopback bind it applies to `/mcp` only (B-616).
3. **Auth**: a valid, unrevoked bearer token is required, unless the request is
   - on `PUBLIC_ROUTES` (table below), or a plugin route registered with `auth: "none"`, or
   - a `GET`/`HEAD` **outside** the API prefixes `/api`, `/sync`, `/ui`, `/mcp`, `/graphs`,
     `/assets`, `/plugins`, `/openapi.json`. That is the static web client and its SPA
     fallback, which serve build output only.
   Missing or invalid token: 401 with `WWW-Authenticate: Bearer`.
4. **Body size**: 16 MB, or 48 MB for `/api/v1/asset.upload`, `/mcp` and `/sync/push`. Over the
   limit: 413 `too_large`, before the body is buffered.

After that, routes still run their own, narrower checks: per-op scopes (`read`/`write`/`ui:control`),
`can_sync` for `/sync/*`, and the MCP library's own bearer gate.

## Per graph: `/g/<graph-id>/...`

| Method | Path | Auth | Without a token it returns | Why public |
|---|---|---|---|---|
| GET | `/healthz` | none | `{"name":"nooklet","status":"ok"}` | liveness probe |
| GET | `/api/session` | none | graph instance id, suggested journal format and task workflow; `token: null` unless the peer is loopback, the request is same-origin (no foreign `Origin`, B-691), **and** the auto-token is on | how a client with no token learns which graph it is talking to |
| GET | `/openapi.json` | none | the full op list and schemas (no data) | API description for agents |
| GET | `/assets/:id` | none (capability URL) | the asset bytes if the id exists; served with `CSP: sandbox` + `nosniff` | `<img src>` cannot carry a bearer header (B-659, see below) |
| GET | `/plugins/:id/:file` | none | a content-hashed client plugin bundle | loaded by `import()`, build output |
| GET (WS) | `/sync/live` | `can_sync` token in the first message | nothing until `hello`; then `{type:"poke",seq}` | browsers cannot set headers on a WS handshake. A plain GET without `Upgrade` needs a token |
| GET (WS) | `/ui/live` | `can_sync` token in the first message | as above | as above |
| GET/HEAD | anything outside the API prefixes | none | the app shell / static build files | the web client |
| * | `/api/v1/<op>` and REST aliases | token + the op's scopes | 401 | |
| GET | `/api/v1/plugins` | token | 401 | |
| * | `/api/plugins/<id>/...` | token, unless the plugin registered `auth: "none"` (none of the built-ins do) | 401 | |
| POST | `/sync/push`, GET `/sync/pull`, `/sync/snapshot` | token with `can_sync` | 401 / 403 | |
| * | `/mcp` | token (`read` minimum) | 401 | |

## Process level (outside any graph)

| Method | Path | Auth | Without a token it returns |
|---|---|---|---|
| GET | `/healthz` | none | constant JSON |
| GET | `/sw.js`, `/manifest.webmanifest`, `/workbox-*` | none | build output (a service worker script must not be a redirect) |
| GET/POST | `/graphs` | root token (`<data>/root.token`, compared timing-safe) | 401 |
| * | `/g/<id>/...` | the graph's own guards above | 404 `No graph "<id>"` for an unknown id (this reveals which ids exist) |
| * | anything else | none | 307 to `/g/default/...` (or 404 when there is no default graph) |
| OPTIONS | any, from `capacitor://localhost` only | none | the CORS preflight answer; no other origin is reflected |

## What an unauthenticated visitor can learn

- That this is a nooklet server, and its op list (`/openapi.json`).
- Which graph ids exist (404 vs 401 on `/g/<id>/...`), and the default graph's instance id and
  journal/task-workflow settings (`/api/session`).
- An asset, if they already know or guess its id. Ids are 14 characters: 45 bits of millisecond
  time plus 25 random bits (`packages/core/src/ids.ts`). Guessing one needs the upload time to the
  millisecond window and ~2^24 tries per millisecond, which is impractical without a rate limit
  and much harder with one. But **an asset URL is a bearer capability that a revoked token does
  not revoke**: a former device that saw the id keeps access. See the hardening backlog.

## Tokens

- Per-graph tokens: `nk_` + 24 random bytes (192 bits), stored as `sha256` only, looked up by hash
  (no secret-dependent string comparison). Revocation is immediate for HTTP: every request
  re-reads the row. **Open WebSockets are not closed on revocation** (see backlog).
- Root token: `nkroot_` + 24 random bytes, file `<data>/root.token` (0600), compared with
  `timingSafeEqual`. No rotation command; delete the file and restart to rotate.
- `admin` scope: today grants nothing beyond `write`; no op requires it (B-655).
- Loopback auto-token: on only for a loopback bind; off with a non-loopback `--host` unless
  `--loopback-token` is passed; off always with `--no-loopback-token`.
