# Security inventory: every route and what it needs

**This list is enforced.** `packages/server/src/http/route-inventory.test.ts` enumerates the routes
actually registered on a graph's app (built-in plugins loaded, as `nooklet serve` runs it) and on
the process-level app. It sends each one a request with no token, and fails if a route answers
anything but 401 without being on the public allowlist in code:
`PUBLIC_ROUTES` / `OUTER_PUBLIC_ROUTES` in `packages/server/src/http/guards.ts`. If you add a
route, it is private unless you put it on that list with a reason, and then you update this page.

Last checked against the code: 2026-10-04 (security review, `docs/progress/security-review.md`;
QR pairing and `admin`-gated device management, `docs/progress/qr-pairing.md`; WebSocket limits,
`docs/progress/ws-hardening.md`; `DELETE /graphs/:id`, `docs/progress/graph-retire.md`; in-app
Logseq import, ADR 031).

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
   limit: 413 `too_large`, before the body is buffered. The in-app Logseq import (ADR 031) did not
   raise either cap: it arrives as `import.chunk` calls of at most 4 MiB each (~5.6 MB of base64),
   under the ordinary 16 MB. Its own total is the next section.

5. **WebSockets** (`/sync/live`, `/ui/live`; `packages/server/src/live-limits.ts`, B-676 H4/H12).
   They authenticate in their first message, so they get their own limits, with close codes from
   `LIVE_CLOSE` (`packages/core/src/live-socket.ts`):

   | Limit | Default | Close code |
   |---|---|---|
   | valid `hello` within | 10 s | 4408 |
   | sockets per token (both endpoints, per graph; the loopback auto-token is exempt) | 20, `--ws-max-per-token` | 4429 `too many connections for this token` |
   | sockets in total (per process, authenticated or not, counted at open) | 500, `--ws-max-total` | 4429 `server connection limit` |
   | frame size (`ws` `maxPayload`, default 100 MiB before) | 512 KiB | 1009 |
   | frame size before `hello` | 16 KiB | 1009 |
   | token unknown, revoked or without `can_sync` | | 4403 |
   | token revoked while open (H3) | | 4401 |
   | graph retired (`DELETE /graphs/:id`) or its folder replaced, every socket on it, hello or not (B-713) | | 4410 |

   512 KiB is sized by `tools/probes/security/ws-frame-sizes.mjs`: the only frame that grows is
   `/ui/live`'s `state.result` (17 bytes per selected block id), and the client trims it to fit.
   Tests: `packages/server/src/live-limits.test.ts`; probe `tools/probes/security/ws-limits.mjs`.

After that, routes still run their own, narrower checks: per-op scopes (`read`/`write`/`admin`/`ui:control`),
`can_sync` for `/sync/*`, and the MCP library's own bearer gate.

## Per graph: `/g/<graph-id>/...`

| Method | Path | Auth | Without a token it returns | Why public |
|---|---|---|---|---|
| GET | `/healthz` | none | `{"name":"nooklet","status":"ok"}` | liveness probe |
| GET | `/api/session` | none | graph instance id, suggested journal format and task workflow; `token: null` unless the peer is loopback, the request is same-origin (no foreign `Origin`, B-691), **and** the auto-token is on | how a client with no token learns which graph it is talking to |
| GET | `/openapi.json` | none | the full op list and schemas (no data) | API description for agents |
| GET | `/assets/:id` | none (capability URL) | the asset bytes if the id exists, or with `?w=480/960/1600` a resized WebP of it (ADR 035, same auth); served with `CSP: sandbox` + `nosniff` | `<img src>` cannot carry a bearer header (B-659, see below) |
| GET | `/plugins/:id/:file` | none | a content-hashed client plugin bundle | loaded by `import()`, build output |
| POST | `/api/v1/pairing.redeem` | none (a one-time pairing code in the body) | 401 for an unknown, expired, used or cancelled code (one answer for all); 400 for a malformed one; 429 + `Retry-After` past 10 attempts/min per TCP peer or 60/min in total | a new device has no token yet. Codes: 128 random bits, sha256-stored, single use (claimed atomically with the token mint), 10 min default, grant at most `write`. Two locks: the op's `auth: "none"` and this list. HTTP only, never MCP |
| GET (WS) | `/sync/live` | `can_sync` token in the first message | nothing until `hello`; then `{type:"poke",seq}`. Closed 4408 without a valid hello in 10 s (limits below) | browsers cannot set headers on a WS handshake. A plain GET without `Upgrade` needs a token |
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
| DELETE | `/graphs/:id` | root token. Retires the graph (B-713): closes its database and every `/sync/live`/`/ui/live` socket on it (close code 4410), then moves `graphs/<id>/` to `graphs-retired/<id>-<UTC timestamp>/`. Deletes nothing. `default` needs `?force=true` (409 otherwise). A graph's own tokens, `admin` included, get 401, and there is no MCP tool or op for it | 401 |
| * | `/g/<id>/...` | the graph's own guards above | 404 `No graph "<id>"` for an unknown id (this reveals which ids exist) |
| * | anything else | none | 307 to `/g/default/...` (or 404 when there is no default graph) |
| OPTIONS | any, from `capacitor://localhost` only | none | the CORS preflight answer; no other origin is reflected |

