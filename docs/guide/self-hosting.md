---
title: Self-hosting
description: Run the nooklet server behind Tailscale (recommended), in Docker or Kubernetes, or behind a public reverse proxy; back it up, upgrade it, and add semantic search with Ollama.
order: 6
---

# Self-hosting

The server is one Node process with one SQLite file per graph. Run exactly one server process per
data directory.

There are three ways to expose it. Pick the first unless you have a reason not to.

| Tier | Setup | Status |
|---|---|---|
| 1 | **Tailnet only, HTTPS, a token per device** | Recommended default |
| 2 | Public, behind a TLS reverse proxy | Possible, with the checklist below |
| 3 | Plain `http://` beyond localhost | Unsupported; the client refuses to start |

[Security](security.md) explains the threat model behind this ranking.

## Server flags

```text
nooklet serve [--data <dir>] [--port <n>] [--web <dir>]
              [--host <addr>] [--allow-host <h,h>]
              [--no-loopback-token | --loopback-token] [--no-mirror]
```

| Flag | Default | Meaning |
|---|---|---|
| `--data <dir>` | `$NOOKLET_DATA`, else `~/.nooklet/default` | Data directory. Each graph lives in `graphs/<id>/`. |
| `--port <n>` | `6100` | TCP port. |
| `--host <addr>` | `127.0.0.1` | Bind address. Use `0.0.0.0` only in a container or when a proxy on another host must reach it. |
| `--allow-host <h,h>` | none | Comma-separated `Host` names clients may use besides `localhost`/`127.0.0.1`. On a non-loopback bind every other name gets 403, and `/mcp` checks the list on any bind. |
| `--no-loopback-token` | on for a loopback bind, off otherwise | Never hand a token to "this machine" automatically, even on a loopback bind. Set it behind a proxy on the same machine and in containers. |
| `--loopback-token` | off | Turn the automatic token back on for a non-loopback `--host` (it is off there by default). Rarely what you want. |
| `--web <dir>` | the built client, if found | Where the web client is. Without one the server is API-only. |
| `--no-mirror` | mirror on | Do not write the markdown mirror. |

`NODE_ENV=production` skips the op-log replay the server runs at startup in development (the same
check as `nooklet verify`). Set it once you trust the deployment.

The server has no TLS of its own. HTTPS comes from Tailscale or your proxy.

## Tier 1: tailnet only (recommended)

Your devices reach the server at `https://<machine>.<your-tailnet>.ts.net` with a certificate
Tailscale obtains for you. Nothing listens on the internet.

### On a machine with `tailscale serve`

