---
title: Security model
description: What nooklet protects against, how tokens and scopes work, what the server trusts, and the recommended deployment.
order: 8
---

# Security model

nooklet holds one person's notes. It runs on hardware you control and has no accounts, no cloud
and no telemetry. This page describes what protects those notes and where the limits are. To report
a vulnerability, see [Reporting a vulnerability](#reporting-a-vulnerability).

## Threat model

nooklet tries to stop:

- **Other people on your network or the internet** reading or changing your graph. Every API, sync
  and MCP request needs a bearer token.
- **Websites in your browser** reaching a server on `localhost`. The server checks the `Host`
  header (a DNS-rebinding guard) and allows cross-origin requests from one origin only: its own iOS
  app shell.
- **A lost or retired device or agent** keeping access. You revoke its token.
- **An agent doing more than you allowed.** Tokens carry a scope, and driving a live window is a
  separate permission.
- **Losing data to a bad write.** Deletes go to a trash with no expiry, every write is in an audit
  log, and agent batches can be undone.

nooklet does not try to stop:

- **Someone with access to the server's disk or the device.** The database and markdown mirror are
  plain files. Use disk encryption.
- **A compromised server.** The server sees all content; there is no end-to-end encryption.
  Server-side search, embeddings and MCP need the plain text.
- **Malicious plugins.** Plugins are trusted code with full access to the server process.
- **Untrusted users of one graph.** nooklet has one owner. Anyone with a `write` token can change
  anything in that graph.

## Recommended deployment, and why

**Run the server on your tailnet only, with HTTPS from Tailscale, and give every device and agent
its own token.** Add `--no-loopback-token` whenever the server sits behind a proxy or in a
container. [Self-hosting](self-hosting.md) has the steps.

This setup puts two independent walls in front of your notes. A stranger first has to join your
tailnet, which needs your identity provider and your approval. Then they need a valid token for the
graph. One wall failing (a leaked token, a misconfigured tailnet ACL) still leaves the other.

It also gives you HTTPS with a real certificate for free, through MagicDNS. HTTPS is not optional
for nooklet: browsers only grant the web client the APIs it needs (`crypto.randomUUID`, Web Locks,
OPFS) in a secure context. And nothing listens on the internet, so scanners and password-spray
traffic never reach the server.

| Tier | Setup | Status |
|---|---|---|
| 1 | Tailnet only + HTTPS + a token per device | **Recommended default** |
| 2 | Public behind a TLS reverse proxy | Possible; follow the [checklist](self-hosting.md#tier-2-public-behind-a-tls-reverse-proxy). No dedicated security review yet. |
| 3 | Plain `http://` beyond localhost | Unsupported. The browser client refuses to start without a secure context. |

> **Security review of tier 2 (2026-10-04).** Verdict: public exposure behind a TLS proxy is
> reasonable for a single owner who follows the checklist in
> [self-hosting](self-hosting.md). It is not yet suitable for multiple users. Tailnet-only stays
> the default.
>
> Already in place:
> - **Deny by default.** Every request needs a valid token unless the route is on an explicit
>   public list. `docs/spec/security-inventory.md` has the list, and a test probes every
>   registered route to enforce it.
> - **Tokens.** Tokens are 192 random bits and stored only as SHA-256. The root token is compared
>   in constant time. Revocation applies to the next HTTP request.
> - **Headers.** Responses carry security headers, and the app page carries a hash-based script
>   CSP. HSTS is sent behind TLS.
> - **Request size.** Request bodies are capped.
> - **Local token.** The automatic local token is off on a non-loopback bind.
> - **No script from notes found.** The review found no way for a note's content to run script:
>   links are scheme-checked, markdown has no raw HTML, KaTeX runs untrusted and mermaid strict.
>
> Since then (QR pairing, 2026-10-04): revoking a token closes the WebSockets it has open, the
> one endpoint that takes no token (redeeming a pairing code) is rate-limited, and the `admin`
> scope gates device management. The sync and live-UI WebSockets close a connection that has
> not authenticated within 10 seconds, cap connections at 20 per token and 500 in total
> (`--ws-max-per-token`, `--ws-max-total`), and refuse messages over 512 KiB.
>
> Known gaps:
> - **Little rate limiting inside nooklet.** Only pairing-code redemption is limited. Limit
>   everything else at the proxy.
> - **WebSockets, per client IP.** nooklet caps sockets per token and in total, so one client
>   without a token can still hold up to 500 open for 10 seconds at a time and fill the total.
>   Limit connections per IP at the proxy.
> - **Attachments.** `/assets/<id>` needs no token, only the asset's own secret key in the URL
>   (`?k=`). A device whose token you revoke keeps the URLs it has seen, and any link someone
>   shared keeps working, until you run `nooklet asset rotate-key --all` (or `<asset-id>`).
>   Have the proxy leave query strings out of its access log, or the keys are in it.
> - **Public without a token.** Health checks, the op list (`/openapi.json`) and which graph ids
>   exist.

## Tokens and scopes

| Credential | Created by | Grants |
|---|---|---|
| Device or agent token (`nk_…`) | `nooklet token create`, or pairing a device (below) | Access to **one graph**, at its scope and capabilities |
| Web-client token | The server, for a browser on the same machine (below) | `admin` + sync on that graph |
| Pairing code (`nkp_…`) | Settings → Devices → Add a device, or `nooklet pair` | Nothing by itself. Traded once, within 10 minutes, for a new device token (`write` + sync by default, never `admin`) |
| Root token (`nkroot_…`) | Minted on first `serve`, kept in `<data>/root.token` (mode 0600) | `GET /graphs`, `POST /graphs` and `DELETE /graphs/<id>` only: list graphs, create a graph, retire a graph (moved aside, not deleted). No access to graph content by itself. |

A token belongs to one graph: it lives in that graph's own database and cannot verify against
another graph.

Scopes and capabilities:

- `--scope read` (the default): read, search, list. No writes.
- `--scope write`: everything `read` can, plus writes, refactors, trash and undo.
- `--scope admin`: everything `write` can, plus managing devices: listing tokens, revoking them,
  and creating pairing codes. The desktop app (and any browser on the server's own machine) gets
  an `admin` token automatically; a paired phone never does, so a lost phone cannot lock out your
  other devices or mint itself new access.
- `--sync`: may use `/sync/*` (push, pull, snapshot, the live socket). Devices need it; agents do
  not.
- `--ui-control`: may see and drive a live window through the `ui_*` tools. Separate from the scope,
  so a `write` token for data work cannot drive your screen, and a `read` token with
  `--ui-control` can watch and point but not edit. Each window also has its own toggles: "let
  agents view this window" (on by default) and "let agents control this window" (off by default),
  with a badge showing when an agent is watching or in control.

The server prints a token once and stores only its SHA-256 hash. The client keeps its token in the
browser's `localStorage` for that origin.

Revoking: Settings → Devices → Revoke (from an `admin` session), or `nooklet token list`, then
`nooklet token revoke <id>`. The device's next request is refused and its open sync connection is
closed. It shows "Token rejected" and keeps its unsent edits until you pair it again.

### Pairing a phone

Settings → Devices → Add a device (or `nooklet pair --link <address>` on a headless server) shows
a QR code. It holds `https://<server>/g/<graph>/pair#code=nkp_…`, a page with an "Open in the
nooklet app" button. The code:

- works **once**, and expires after **10 minutes**; making a new one cancels the old one;
- is stored only as a hash, and sits in the URL **fragment**, which browsers never send, so it is
  never in a server, proxy or tailnet log;
- is traded by the phone for its own token (`write` + sync), named after the device, through the
  only endpoint that needs no token. That endpoint answers the same way for an unknown, expired or
  used code and allows 10 attempts a minute per address.

The QR holds an https page rather than a `nooklet://` link because the iPhone Camera app is not
documented to open custom-scheme links; it always opens https.

`nooklet token create --link` still prints a `nooklet://connect?…&token=…` link, but that link
**is** the token, valid until revoked, wherever it travels (clipboard, chat, screenshots). Prefer
pairing codes.

The `page_delete` MCP tool is marked as requiring user interaction, so MCP clients that honour the
hint ask you first. Every agent write is recorded with the token's label and can be reversed with
`batch_undo`.

### The loopback auto-token

So that `nooklet serve` and the desktop app work with no setup, the server hands a `write` + sync
token to a browser on the same machine. It does so only when all of these hold:

- the server itself is bound to loopback (the default `--host 127.0.0.1`); on any other `--host` the
  auto-token is off unless you pass `--loopback-token`;
- the TCP peer address is loopback (`127.x` or `::1`), read from the socket, not from a header;
- the `Host` header names loopback (`localhost`, `127.0.0.1`, `::1`);
- the request carries none of `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`.

The reasoning: anything that can already open a page on the server's own machine as you can read
`graph.sqlite` directly, so the token adds nothing. The gap is a reverse proxy on the same machine
that rewrites `Host` to `127.0.0.1` and adds no forwarding header; every client of such a proxy looks
local. `nooklet serve --no-loopback-token` turns the auto-token off entirely, even on a loopback
bind. The container image sets it by default. Use it behind any proxy on the same machine.

The server mints one web-client token per process and retires the previous one at startup.

## Network checks

- **Bind address.** `127.0.0.1` by default. Listening anywhere else takes `--host`.
- **Host allowlist.** With a non-loopback bind, any request whose `Host` is not loopback or listed
  in `--allow-host` gets 403. `/mcp` checks the same list on any bind. This blocks DNS rebinding:
  a malicious site that points its own domain at your server's address still sends its own domain
  as `Host`.
- **CORS.** The server answers CORS only for the origin `capacitor://localhost`, the iOS app's
  page. A web page cannot forge its `Origin`, and the web and desktop clients are same-origin with
  the server. There is never a wildcard: a `*` would let any site in a browser on the server's
  machine read the loopback token from `/api/session`.
- **Secure context.** The web client checks for a secure context at startup and stops with an
  explanation on plain `http://` to another host.
- **TLS.** The server speaks plain HTTP. TLS comes from Tailscale or your proxy.
- **Rate limiting.** None in the server. Behind a public proxy, limit there.

## What is reachable without a token

- `GET /healthz`: `{"name":"nooklet","status":"ok"}`.
- The web client's static files, and `GET /g/<id>/openapi.json`.
- `GET /g/<id>/api/session`: returns a token only under the loopback rule above; otherwise
  `token: null` with a reason.
- `GET /g/<id>/assets/<id>.<ext>?k=<key>`: uploaded files. An `<img>` tag cannot send a bearer
  token, so an asset URL carries a secret of its own instead: every asset has a random 128-bit key,
  and the server answers only when `k` matches it. Without the key, or with a wrong one, the answer
  is 404, the same as for an id that does not exist. The id alone is not enough: ids are a
  millisecond timestamp plus 25 random bits, and ids made in the same millisecond (a bulk import)
  are consecutive.

  So an asset URL works like a capability link. Anyone who has the whole URL can fetch the file,
  without a token, until the key changes. The apps learn keys over the authenticated API
  (`asset.info`) and keep them on the device; block text stores only `assets/<id>.<ext>`, so the
  Markdown mirror and exported files never contain a key.

  - **Revoking.** `nooklet asset rotate-key <asset-id>` gives one asset a new key, and `--all`
    gives every asset one (for example after revoking a device token). Old URLs then answer 404.
    The apps fetch the new key the next time a picture fails to load. A device keeps any copy
    it has already cached.
  - **Logs.** The key is in the query string. nooklet keeps no access log. A reverse proxy in
    front of it should not log query strings for `/assets/`. `Referrer-Policy: no-referrer` keeps
    the key out of `Referer` headers.
  - **Caching.** Responses are `Cache-Control: private`, so no shared cache keeps a copy after a
    key changes. Devices cache by the full URL, key included.

  Assets are served with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`,
  so an uploaded HTML or SVG file opened in a tab cannot run script in the app's origin.

## What the server trusts

- **Pushed ops are checked, not trusted.** The server validates tree structure and rejects moves
  that would create cycles, and refuses pushes from a device clock more than 60 s ahead. It does
  not verify who typed what: any token with `write` + `--sync` can write anything in its graph.
- **Content is data.** The MCP server instructions tell agents that page content is the user's data
  and never instructions to follow. That is a hint to the agent, not a guarantee; an agent with a
  `write` token can still be talked into writing by text it reads. Give agents the least scope that
  works.
- **Rendered content** goes through nooklet's own tokenizer and renderer rather than a general
  HTML pipeline. Links with `javascript:` URLs render without an `href`, code highlighting and
  KaTeX output are escaped, and query fences have limits on nesting and size because any writer
  can author them. End-to-end tests cover these cases (`e2e/tests/untrusted-content.spec.ts`).
- **Plugins** in a graph's `plugins/` directory are trusted fully.

## Data at rest

- `graphs/<id>/graph.sqlite`: all content, the op log, the audit log, token hashes. Not encrypted.
- `graphs/<id>/pages/`, `journals/`: the markdown mirror, plain text.
- `graphs/<id>/assets/`: uploaded files.
- `root.token`: the root token in plain text, mode 0600.
- Backups (`.tar.gz`): everything above for one graph. Treat them as sensitive as the database.
- Devices: the browser's OPFS (or the app's storage) holds the replica; `localStorage` holds the
  token. Embeddings stay on the server.

Use full-disk encryption on the server and your devices.

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/hnykda/nooklet/security/advisories/new),
not in a public issue. [SECURITY.md](../../SECURITY.md) has the details.