## What an unauthenticated visitor can learn

- That this is a nooklet server, and its op list (`/openapi.json`). **Not** which version: `/healthz`
  stays constant JSON on purpose, and `/openapi.json`'s `info.version` is the API version (`"1"`),
  not the build. The build version (B-696) is reported only to an authenticated MCP client
  (`initialize` → `serverInfo.version`) and on the local CLI (`nooklet --version`, `serve` banner),
  so a scanner cannot pick known bugs by version.
- Whether a guessed pairing code is live (`pairing.redeem`). 128-bit codes, at most 10 attempts a
  minute per peer and 60 in total, a handful live at once: about 2^-120 per attempt.
- Which graph ids exist (404 vs 401 on `/g/<id>/...`), and the default graph's instance id and
  journal/task-workflow settings (`/api/session`).
- An asset, if they already know or guess its id. Ids are 14 characters: 45 bits of millisecond
  time plus 25 random bits (`packages/core/src/ids.ts`). Guessing one needs the upload time to the
  millisecond window and ~2^24 tries per millisecond, which is impractical without a rate limit
  and much harder with one. But **an asset URL is a bearer capability that a revoked token does
  not revoke**: a former device that saw the id keeps access. See the hardening backlog.

## The in-app Logseq import (ADR 031)

`import.info`, `import.begin`, `import.chunk`, `import.start`, `import.status`, `import.cancel`:
ordinary `/api/v1/` ops, `admin` only, HTTP only (never MCP). A paired phone (`write`) gets 403.

- **Total upload**: `nooklet serve --import-max-mb <n>`, default 1024. Checked when the job opens
  (if the client says the size) and on every chunk. Over it: 413 and the job fails, bytes deleted.
- **One job per process.** A second `import.begin` while one runs is a 409. A job is visible only
  to the graph whose admin token opened it (another graph's admin gets 404 for its id).
- **Disk**: the upload is written to `<data>/import-staging/<job>/upload.zip`, then unpacked next
  to it and deleted. An upload with no chunk for 30 minutes is cancelled and deleted. The whole
  staging dir is deleted when the server starts.
- **Zip safety** (`packages/server/src/importer/zip.ts`, tests in `zip.test.ts`): absolute, drive
  letter and `..` names refuse the whole archive; output paths are built from four fixed directory
  names and one checked file-name component, never from the entry name; symlink entries are
  skipped; at most 200,000 entries and 4 GiB unpacked; an entry over 1 MiB that would unpack to
  more than 200x its packed size refuses the archive; inflation stops at each entry's declared
  size. Only `pages/*.md`, `journals/*.md`, `assets/*` and `logseq/config.edn` are written.
- **Targets**: a new graph is built in the staging dir and renamed into `graphs/<id>` only after
  `verify` passes, so a refused or cancelled import leaves no graph. The current graph is a target
  only while it has no content (409 otherwise).
- **What it adds to `admin`**: creating a graph on this server, which before needed the root token
  (`POST /graphs`). The new graph comes with an `admin` + sync token for the caller, as `POST
  /graphs` does. It cannot list, read or replace other graphs.
- Imported assets are served at `/assets/:id` like uploaded ones (capability URLs, below).

## Tokens

- Per-graph tokens: `nk_` + 24 random bytes (192 bits), stored as `sha256` only, looked up by hash
  (no secret-dependent string comparison). Revocation is immediate for HTTP: every request
  re-reads the row. `token.revoke` also closes the token's open `/sync/live` and `/ui/live`
  sockets (close code 4401); a revoke from the CLI (another process) closes a `/sync/live` socket
  at the next commit, before it is poked (B-676 H3). A socket that never sends a valid hello is
  closed after 10 s (4408, H4).
- Root token: `nkroot_` + 24 random bytes, file `<data>/root.token` (0600), compared with
  `timingSafeEqual`. No rotation command; delete the file and restart to rotate.
- `admin` scope (B-655): `write` plus server administration — `pairing.create`, `token.list`,
  `token.revoke`, and the `import.*` ops (ADR 031), which can create a new graph. Held by the loopback web-client auto-token (the desktop app), the token
  `POST /graphs` returns, and `token create --scope admin`. Never by a token from a pairing code.
- Pairing codes: `nkp_` + 16 random bytes (128 bits), `pairing_code` table, sha256 only. Created
  by an `admin` token (`pairing.create`) or `nooklet pair`; a new code cancels the same creator's
  earlier unused one. The QR carries `<graph>/pair#code=…`: the code is in the URL fragment, so it
  never reaches a server or proxy log.
- Token links (`token create --link`): the link contains a long-lived token. Still accepted;
  `nooklet pair` replaces it for phones.
- Loopback auto-token: on only for a loopback bind; off with a non-loopback `--host` unless
  `--loopback-token` is passed; off always with `--no-loopback-token`.