See [Getting started](getting-started.md#recommended-a-server-on-your-tailnet) for the steps. In
short:

```sh
nooklet serve --data /srv/nooklet \
  --allow-host <machine>.<your-tailnet>.ts.net \
  --no-loopback-token
tailscale serve --bg --https=443 http://127.0.0.1:6100
```

Keep the server on its default loopback bind; only Tailscale's proxy talks to it. Run it under
whatever keeps a process alive on that machine (`systemd`, `launchd`, a container). `SIGTERM` stops
it cleanly.

### Docker

Each release publishes the server image for `linux/amd64` and `linux/arm64` (the arm64 one is only
smoke-tested so far) at `ghcr.io/hnykda/nooklet`, tagged with the version (`0.1.0` and `v0.1.0`),
`sha-<8 hex>` and `latest`. Pin a version rather than `latest`, so an upgrade happens when you
choose it. The image bundles Node, the server, the web client, `sqlite-vec` and the built-in
plugins; there is no `node_modules` at runtime.

The image runs as uid 1000, keeps data in `/data`, listens on 6100, and by default runs
`serve --host 0.0.0.0 --port 6100 --web /app/web --no-loopback-token`. Add your `--allow-host` by
passing the full command:

```sh
docker run -d --name nooklet --restart unless-stopped \
  -p 127.0.0.1:6100:6100 \
  -v nooklet-data:/data \
  ghcr.io/hnykda/nooklet:0.1.0 \
    serve --host 0.0.0.0 --port 6100 --web /app/web --no-loopback-token \
    --allow-host <machine>.<your-tailnet>.ts.net
```

To build the image yourself instead, from the repository root:
`docker build -f deploy/docker/Dockerfile -t nooklet .`, then use `nooklet` as the image name.

Then `tailscale serve --bg --https=443 http://127.0.0.1:6100` on the host, as above. Publish the
port on `127.0.0.1` only, so the container is not reachable from the LAN.

CLI commands run inside the container:

```sh
docker exec nooklet /app/node /app/server.mjs token create --label phone --scope write --sync
docker exec nooklet /app/node /app/server.mjs token root
docker exec nooklet /app/node /app/server.mjs backup --graph default --out /data/backups/default.tar.gz
docker exec nooklet /app/node /app/server.mjs --version
```

### Kubernetes

`deploy/` contains an example Helm chart. Whatever you use, keep these properties:

- **One replica, `Recreate` strategy.** Two pods on one SQLite file will corrupt each other's view.
  A rolling update briefly runs two.
- **A persistent volume at `/data`**, and a policy that keeps it when the release is deleted.
- **Container args**: `serve --data /data --host 0.0.0.0 --port 6100 --web /app/web
  --allow-host <name clients use> --no-loopback-token`. `kubectl port-forward` and sidecars arrive
  over the pod's loopback; the flag stops them being handed a token.
- **Probes** on `GET /healthz`.
- **The root token from a Secret.** The server reads `/data/root.token` and mints one if it is
  missing. An init container that copies the Secret over it on each start makes the Secret the
  source of truth.
- **Backups** as a CronJob running `nooklet backup --data /data --graph <id> --out /data/backups/…`
  for each graph, then copied off the cluster by whatever backs up your volumes.

For tailnet-only access, the [Tailscale Kubernetes operator](https://tailscale.com/kb/1236/kubernetes-operator)
can expose the Service with an Ingress of class `tailscale`. It provisions
`https://<name>.<your-tailnet>.ts.net` with a certificate and proxies WebSockets:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nooklet
spec:
  ingressClassName: tailscale
  defaultBackend:
    service:
      name: nooklet
      port:
        number: 80
  tls:
    - hosts:
        - nooklet
```

Unverified: which `Host` header the operator's proxy forwards. If the server answers 403 with
`Host "…" is not allowed`, add that name to `--allow-host`.

## Tier 2: public, behind a TLS reverse proxy

You can put nooklet on the internet behind Caddy, nginx or similar. **Public exposure has not had a
dedicated security review yet.** Treat it as your own risk until that review lands on this page.

> **Security review (2026-10-04).** Public exposure behind a TLS proxy is reasonable for one owner
> with a few devices **if every item below holds**. It is not yet suitable for several users or a
> high-profile host. What is missing is rate limiting inside nooklet and revocable asset URLs. Tailnet-only stays the recommendation. Details are in
> `docs/progress/security-review.md`, and the route-by-route list is in
> `docs/spec/security-inventory.md`.
>
> What nooklet now does by default, so you don't have to configure it:
> - Every API route needs a token unless it is on the public list. A test enforces this.
> - Responses carry `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. The app
>   page also carries a script CSP.
> - HSTS is sent when the proxy sends `X-Forwarded-Proto: https`.
> - Request bodies are capped at 16 MB, or 48 MB for uploads and sync pushes.
> - The automatic local token is off whenever `--host` is not loopback.
> - The sync and live-UI WebSockets close a connection that has not authenticated within 10 s,
>   allow 20 per token and 500 in total (`--ws-max-per-token`, `--ws-max-total`), and refuse
>   messages over 512 KiB.
>
> In addition to the checklist below:
> - **Make the proxy send `X-Forwarded-Proto: https`.**
> - **Limit WebSockets per IP at the proxy.** nooklet's caps are per token and in total, so one
>   client without a token can still take every free slot for 10 seconds at a time.
> - **After revoking a device's token, restart the server** if that device may still be connected.
>   Revocation stops its HTTP requests at once, but not a WebSocket it already has open.
> - **Assume a revoked device can still read the attachments (`/assets/<id>`) it has seen.** An
>   asset URL is a capability. It needs no token.
> - **Keep the startup log private.** The root token is printed once on first start, and container
>   logs keep it.
> - **Only install server plugins you have read.** They run with the server's full rights.

Checklist:

- **TLS at the proxy.** The proxy terminates HTTPS; nooklet listens on loopback or a private
  network only.
- **`--no-loopback-token`.** A proxy on the same machine connects from `127.0.0.1`. nooklet
  refuses the automatic token to any request carrying `Forwarded`, `X-Forwarded-For`,
  `X-Forwarded-Host` or `X-Real-IP`, but a proxy that rewrites `Host` and adds none of those
  looks exactly like a local browser. The flag closes that gap.
- **`--allow-host <your.domain>`.** Only the public name. Never work around the 403 with a
  catch-all.
- **Forward `Host`, forwarding headers and WebSocket upgrades.** Sync uses
  `/g/<id>/sync/live` and live UI control uses `/g/<id>/ui/live`.
- **Rate limiting at the proxy.** nooklet has no rate limiting of its own. Limit requests per
  client IP, and failed `401` responses in particular.
- **No root token in use from outside.** `/graphs` (list and create graphs) takes the root
  token. If you never create graphs remotely, consider blocking `/graphs` at the proxy.
- **One token per device and agent, least scope.** `read` for agents that only read; `--sync`
  only for devices. Revoke what you no longer use (`nooklet token list`, `token revoke`).
- **Keep it updated**, and watch the repository's security advisories.
- **Backups**, taken on a schedule and copied off the machine (below).

Caddy keeps `Host`, adds `X-Forwarded-For` and passes WebSockets by default:

```text
notes.example.com {
    reverse_proxy 127.0.0.1:6100
}
```

nginx needs the upgrade headers spelled out:

```nginx
location / {
    proxy_pass http://127.0.0.1:6100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Start nooklet with `--allow-host notes.example.com --no-loopback-token`.

## Tier 3: plain http beyond localhost (unsupported)

`nooklet serve --host 0.0.0.0 --allow-host <LAN-IP>` will accept connections, and the banner even
lists your LAN addresses. A browser on another machine still cannot use it: a page at
`http://<LAN-IP>` is not a secure context, so it has no `crypto.randomUUID`, no `navigator.locks`
and no OPFS. The client shows a page explaining this instead of starting.

The iOS app can sync over plain LAN http, because its page is `capacitor://localhost`, a secure
context. Tokens then cross your network in clear text. Use this for a quick test on a network you
trust, not as a setup.

## Data directory

```text
<data>/
  root.token              root token for /graphs (mode 0600)
  graphs/<id>/
    graph.json            graph id and label
    graph.sqlite          the database (WAL: also -wal and -shm files)
    assets/               uploaded files
    pages/ journals/      the markdown mirror
    plugins/              installed plugins for this graph
    backups/              default destination of `nooklet backup`
```

What you must keep is `graph.sqlite` and `assets/` for each graph, plus `root.token`. The mirror is
regenerated from the database.

Every CLI command except `serve` works on one graph: `--graph <id>`, default `default`. Each is a
short-lived process that opens the same database file, safe to run while `serve` is up (except
`restore`).

## Backups and restore

```sh
nooklet backup [--graph <id>] [--out <file>] [--data <dir>]
```

`backup` writes one `.tar.gz` with a manifest, a consistent snapshot of the database (SQLite's
`VACUUM INTO`, safe while the server runs and writes) and the graph's `assets/`. Without `--out` it
lands in `graphs/<id>/backups/`. Copy it off the machine; nooklet does not. Nothing runs on a
timer: schedule it with cron, a `launchd` job or a CronJob.

Do not rely on a file-level copy of a live `graph.sqlite`. Back up the archives instead.

With several graphs, back up each one; an archive holds exactly one graph:

```sh
nooklet backup --graph default --out /backups/default-$(date +%F).tar.gz
nooklet backup --graph alpha   --out /backups/alpha-$(date +%F).tar.gz
```

To restore:

```sh
# stop the server first
nooklet restore <archive> [--graph <id>] [--data <dir>] [--force]
nooklet verify --graph <id> --data <dir>
# start the server again
```

`restore` writes into `graphs/<id>/` only, so restoring `alpha` leaves every other graph as it
is. Without `--graph` it restores `default`. Restore an archive into the graph it came from: the
archive does not record which graph that was.

`restore` refuses to overwrite an existing database unless you pass `--force`, and refuses an
archive from a newer schema than the build understands. With `--force` it also discards the old
database's leftover `-wal`/`-shm` files, which a server that was killed rather than stopped leaves
behind. Do a drill once: restore into a scratch `--data` directory and run `verify`. It should
print `OK`.

### Trimming the op log

The op log grows forever by default. `nooklet gc --dry-run` shows what `nooklet gc` would remove:
ops every device has already pulled, and uploaded files nothing references for 7 days
(`--asset-grace <days>`). A real run takes a backup first. `gc` refuses to trim while a device that
has never synced holds a token; revoke tokens of devices you no longer use.

## Upgrades

1. Take a backup of each graph, and note the running version (`nooklet --version`).
2. Update: `git pull && pnpm install && pnpm --filter @nooklet/web build`, or change the image tag
   to the new version (the [Releases page](https://github.com/hnykda/nooklet/releases) and
   `CHANGELOG.md` say what changed).
3. Restart the server. Opening a database runs any pending schema migrations; they only add tables
   and columns.
4. If a command says the database schema is newer than the build, you started an older build on
   newer data. Go back to the newer build.

Open clients pick up the new web client within seconds (the service worker swaps it and the page
reloads once). The desktop app shows it on its next launch.

Do not rebuild the web client while a server is serving that same `apps/web/dist` to someone. A
page that loads mid-build can reference files the build just deleted and show a white screen.

## Semantic search with Ollama

Semantic search is off until you give a graph an embedding model. The default is
[bge-m3](https://ollama.com/library/bge-m3) on [Ollama](https://ollama.com): multilingual (it
handles mixed-language notes), 1024 dimensions, about 1.2 GB.

```sh
ollama pull bge-m3
nooklet embed model bge-m3 --provider ollama --host http://127.0.0.1:11434 [--graph <id>]
nooklet embed status
```

`embed model` probes the model, embeds every block (minutes for thousands of blocks on a laptop CPU,
longer on a small server) and then switches semantic search on. You can do the same from the app:
Settings → Search & embeddings. The setting is stored per graph, not in flags or environment.

- The server must reach Ollama at `--host`. In Docker or Kubernetes that is the Ollama service's
  address, not `127.0.0.1`.
- Ollama unloads a model after 5 idle minutes; the next query then takes seconds. Set
  `OLLAMA_KEEP_ALIVE=-1` on Ollama to keep it loaded. The app gives the server 6 seconds before it
  settles for local results.
- `--provider openai-compat --host <base-url>` works with OpenAI-compatible servers that need no
  key (LM Studio, the llama.cpp server). nooklet does not send an API key yet, so hosted APIs
  answer 401. A hosted API would also receive the text of every block.
- `nooklet embed run` drains the indexing queue on demand; the server also does it in the
  background as you write.

## Operating notes

- **"Device clock is wrong."** A device's clock runs more than 60 s ahead of the server. Fix it; the
  push succeeds on retry.
- **A lost device.** `nooklet token revoke <id>`. A revoked token cannot sync, and stops holding back
  `gc`.
- **Rotating a token.** Create a new one, switch the device or agent to it, confirm it works, revoke
  the old one.
- **`nooklet verify`** after anything unusual. It names the exact table, row and column if live
  state ever differs from the op log.

More detail, including the GC floor and one-off repairs, is in
[docs/OPERATIONS.md](../OPERATIONS.md).
