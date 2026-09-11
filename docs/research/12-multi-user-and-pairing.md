# 12 — Multi-user, multi-graph, and device onboarding

Dated record, 2026-09-11. Like the other files in `docs/research/`, this is kept as written rather
than updated in place; it is a record of what was known and measured on this date. The decision it
would feed is ADR 017 (ADR 016 is reserved for `research/10`'s desktop-packaging decision).

**Bottom line: stay single-user, and spend the effort on pairing instead.** Sections 6–9 work out
what multi-user would actually cost, because "the design leaves room for graph membership later"
(PLAN.md §2) is a claim worth testing rather than repeating — and it turns out to be half true in a
specific, fixable way. But the honest answer for a tool with one user is that the multi-user schema
is not the bottleneck; *getting a phone connected safely over a LAN* is, and that part is both
cheap and currently broken in three verified ways (§1.6).

---

## 1. What the code actually does today

Everything in this section was read out of the repository at commit `0654dd5`, and the claims in
§1.6 were reproduced against a running `nooklet serve`.

### 1.1 One user, one graph, and a `graph_id` column that does nothing

`ServerConfig.graphId` (`packages/server/src/ops/registry.ts:200`) is set to the literal `"default"`
in `cli.ts:126`, `test-helpers.ts:38`, `smoke.test.ts:71`, `mcp/stdio.ts:90`,
`plugins/plugin-test-helpers.ts:67` and `embeddings/manual-verify-real-ollama.ts:51`.

It is **never read**. `grep -rn "config\.graphId\|\.graphId" packages apps | grep -v "graphId:"`
returns nothing. Not one query filters on it; not one write reads it.

Meanwhile `docs/spec/sql-schema.md` rule 2 requires that "every top-level writable table … MUST
carry `graph_id TEXT NOT NULL DEFAULT 'default'`", and ten tables in `packages/server/src/schema.ts`
plus two in `packages/core/src/sync/schema.ts` duly do. The three places that write the column
(`apply-ops.ts:323`, `ops/asset-upload.ts:168` and `:177`, `embeddings/settings.ts:55`) hardcode the
string `'default'` **inline in the SQL**, not from config. Everywhere else the column is filled by
its `DEFAULT`.

So the column is not a multi-graph seam. It is a comment in DDL form. §6.1 works out why that
matters and why the alternative is better anyway.

### 1.2 Auth: static bearer tokens, hashed, with a tier plus two orthogonal capabilities

`packages/server/src/auth/tokens.ts`:

- `createToken` mints `nk_` + `randomBytes(24).toString("hex")` — 24 random bytes, **192 bits** of
  entropy, 51 characters. The `nk_` prefix is cosmetic ("makes a leaked token recognisable in logs
  and secret scanners"). Only `sha256(token)` is stored, in `token.token_hash` (`UNIQUE`).
- `verifyToken` does `SELECT * FROM token WHERE token_hash = ?` and returns null if
  `revoked_at IS NOT NULL`. It then runs `UPDATE token SET last_used_at = ?` — **a write on every
  authenticated request**, on the server's single shared SQLite connection. Fine for one user;
  worth remembering in §11.
- `scopesFor` implies weaker tiers (`admin` ⊃ `write` ⊃ `read`). `allScopesFor` appends
  `"ui:control"` when `token.ui_control` is set. `Permission = Scope | "ui:control"`
  (`ops/registry.ts:52`), deliberately modelled as a fourth permission value so the existing
  per-op check `current.scopes.every(s => ctx.scopes.includes(s))` (`registry.ts:436`) covers it
  with no parallel capability system. ADR 015 §7.
- `can_sync` is the second orthogonal capability, checked only in `sync/auth.ts#requireSyncToken`
  and in `sync/live.ts`'s WebSocket `hello` handler.
- There is **no expiry**. The `token` table has `created_at`, `last_used_at`, `revoked_at` and
  nothing else; `mcp/server.ts:56` defines `NEVER_EXPIRES = now + 100 years` purely to satisfy the
  MCP SDK's `requireBearerAuth`, which rejects an `AuthInfo` without `expiresAt`.
- There is **no user column and no graph column that is used**. A token *is* the identity.

Three independent auth paths verify the same token table: `bearerAuth` middleware on `/api/v1/*`
(`http/app.ts:130`), `requireSyncToken` called by hand from each `/sync/*` route, and
`verifyAccessToken` inside the MCP SDK's `requireBearerAuth` (`mcp/server.ts:281`). `/assets/:id`
and `/openapi.json` and `/api/session` have no auth at all.

### 1.3 The web client gets its token from its own origin, but only on loopback

`http/app.ts#buildClientBootstrap` returns `{ token: webClientToken(ctx) }` when
`isLoopbackHost(c.req.header("host"))`, and `{ token: null, reason: "non_loopback_host" }`
otherwise. `webClientToken` mints one `write` + `can_sync` token per process, memoised in a
`WeakMap<ServerContext, string>`, labelled `"web-client (auto)"`. `ui_control` is deliberately not
granted.

The client fetches this from `GET /api/session` at startup (`apps/web/src/data/bootstrap.ts`) rather
than reading it out of injected HTML — B-19 in `docs/BUGS.md`: the service worker precached
`index.html` at build time, so the injected token vanished on every reload after the first.

A remote device therefore arrives with no credential and lands on `ConnectView.tsx`, a paste-a-token
screen that validates the pasted value with `POST /api/v1/graph.overview` before writing it to
`localStorage["nooklet.deviceToken"]` and reloading. Its own header says the quiet part out loud:

> A pairing code or QR is a nicer front-end for this same exchange and is worth doing later; it is
> not a different security model.

That is right, and §5 is what "later" should look like.

### 1.4 Exposure model: loopback by default, a Host allowlist when widened

`ServerConfig.host` defaults to `127.0.0.1`; `--host` widens it and `--allow-host` adds hostnames to
the DNS-rebinding allowlist that `@modelcontextprotocol/hono`'s `createMcpHonoApp` installs
(`mcp/server.ts:268`). `cli.ts:240` warns when `--host` is given without `--allow-host`. There is no
TLS anywhere in the codebase; `README.md` and `ConnectView.tsx` both point at a reverse proxy or
Tailscale.

### 1.5 `device` rows are advisory, not identity

`sync/device.ts#touchDeviceOnPush` upserts a `device` row using the `device_id` the **client chose
and put in its own request body** (`sync/push.ts`'s `PushBody`). The client generates it once with
`newDeviceId()` and keeps it in `sync_state` (`apps/web/src/sync/sync-client.ts:111`). Nothing binds
a `device_id` to a token: one token can register unlimited device rows, and two devices can claim
the same id. The `token_id` column is set only on first insert, from whichever token happened to
push first.

This matters for §8 (revocation) and for `nooklet gc`, whose floor is
`MIN(device.acked_seq)` over devices whose token is not revoked (`gc.ts#computeGcFloor`).

### 1.6 Three defects found while verifying the above

All three were reproduced against a real `nooklet serve` started from this working tree, not
reasoned about. They are the reason §5 and §10 are the parts of this document worth acting on.

**(a) A forged `Host: localhost` header hands any LAN caller a `write` + `can_sync` token.**

`isLoopbackHost` (`http/app.ts:57`) inspects the `Host` *header*, which is entirely under the
caller's control. `/api/session` is not behind the DNS-rebinding guard (see (b)). So on a server
started the way `README.md` tells you to start it for phone access:

```
$ nooklet serve --data <dir> --port 6198 --host 0.0.0.0 --allow-host 192.168.1.5
$ curl -s -H 'Host: localhost:6198' http://192.168.1.6:6198/api/session
{"token":"nk_<redacted>"}
```

That is the machine's real LAN address, a forged one-line header, and a full read/write/sync
credential for the graph. Every device on the Wi-Fi can do this. It defeats the loopback-only rule,
the ConnectView screen, and the entire premise that a remote device must be *given* a token.

The fix is one line of principle: **the loopback test must read the socket, not the header.**
`@hono/node-server@2.1.1` already ships `getConnInfo` (`dist/conninfo.mjs`), which returns
`remote.address` from `incoming.socket.remoteAddress`. `isLoopbackHost(host)` should become
`isLoopbackPeer(c)` checking that address against `127.0.0.0/8` and `::1`, with the `Host` check
kept as an additional condition, not the only one.

**(b) The DNS-rebinding / `Host` allowlist covers only `/` and `/mcp`.**

Hono composes every matching handler in registration order, and a terminal handler ends the chain.
`createApp` registers `/api/session`, `/openapi.json`, `/assets/*`, `/api/v1/*`, `/sync/*` and
`/ui/live` **before** `app.route("/", mcpApp)` (`http/app.ts:123–166`), so the guard that
`createMcpHonoApp` installs as `use("*")` sits later in the chain and never executes for any of
them. Measured, with `--host 0.0.0.0 --allow-host 192.168.1.5`:

| Path | `Host: evil.example.com` |
|---|---|
| `/` (SPA fallback) | **403** |
| `/mcp` | **403** |
| `/api/session` | 200 |
| `/openapi.json` | 200 |
| `/api/v1/graph.overview` | 200 (401 without a token) |
| `/sync/pull` | 200 (401 without a token) |

The existing test (`http/web-client.test.ts`, "refuses a LAN Host by default and accepts one that
was allowlisted") only ever probes `/`, which is why this held. The residual risk is bounded by
bearer auth on the interesting routes and by the browser's own CORS preflight (no CORS middleware is
installed anywhere, so a cross-origin `POST … content-type: application/json` never leaves the
browser) — but combined with (a) it is exactly the hole that lets a rebound page ask for a token.

**(c) With `--host` but no `--allow-host`, there is no `Host` guard at all — and the CLI says the
opposite.**

`mountMcp` passes `allowedHosts` only when `config.allowedHosts?.length` is truthy; otherwise it
calls `createMcpHonoApp({ host: config.host })`, and the library logs
`Server is binding to 0.0.0.0 without DNS rebinding protection` and permits every `Host`. Measured:
with `--host 0.0.0.0` and no allowlist, `/`, `/mcp` and everything else returned 200 for
`Host: evil.example.com`. Meanwhile `cli.ts:242` prints:

> bound to 0.0.0.0 with no --allow-host. Requests arriving with any other Host header (a LAN IP, a
> tailnet name) are **refused**

They are not refused. The warning describes behaviour the code does not have.

**(d), minor: auto-minted web-client tokens accumulate and are never revoked.** Each server process
mints a fresh `"web-client (auto)"` token on the first loopback page load and leaves the previous
process's row `active` forever. Two restarts, two rows:

```
1m27sy87kstgeg  write  active   last used never  web-client (auto)
1m27t1ak7fx29f  write  active   last used never  web-client (auto)
```

`last used never` because `/api/session` mints without verifying. A long-running install grows one
live write credential per restart, and none of them is distinguishable from the current one in
`nooklet token list`.

> These belong in `docs/BUGS.md` with the probe commands attached. This document does not write
> there, per the task it was produced under; the finder should.

---

## 2. The recommendation, up front

1. **Do not build users.** One person, several devices, one graph per server directory. PLAN.md §17
   item 7 already decided this and nothing in §6–§9 changes the answer for this tool.
2. **Fix §1.6 first.** (a) is a LAN-wide credential leak on the exact configuration the README
   recommends. Nothing else in this document matters more.
3. **Replace paste-a-token with a pairing code** (§5): a 8-character base-20 code shown by
   `nooklet pair` on the server, entered on the phone, exchanged for a real device token. Five
   minutes' life, single use, five attempts, token bound to the device. QR as the fast path for the
   same code. This is ~250 lines and it is the whole "device pairing by link/QR" line item in
   PLAN.md §2.
4. **Do not build mDNS discovery** (§3.3). A browser cannot do it, and the only client that could —
   the Capacitor shell — can read the same QR the browser reads.
5. **Make the server refuse to emit a credential over plain HTTP to a non-loopback peer** (§10.5),
   behind an explicit `--insecure-lan` opt-out. TLS stays out of the server; Tailscale is the
   recommended answer and it is the only one that also unblocks passkeys (§9.4) and secure-context
   browser APIs (§10.1).
6. **If multi-graph ever happens: one SQLite file per graph, one server process per graph** (§6.2).
   The `graph_id` columns should be documented as vestigial rather than relied on.
7. **If multi-user ever happens: bearer tokens plus a thin session table, and be an OIDC *client*,
   never an OIDC *provider*** (§9.6). MCP's authorization is OPTIONAL and says so normatively; the
   only reason to run an authorization server would be someone else's requirement, not MCP's.

---

## 3. "Which server?" — the address problem

### 3.1 The web client does not have this problem; nothing else escapes it

The browser client is served **by** the server (`http/web-client.ts`), so its origin is implicit and
`apiBaseUrl()` returns `""` — "same origin, which is the case whenever the server serves the client
— and it is why nothing needs configuring in that setup" (`bootstrap.ts:118`).

Every other shape has to be told:

- **The Capacitor shell** (ADR 005, `apps/web/capacitor.config.ts`) runs the *same build* from
  `capacitor://localhost` (iOS) or `https://localhost` (Android). Its origin is the app, not the
  server. It has no server at all until someone types one.
- **A Tauri desktop bundle** (research/10) runs the client from `tauri://localhost` against a
  sidecar — which is loopback, so it is fine, but only because the sidecar is local.
- **`nooklet mcp --stdio`** already solves this with `NOOKLET_URL` in the environment
  (`mcp/stdio.ts`), which is the right answer for a machine-configured client.

So "which server?" is a *mobile app* question, and today it has no answer at all: nothing in
`apps/web/src` reads a server URL from anywhere except `import.meta.env.VITE_API_BASE_URL`.

### 3.2 Manual URL entry — keep it, make it forgiving

This is the floor, and it must exist because every other mechanism fails somewhere. Two details
worth getting right, both of which the current ConnectView already half-implements:

- **Probe before accepting.** `GET <url>/healthz` returns `{"name":"nooklet","status":"ok"}` with no
  auth and is exactly the right liveness probe; ConnectView currently probes with an authenticated
  `graph.overview` call, which conflates "wrong address" with "bad token". Splitting them gives two
  distinct, honest error messages.
- **Default the scheme and port.** `my-mac.tailnet.ts.net` should become
  `https://my-mac.tailnet.ts.net`, `192.168.1.5` should become `http://192.168.1.5:6100`.

### 3.3 mDNS / DNS-SD — not worth it

A LAN advertisement (`_nooklet._tcp.local`) is the obvious "just find it" answer and it is a trap
here for one decisive reason: **a web page cannot do DNS-SD**. There is no browser API for it; the
W3C Network Service Discovery API was abandoned. So mDNS would serve exactly one client — the
Capacitor shell — which is precisely the client that can also point a camera at a QR code.

Details that inform the trade-off, and the precedents the brief asked about, are in §4's table;
what matters for the decision:

- The advertisement is visible to **everyone on the LAN**, and mDNS has no authentication, so an
  attacker on the same network can answer first and impersonate the service. Discovery must
  therefore never be the thing that establishes trust — it can only save typing, after which the
  pairing exchange (§5) has to stand on its own anyway.
- Every product that does this treats discovery as a convenience over a separate authorization step:
  Home Assistant advertises `_home-assistant._tcp.local.`
  ([`homeassistant/components/zeroconf/const.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/zeroconf/const.py),
  `ZEROCONF_TYPE = "_home-assistant._tcp.local."`), and still makes you log in. Jellyfin broadcasts
  on UDP 7359 ([jellyfin.org/docs/general/networking](https://jellyfin.org/docs/general/networking/),
  which also notes "Automatic discovery only works locally and should not be exposed externally"),
  and still makes you authenticate. Syncthing's local discovery broadcasts to `255.255.255.255:21027`
  ([docs.syncthing.net/specs/localdisco-v4.html](https://docs.syncthing.net/specs/localdisco-v4.html))
  and still requires both sides to hold each other's device ID.

**Verdict: skip.** If it is ever built, it belongs in the Capacitor shell as a "found nooklet on
`192.168.1.5`" hint above the URL field, never as an implicit trust decision.

### 3.4 QR — the right mechanism, on the server's screen

A QR code shown by the *server* and read by the *phone* is the correct direction of travel, because
the server has a screen the user is already looking at (the terminal they typed `nooklet serve`
into, or the desktop shell) and the phone has a camera. It solves the address problem and the
credential problem in one scan.

What goes in it is §3.6. What reads it: `navigator.mediaDevices` + the `BarcodeDetector` API in the
browser (Chrome/Android; not Safari), or Capacitor's camera plugin natively. Since the browser
support is partial, the QR must always encode something a human can also type — which is exactly
what a pairing code gives you (§5).

### 3.5 Deep links (`nooklet://pair?…`) — the plumbing exists, the consumer does not

`apps/web/src/platform/types.ts` declares `DeepLinkAdapter.onOpen` for `nooklet://...` opens and
`platform/capacitor.ts:151` implements it (with `App.addListener("appUrlOpen")`, cold-start
`getLaunchUrl()`, and a 500 ms dedupe because "appUrlOpen can fire twice for one intent"). **Nothing
subscribes to it** — `grep -rn "deepLink\|onOpen" apps/web/src` outside `platform/` returns only the
unrelated sync-transport `onOpen`.

Whether to use it for pairing: **yes for the address, no for the secret.** A custom scheme is not
registered exclusively on Android (any app may claim `nooklet://`), and the URL passes through the
OS, launcher logs, and any interceptor. `nooklet://pair?url=https://host:6100` is a fine convenience;
`nooklet://pair?token=nk_…` is not.

### 3.6 Is a bearer token in a QR code acceptable?

**Yes, under two conditions, and there is strong precedent both ways.**

The precedent *for* is that the entire world already does this for TOTP enrollment. The
`otpauth://` key URI format
([google/google-authenticator wiki](https://github.com/google/google-authenticator/wiki/Key-Uri-Format))
puts the raw shared HMAC secret, base32-encoded, directly in the QR:
`otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example`. RFC 6238 requires
that shared secret to exist ("The prover and verifier MUST either share the same secret or the
knowledge of a secret transformation to generate a shared secret",
[RFC 6238 §5 R2](https://www.rfc-editor.org/rfc/rfc6238)). Matrix goes further: its device-verification
QR payload contains a literal shared secret — the spec says "as we do not share the length of the
secret, and it is not a fixed size, clients will just use the remainder of binary segment as the
shared secret"
([matrix-spec, end_to_end_encryption module](https://github.com/matrix-org/matrix-spec)). A
security-conscious E2EE product puts a secret in a pairing QR on purpose.

The conditions:

1. **The QR must carry a short-lived, single-use pairing code, not a long-lived bearer token.** The
   TOTP analogy is imperfect precisely here: a TOTP secret is scanned once, at enrollment, in front
   of the user, and the QR is destroyed with the page. A nooklet device token lives forever (§1.2).
   A code that dies in five minutes and works once has a blast radius measured in minutes; a
   `write` + `can_sync` token photographed over someone's shoulder does not.
2. **It must be displayed by the server on a screen the owner controls,** not transmitted. A QR
   emailed, screenshotted into a chat, or pasted into a ticket is a credential in a log. The display
   surface is `nooklet pair` in the owner's own terminal, or a settings page on a loopback browser.

I could not find a citable OWASP/CISA/NIST statement either endorsing or condemning QR-delivered
credentials in general — see §14.

---

## 4. How other systems actually pair a device

Six systems, all verified against primary documentation, arranged by what they make the *user* do.

| System | What identifies a device | What the user does | Approval | Secret in a QR? |
|---|---|---|---|---|
| **Syncthing** | SHA-256 of the node's own TLS certificate (DER), base32, 52 chars with Luhn check digits | Exchanges the full device ID string, both directions | Mutual — both sides must hold the other's ID | No; the ID is public, not a secret |
| **Tailscale** | Node key, issued by the coordination server | `tailscale up` → browser login, or `--authkey` | Optional tailnet-wide device approval | No (`login --qr` encodes a login *URL*) |
| **Home Assistant** | OAuth2/IndieAuth client + refresh token, or a 10-year long-lived token | Types a URL (or picks a discovered one), then logs in | Account login is the gate | No |
| **Jellyfin Quick Connect** | Server-issued access token | Reads a **6-character code** off the new device, types it into an already-authenticated session | An authenticated device approves | No |
| **Plex** | Claim token → server token | Fetches a claim token from `plex.tv/claim`, pastes it into the server | Account ownership | No |
| **Matrix/Element** | Cross-signing keys | Scans a QR **or** compares emoji | Mutual, on both devices | **Yes — a shared secret** |
| **Obsidian Sync** | Account session + per-vault E2EE passphrase | Logs in, then enters the vault password | Account login + a second secret the operator never sees | No |

The details worth stealing:

**Syncthing** ([docs.syncthing.net/dev/device-ids.html](https://docs.syncthing.net/dev/device-ids.html))
makes identity *a property of a key you already have*: "the device ID is a direct property of the
public key in use." Nothing is issued; nothing can be stolen and replayed, because holding the ID
proves nothing — you must hold the private key. Getting Started
([docs.syncthing.net/intro/getting-started.html](https://docs.syncthing.net/intro/getting-started.html))
is explicit that both sides must act: "Two devices will *only* connect and talk to each other if they
are both configured with each other's device ID." That is the strongest model here and the most
expensive: it means mutual TLS, which nooklet does not have and would need TLS first (§10).

**Tailscale auth keys** ([tailscale.com/kb/1085/auth-keys](https://tailscale.com/kb/1085/auth-keys))
are the closest thing to nooklet's current tokens, and Tailscale's own documentation is blunt about
the failure mode: "**Be very careful with reusable keys! These can be very dangerous if stolen.**
They're best kept in a key vault product specially designed for the purpose." They bound the damage
three ways nooklet does not: one-off keys "can only be used to connect a device or server one time";
expiry is capped — "You can choose the number of days, **between 1 and 90 inclusive**, for the key
expiry"; and tailnet admins can require
[device approval](https://tailscale.com/kb/1099/device-approval), where a pending device "cannot send
or receive traffic … until it is approved." **Single-use, bounded expiry, and a separate approval
step are the three things nooklet's tokens are missing, and all three are cheap.**

**Jellyfin Quick Connect**
([jellyfin.org/docs/general/server/quick-connect](https://jellyfin.org/docs/general/server/quick-connect/))
is the UX to copy, because it is the one designed for a device with an awkward keyboard: the new
device displays a six-character code, an already-authenticated device enters it, and "If successful,
Device A will be logged in automatically—no need to enter a username or password." Note the
direction: the *new* device shows the code and the *trusted* device approves. That is the
approve-on-an-existing-device pattern, and it is strictly better than the reverse when the trusted
device is the one with the good input method — which, for nooklet, it is (the server's own terminal).

**Home Assistant** ([developers.home-assistant.io/docs/auth_api](https://developers.home-assistant.io/docs/auth_api/))
is the counter-example on effort: "we have adopted the OAuth 2 specification combined with the OAuth
2 IndieAuth extension for generating clients", with authorization-code exchange, refresh tokens, and
`/auth/revoke`. It also offers 10-year long-lived tokens for the integration case — i.e. the same
two-surface problem nooklet has (§9), solved by shipping both. Its companion-app rule is worth
copying verbatim: "**The Companion App requires an encrypted connection for remote connections**"
([companion.home-assistant.io FAQ](https://companion.home-assistant.io/docs/troubleshooting/faqs/)) —
local HTTP is allowed, remote must be HTTPS. §10.5 recommends exactly this shape.

**Obsidian Sync**
([Security and privacy](https://obsidian.md/help/Obsidian+Sync/Security+and+privacy),
[Set up](https://obsidian.md/help/Obsidian+Sync/Set+up+Obsidian+Sync)) splits the credential in two:
an account login that identifies you to the service, and a separate per-vault encryption passphrase
(scrypt + AES-256-GCM) that the operator never holds — "We can't read your data." Not applicable to
nooklet, which rejected E2EE in PLAN.md §2 because it would block server-side embeddings, but worth
naming as the reason nooklet's server *is* in the trust boundary and its pairing exchange therefore
only has to protect a token, not a data key.

**RFC 8628, the OAuth 2.0 Device Authorization Grant**
([datatracker.ietf.org/doc/html/rfc8628](https://datatracker.ietf.org/doc/html/rfc8628)) is the
standards-track version of all of this and supplies the numbers §5 needs:

- §3.2: `expires_in` is "REQUIRED. The lifetime in seconds of the 'device_code' and 'user_code'." The
  RFC's own example value is **1800** (30 minutes) — an example, not a mandate.
- §5.1, *User Code Brute Forcing*, is the load-bearing paragraph: "it is recommended that the server
  rate-limit user code attempts. The user code SHOULD have enough entropy that, when combined with
  rate-limiting and other mitigations, a brute-force attack becomes infeasible… If, for instance,
  one uses an 8-character base 20 user code (with roughly **34.5 bits of entropy**), the
  rate-limiting interval and validity period would need to only allow **5 attempts** in order to get
  the same **2⁻³²** probability of success by random guessing."
- §5.2, *Device Code Brute Forcing*: "As the device code is not displayed to the user and thus there
  are no usability considerations on the length, a very high entropy code SHOULD be used."
- §6.1 recommends "case-insensitive A-Z characters, with no digits", and gives the base-20 alphabet
  `BCDFGHJKLMNPQRSTVWXZ` — vowels removed (no accidental words), and visually confusable characters
  (`0`/`O`, `1`/`I`) gone.
- §3.5's `slow_down`: "the interval MUST be increased by 5 seconds for this and all subsequent
  requests."

§5 takes RFC 8628's *numbers* and Jellyfin's *direction*, and does not take RFC 8628's OAuth
machinery, which would drag in an authorization server for no benefit (§9).

---

## 5. A pairing design for nooklet

### 5.1 The flow

On the machine running the server, the owner runs one command (or clicks one button in a loopback
browser tab):

```
$ nooklet pair --label phone
Pairing code:  KRFT-WNPD              expires in 5:00, one device only

  ▄▄▄▄▄▄▄  ▄ ▄▄ ▄  ▄▄▄▄▄▄▄        or open   http://192.168.1.5:6100/pair
  █ ▄▄▄ █ ▀█▄█▀▀▀▀ █ ▄▄▄ █        and type the code
  …
Waiting…
```

On the phone, the person opens the server's URL (typed, scanned, or deep-linked), sees "Enter your
pairing code", types eight letters, and is in. The server prints
`paired: phone (device 3f1a9c72) — token issued` and exits.

Everything the phone needs — address and credential — is in the QR; everything the QR has can also
be typed. That is the whole design goal.

### 5.2 The exchange

Two endpoints, neither behind `bearerAuth`, both behind the peer checks of §10.5.

```
POST /pair/claim      { code: "KRFTWNPD", device_name?: "Pixel 9" }
  200 { token: "nk_…", graph: { name, id }, server_time }
  400 invalid    — wrong, expired, or already-claimed code (one message for all three)
  429 rate_limited  — Retry-After

GET  /pair/status?id=<pairing_id>     (owner-side, loopback only: what `nooklet pair` polls)
  200 { state: "pending" | "claimed" | "expired", device?: {...} }
```

`nooklet pair` creates the row, prints the code, polls `/pair/status`, and exits on `claimed` or
`expired`. The web client's `/pair` route is a code field; on success it calls `setStoredToken` and
reloads, exactly as `ConnectView` does today — so `bootstrap.ts` and the sync client are untouched.

One new table, additive, no migration risk:

```sql
CREATE TABLE pairing (
  id           TEXT PRIMARY KEY,          -- 14-char id, as everywhere else
  graph_id     TEXT NOT NULL DEFAULT 'default',
  code_hash    TEXT NOT NULL UNIQUE,      -- sha256 of the normalized code; never the code
  label        TEXT NOT NULL,             -- becomes the token label and the device name
  scope        TEXT NOT NULL DEFAULT 'write',
  can_sync     INTEGER NOT NULL DEFAULT 1,
  ui_control   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  claimed_at   INTEGER,
  token_id     TEXT REFERENCES token(id)  -- set on claim, so revoking the pairing revokes the token
);
```

Storing `sha256(code)` rather than the code costs nothing and means a stolen database backup taken
during the five-minute window still does not yield a live code. The normalization before hashing is
uppercase, strip non-alphabet characters — so `krft-wnpd`, `KRFT WNPD` and `KRFTWNPD` are one code.

### 5.3 Expiry, single use, rate limiting — with the numbers

Taking RFC 8628 §5.1's worked example directly, because it is the right shape and someone already
did the arithmetic:

- **Alphabet**: base-20, `BCDFGHJKLMNPQRSTVWXZ` (RFC 8628 §6.1). No digits, no vowels, no `0`/`O`/
  `1`/`I`.
- **Length**: 8 characters → **34.5 bits**. Displayed `KRFT-WNPD`; the hyphen is cosmetic.
- **Lifetime**: **5 minutes**, not RFC 8628's 30. The user is standing next to the machine; 30
  minutes is for a TV in a hotel lobby. Shorter is strictly better here and costs nothing.
- **Single use**: `claimed_at IS NULL` is checked and set in the same SQLite transaction as the
  token insert. A code that was claimed is dead even if the claiming device's response was lost —
  the owner runs `nooklet pair` again, which is a two-second cost for a real invariant.
- **Attempts**: **5 per pairing row**, then the row is marked expired. Plus a per-peer bucket (5
  wrong codes from one IP in 5 minutes → 429), because otherwise an attacker just creates load until
  the owner generates a new code.

At 34.5 bits, 5 attempts and a 5-minute window, an attacker's chance is 5/2³⁴·⁵ ≈ **2⁻³²** — RFC
8628's own target — and they get one shot per code the owner chooses to create. If that feels
generous, a 10-character code is 43 bits for two more keystrokes.

Deliberately **not** doing RFC 8628's polling `device_code`: the device does not poll, it submits a
code the human typed. There is no second secret to brute-force (§5.2 of the RFC), because the flow
has one round trip, not two.

### 5.4 What stops an attacker on the same LAN

Honestly and in order:

1. **The window.** Five minutes, once, when the owner chose to open it. Compare with today, where a
   `write` token is sitting in `localStorage` on every paired device forever and, per §1.6(a), is
   available on request to anyone on the network.
2. **The entropy plus rate limit**, at RFC 8628's 2⁻³² target (§5.3).
3. **The code never crosses the network in the direction an attacker can watch.** It goes
   screen → eyes → phone keyboard. On plain HTTP the *claim* does cross the wire, and a passive
   sniffer on the same LAN sees both the code and the issued token. **This is the case §10.5's rule
   exists for**: on a non-loopback peer without TLS, `/pair/claim` should refuse unless
   `--insecure-lan` was passed.
4. **Nothing stops an active attacker on a plain-HTTP LAN.** Say so plainly. They can ARP-spoof,
   intercept the claim, and take the token. Pairing is not a substitute for transport security; it
   bounds the window during which transport security matters.

What pairing also buys, which paste-a-token does not: the issued token is **bound to the device that
claimed it**. `token` gains `device_id` and `expires_at` (§12), `sync/push.ts` checks that the
pushed `device_id` matches the token's, and the §1.5 problem — one token, unlimited device rows —
goes away for paired devices.

### 5.5 Approve-on-an-existing-device: worth it later, not now

Jellyfin's model (new device shows the code, trusted device approves) is better than nooklet's
inverse (server shows the code, new device enters it) in exactly one situation: when the person
holding the new device is not the person with access to the server. For a single user that never
happens. When it does — §6's multi-user world — the same `pairing` table serves it by flipping which
side generates: the phone `POST /pair/request` → gets a code → an authenticated session approves it.
That is a ~40-line addition to the design above, and it is the reason to build the table rather than
a bare in-memory map.

---

## 6. Multi-user and multi-graph: the data model

### 6.1 The `graph_id` columns are a decoy, and should be labelled as one

`docs/spec/00-conventions.md` promises "one graph per server in v1; every table still carries
`graph_id` so this can change without migration." As of today that promise does not hold, for five
independent reasons:

1. **Nothing filters on it.** ~240 SQL statements in `packages/server/src` (non-test) and 39 in
   `packages/core/src`; `data-api.ts`'s 816 lines contain **zero** occurrences of `graph_id`.
   Adding multi-graph means auditing every one of them, and the failure mode of a missed predicate
   is silent cross-graph data disclosure — the worst possible class of bug to introduce by
   omission.
2. **The writers hardcode the literal.** `apply-ops.ts:323` and `asset-upload.ts:168`/`:177` write
   `'default'` inline in the SQL text. They would all have to be re-plumbed from `OpContext` anyway,
   at which point the column being pre-existing saved nothing.
3. **The derived tables deliberately do not have it.** Rule 2 exempts `ref`, `path_ref`,
   `page_alias`, the FTS5/trigram tables and `embed_dirty`, plus `embedding`/`embedding_vec_<n>`
   (which key off `page_id`/`block_id`). An FTS5 `MATCH` query cannot be graph-filtered without a
   join back to `block` — so the search path, the single most security-sensitive read in a
   multi-tenant system, gains a join that must never be forgotten.
4. **The in-process registries are keyed per driver, not per graph.** `sync/realtime.ts` uses
   `WeakMap<ServerContext, …>` and `live/registry.ts` uses `WeakMap<SqlDriver, …>`. Both files'
   headers say this is fine *because* there is one per process. Share one database across graphs and
   a poke or a `ui_run_command` crosses graphs.
5. **`ops/trial-lock.ts` exports one process-wide `writeLock`.** Every non-`readOnlyHint` op runs
   inside it (`registry.ts:364`). Two graphs in one process would serialize every write in graph A
   behind every write in graph B, including a 60-second import.

### 6.2 One SQLite file per graph — and the code is already shaped for it

The alternative is what the repository already does and does not know it is doing. `--data <dir>`
selects a directory containing `graph.sqlite`, `assets/`, `pages/`, `journals/`, `plugins/`,
`backups/` (OPERATIONS.md §2). `createServerContext(openDb({path: join(dir, "graph.sqlite")}))`
constructs one `ServerContext` per directory. `backup`, `restore`, `gc`, `verify`, `import`,
`export` and `embed` all already take `--data`.

So **a graph is a directory**, and multi-graph is a *routing* problem rather than a *query* problem.

| | One file per graph | One file, `graph_id` predicate |
|---|---|---|
| Query audit | none — the connection *is* the scope | every one of ~280 statements |
| Failure mode of a mistake | cannot happen | silent cross-graph read |
| FTS5 / sqlite-vec | works unchanged | needs a join on every search |
| `nooklet verify` | per graph, unchanged | must be taught to partition |
| `nooklet gc` | per graph — `MIN(device.acked_seq)` is naturally per graph | floor must be computed per graph or it trims another graph's log |
| `nooklet backup` | `VACUUM INTO` the whole file, unchanged | whole-file backup is now everyone's data |
| Blast radius of corruption | one graph | everything |
| Cross-graph query (`[[ref]]` across graphs) | impossible without ATTACH | trivial |
| Writer lock | independent per file | one global `writeLock` |
| Cost per idle graph | one file handle + WAL, or zero if lazily opened | zero |

The only column where the shared database wins is cross-graph queries, and nooklet does not have
that feature and is not going to (PLAN.md §3: "Small scope"). Every other row favours the file.

**Pick file-per-graph.** Two deployment shapes follow, and both are cheap:

- **One process per graph** (recommended, and what exists today): `nooklet serve --data ~/.nooklet/work
  --port 6101`. Zero code changes. A reverse proxy maps paths or subdomains to ports. `writeLock`,
  the WeakMaps, and the plugin host stay correctly scoped by construction.
- **One process, many graphs** (only if idle-graph cost ever matters): a `Map<graphId, ServerContext>`
  opened lazily, `OpContext` gains the `ServerContext` it needs, `writeLock` becomes per-driver, and
  the two WeakMaps already key correctly. That is a contained change to `http/app.ts`,
  `ops/registry.ts` and `ops/trial-lock.ts`, and it never touches a single SQL statement — which is
  the whole point.

The `graph_id` columns should stay (dropping them buys nothing) but `sql-schema.md` rule 2's
rationale should be rewritten to say what is true: they are inert, the multi-graph seam is the file,
and new tables need not bother.

### 6.3 The schema, if multi-user is ever built

In a **separate** `instance.sqlite` alongside the per-graph directories, never inside a graph — a
graph file must stay independently backupable, restorable and portable, which is the property
OPERATIONS.md §3 is built on.

```sql
CREATE TABLE user (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE,                 -- NULL for a service identity
  display_name  TEXT NOT NULL,
  password_hash TEXT,                        -- argon2id; NULL if OIDC-only (§9)
  created_at    INTEGER NOT NULL,
  disabled_at   INTEGER
);

CREATE TABLE graph (
  id         TEXT PRIMARY KEY,               -- "default" for the existing install
  name       TEXT NOT NULL,
  data_dir   TEXT NOT NULL UNIQUE,           -- the directory; this is the real scope
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE graph_member (
  graph_id  TEXT NOT NULL REFERENCES graph(id),
  user_id   TEXT NOT NULL REFERENCES user(id),
  role      TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  invited_by TEXT REFERENCES user(id),
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (graph_id, user_id)
) WITHOUT ROWID;
```

And `token` — which stays **in the graph database**, because a token is only ever valid for one
graph and keeping it there means revoking a graph by deleting its directory actually revokes its
credentials — gains:

```sql
ALTER TABLE token ADD COLUMN user_id    TEXT;     -- NULL = the legacy single-user token
ALTER TABLE token ADD COLUMN device_id  TEXT;     -- bound at pairing (§5.4)
ALTER TABLE token ADD COLUMN expires_at INTEGER;  -- NULL = never, as today
```

`token.graph_id` already exists and finally becomes meaningful: it is a *consistency assertion*
against the file the token was found in, not a query predicate.

### 6.4 Backup, GC and `verify`, per graph

All three stay exactly as they are, which is the strongest practical argument for §6.2:

- **`nooklet backup`** does `VACUUM INTO` plus `assets/` into one `.tar.gz` (`backup/index.ts`).
  Per-directory, so per-graph, so a graph is restorable without touching anyone else's data.
- **`nooklet gc`** computes `MIN(device.acked_seq)` over live devices in *that file*
  (`gc.ts#computeGcFloor`) and refuses if any live device is at 0. Per graph, correct by
  construction. Under a shared database it would have to partition the floor computation **and** the
  `DELETE FROM op`, and getting that wrong deletes another graph's history.
- **`nooklet verify`** replays the op log into a scratch database and diffs `page`/`block`/
  `block_prop`/`page_prop` (`verify.ts`). It reads the whole tables. Under a shared database it
  would silently report every other graph's rows as divergence.

`instance.sqlite` needs its own tiny backup, but it holds users and memberships — kilobytes — and
losing it costs an invite round, not data.

---

## 7. Authorization

### 7.1 Roles and scope tiers are different axes; intersect them, do not merge them

A per-graph role answers "what is this human allowed to do in this graph". A token scope answers
"how much of what its owner can do did they delegate to this key". Collapsing them loses the second
question, which is the one that matters for agents.

```
effective(token) = scopesFor(min(token.scope, roleCeiling(member.role)))
                   ∪ (token.ui_control ? {"ui:control"} : {})
```

with `roleCeiling: owner → admin, editor → write, viewer → read`. A `viewer` cannot mint a `write`
token; an `owner` can mint a `read` token for an agent they do not fully trust. The single check in
`registry.ts:436` — `current.scopes.every(s => ctx.scopes.includes(s))` — is unchanged, because only
the construction of `ctx.scopes` moves.

`owner` needs one thing no tier expresses: membership management. Rather than a fourth tier, the
three `admin.*` ops that already exist with `expose.mcp: false` (mcp-tools.md §4's note on
`admin.tokens.*`) grow siblings `graph.member.*` that additionally assert `role === 'owner'` inside
the handler. That keeps `Scope` a three-valued tier, which is what everything else in the codebase
assumes.

### 7.2 `ui:control` stays exactly where it is

ADR 015 §7's argument — "a broad `write` token for headless data cleanup should not thereby be able
to drive someone's screen" — is orthogonal to roles and survives multi-user untouched. One addition:
`ui_run_command` acts on a *window*, and a window belongs to a person, not to a graph. With members,
`ui:control` must also require that the token's `user_id` matches the window's — otherwise an editor
can drive the owner's screen. `live/registry.ts`'s `HelloInfo` already carries `deviceId`, so this is
one extra field on the hello and one comparison in `live/window-resolution.ts`.

### 7.3 An agent token is scoped to one graph by being in that graph's file

This is the payoff of §6.2. Under file-per-graph, "scope this agent token to one graph" needs no
code: `nooklet token create --data ~/.nooklet/work` produces a token that literally does not exist
in any other graph's `token` table, and `verifyToken` against another graph's driver returns null.
Under a shared database it would be a `graph_id` predicate on `verifyToken` plus a matching
predicate on every op — i.e. the §6.1 audit again.

### 7.4 What breaks in `defineOp` if ops must be graph-scoped

Concretely, in order of how much they hurt:

1. **`OpContext` has no graph.** `buildOpContext(serverCtx, config, auth, transportMeta)`
   (`registry.ts:268`) closes over exactly one `ServerContext`, and `ctx.db`/`ctx.data`/
   `ctx.applyOps`/`ctx.mintOp` are all bound to it. Graph selection must therefore happen *before*
   `buildOpContext`, in the two mount points that call it: `http/app.ts:132`'s `mountHttp` callback
   and `mcp/server.ts`'s `createMcpServer` factory. That is the right place — it is where the token
   is already verified.
2. **`ctx.mintOp` uses one HLC.** `serverCtx.hlc` is `new Hlc(SERVER_DEVICE_ID)` per context
   (`apply-ops.ts:40`). Two graphs sharing a process must not share a clock instance, or server-
   authored ops in graph A advance graph B's logical time. Per-`ServerContext` already gives this;
   a shared-database design would have to invent it.
3. **`ops/trial-lock.ts`'s module-level `writeLock`** (§6.1 item 5). Must become
   per-`ServerContext`, e.g. a `WeakMap<SqlDriver, AsyncMutex>` like `live/registry.ts` already uses.
   ~10 lines, but forgetting it is a correctness bug (a savepoint held open on connection A while
   connection B commits) *and* a latency bug.
4. **`OpRegistry` is process-global and that is fine.** Op *definitions* are graph-independent.
   The one wrinkle is M4 plugins: `plugins/ops-bridge.ts` registers a plugin's ops into the shared
   registry, and plugins are installed **per data directory** (`<data>/plugins/`). Two graphs with
   different plugin sets would collide on `register()`'s "already registered" throw
   (`registry.ts:327`). Under one-process-per-graph this cannot arise; under one-process-many-graphs
   the registry must become per-graph for plugin ops, or plugin op names must be graph-qualified.
5. **`buildOpenApi(registry)`** emits one document. With per-graph plugin ops it would need to be
   per graph, or to emit core ops only.
6. **The MCP mount's `tools/list` filter** (`mcp/server.ts`, "unauthorized scopes are never even
   listed") already filters by `authInfo.scopes`. Once scopes are derived per graph (§7.1) this
   keeps working with no change — a pleasant consequence of ADR 015 having modelled `ui:control` as
   a `Permission` rather than a side-channel.

Nothing here touches an individual op handler, which is the test of whether the seam is in the right
place. It is.

---

## 8. Sharing and revocation

### 8.1 Inviting someone to a graph

With §6.3's tables, an invite is a `pairing` row with a `user_id` instead of a `device_id`: the
owner creates it, the invitee redeems a code or a link, and the redemption creates the `user` row (or
links an existing one) plus the `graph_member` row. The same expiry, single-use and attempt limits
from §5.3 apply unchanged, which is the second reason (§5.5 was the first) to build `pairing` as a
table.

The thing to design deliberately is what an invite **cannot** do: it must not be able to grant a role
above the inviter's own, and `owner` must not be grantable by invite at all — transferring ownership
should be an explicit, separate, confirmed action.

### 8.2 Revoking a device or a member

Device revocation exists and works: `nooklet token revoke <id>` sets `revoked_at`, `verifyToken`
returns null on the next request, and `gc.ts#computeGcFloor` stops counting that device's
`acked_seq` in the floor — OPERATIONS.md §6 already documents this second effect, which is the
non-obvious one.

Two gaps, both closed by §5.4's device binding:

- Today a revoked token's `device` row survives with its `token_id` pointing at the revoked token.
  That is correct for GC but means `nooklet token list` and any future device list disagree about
  what a "device" is. With `token.device_id`, a device is a token, and the two lists are one list.
- Today revoking a token does not disconnect an *open* WebSocket. `sync/live.ts` verifies the token
  once, in the `hello` handler, and never again; `live/live.ts` does the same. A revoked device keeps
  receiving pokes (harmless — pokes carry no data) but also keeps its `/ui/live` window registered,
  which under ADR 015 is a live control channel. **Revocation should close matching sockets**: the
  registries are in-memory and keyed by device/window, so this is a lookup and a `ws.close(4403)`.

Member revocation is a `DELETE FROM graph_member` plus revoking every token in that graph with the
matching `user_id` — which is one `UPDATE … SET revoked_at` because the tokens live in that graph's
file (§6.3).

### 8.3 What revocation cannot do: the data is already there

**You cannot recall data that has already synced.** This needs saying in the product, not just in a
design document.

A nooklet client holds a full replica: `page`, `block`, `block_prop`, `page_prop`, `op`, `setting`,
`keybinding`, `plugin` (sql-schema.md rule 1) in SQLite-WASM/OPFS, plus cached assets. By the time
you revoke a device it has everything, on disk, in a file format the user can open. Revocation stops
**future** sync and **future** API access. It does not:

- delete the local replica (the server has no remote-wipe channel, and adding one to an offline-first
  client is a promise that cannot be kept — a device that never comes back online never wipes);
- invalidate what was read (a `read` token that pulled `/sync/snapshot` once already has the graph);
- help with assets (`/assets/:id` is unauthenticated, §1.2 — anyone who ever learned an id keeps
  access until that changes).

So the honest guidance, which the revocation UI should print: *revoking a device stops it receiving
new changes and making new ones. Everything it already synced is on that device and stays there. If
the device is lost and the data is sensitive, rotate what is in the data — passwords, keys — not
just the token.* Syncthing, Tailscale and Obsidian are all in exactly the same position and none of
them pretends otherwise.
