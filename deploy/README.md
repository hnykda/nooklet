# Deploying nooklet

Generic building blocks for running a nooklet server and the public site on your own
infrastructure. Nothing here names a particular cluster, registry or network; a real deployment
supplies those as values and CI secrets.

| Path | What |
|---|---|
| `docker/Dockerfile` | Server image: `nooklet serve` + the web client, self-contained (no `node_modules` at runtime). Build from the repo root. |
| `docker/site.Dockerfile`, `docker/site.nginx.conf` | Public site image: `apps/site`'s static export behind nginx. Static files only. |
| `helm/nooklet/` | Example Helm chart for the server: one replica, SQLite on a PVC, root token from a Secret, nightly backup CronJob. |
| `../.woodpecker/` | CI: `leak-guard.yaml` (gitleaks, every push and PR) and `images.yaml` (build and push both images on `main` and tags, then request a deploy). |
| `../tools/ci/` | The shell those pipelines run, so it can be run locally too. |

## The server

```sh
docker buildx build --platform linux/amd64 -f deploy/docker/Dockerfile -t nooklet:dev .
```

Things any deployment has to get right:

- **One process per data directory.** SQLite with a single writer: one replica, `Recreate`
  strategy, never two servers on one volume.
- **`--allow-host <name>`.** Bound to `0.0.0.0`, the server answers 403 to every `Host` it was not
  told about (DNS-rebinding guard). Pass the name clients type. A reverse proxy that keeps the
  client's `Host` (Tailscale's serve/Ingress proxy does: it sets the outgoing `Host` to the
  incoming one, `ipn/ipnlocal/serve.go`) needs only that name; one that rewrites `Host` needs the
  rewritten name too. The 403 body and the server log both name the refused host.
- **`--no-loopback-token`** whenever anything can reach the server over loopback that is not the
  person at the machine: a sidecar proxy, `kubectl port-forward`, `docker exec`. Without it, the
  server hands such callers a write + sync token (B-600).
- **The root token** lives at `<data>/root.token`. The chart copies it from a Secret on every
  start, so the Secret is the source of truth. Generate: `echo "nkroot_$(openssl rand -hex 24)"`.
  Devices get their own tokens (`nooklet token create`), never the root one.
- **Backups.** `nooklet backup --graph <id> --out <file>` takes a consistent snapshot while the
  server runs. A file-level copy of the live `graph.sqlite` + WAL is not guaranteed consistent. The
  chart's CronJob writes `backups/nooklet-<graph>-<date>.tar` into the volume nightly, for whatever
  copies the volume off-site. Restore one graph: scale to 0, then in a pod with the volume mounted
  `nooklet restore /data/backups/nooklet-alpha-<date>.tar --data /data --graph alpha --force` and
  `nooklet verify --data /data --graph alpha`, then scale back. Only that graph's directory
  (`/data/graphs/alpha/`) is touched; the other graphs stay as they are. Without `--graph` it
  restores `default`. (Before B-671 was fixed, `restore` refused `--graph`.)
- **`/healthz`** is the liveness/readiness endpoint and sits outside the Host guard.

### Helm chart

```sh
helm install notes deploy/helm/nooklet \
  --set image.repository=registry.example.com/nooklet --set-string image.tag=sha-0123abcd \
  --set 'allowHosts={notes.example.com}' --set rootToken="nkroot_..."
```

(or `existingSecret=<name>` with key `root-token` instead of `rootToken`). The chart has no
Ingress: exposure is yours to choose, and whatever name it gives clients goes in `allowHosts`.
The PVC carries `helm.sh/resource-policy: keep` from the first install, so `helm uninstall` leaves
the data behind; that annotation has no effect if added after the first install.

## The site

```sh
docker buildx build --platform linux/amd64 -f deploy/docker/site.Dockerfile -t nooklet-site:dev .
docker run --rm -p 8080:80 nooklet-site:dev
```

The build needs the whole repo as context: the site renders `docs/guide` and `docs/adr` at build
time. nginx maps `/docs/x` to `docs/x.html` (the export uses `trailingSlash: false`) and serves the
`.md` twins as `text/markdown`. TLS and HSTS belong to whatever is in front of it.

## CI and forks

This repository is public, so anyone can open a pull request, and a pull request can rewrite
every file in `.woodpecker/`. Nothing in the YAML can stop a hostile PR, so the protections
are Woodpecker server-side settings. Whoever enables the repo in Woodpecker must:

1. **Secrets are filtered by event.** Create every secret `images.yaml` reads (`registry`, `server_image`,
   `site_image`, `deploy_trigger_url`,
   `deploy_trigger_token`) with events `push`, `tag`, `manual` only, never `pull_request`.
   Woodpecker enforces this filter when it hands secrets to a step, so a PR pipeline gets none,
   whatever its YAML says.
2. **Pull requests need approval.** Set the repo's *Require approval* to *all pull requests*
   (or at least *forks*). An unapproved PR pipeline doesn't run at all. This matters beyond
   secrets: a running PR step is a pod in the CI cluster and can reach whatever that network
   can reach (an unauthenticated in-cluster registry, for one, where it could overwrite a tag).
   Approve only after reading the diff, `.woodpecker/` and `tools/ci/` above all.
3. **The repo stays untrusted.** Leave *Trusted* (privileged containers, host volumes, network)
   off. The buildx plugin gets its privileges from the server's privileged-plugins list, not
   from this flag.
4. **Pushes and tags come only from maintainers.** `images.yaml` runs on push to `main`, on
   tags and on manual runs of `main`, all of which need write access to the repo. Branch
   protection on `main` keeps that true.

What runs where: `leak-guard.yaml` runs on every event, PRs included, and uses no secrets and no
privileged image. That is why it is safe to approve routinely. `images.yaml` never has a
`pull_request` trigger. Its deploy step runs only for `main` and starts a pipeline in the
deployer's infrastructure repo. This repo holds no cluster credential.
