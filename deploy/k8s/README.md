# nooklet on the homeserver MicroK8s cluster — DRAFT, NOT APPLIED

Nothing in this directory has been applied to any cluster, and no one has run `helm template` against
the owner's real `infra-repo` helmfile. It is a reviewable draft in the shape of
`infra-repo/k8s/charts/kb-mcp` (single replica, SQLite on a PVC, `strategy: Recreate`) with
hermes's newer conventions (required pinned tag, non-root uid 1000, `helm.sh/resource-policy: keep`
on the PVC) and that repo's Tailscale Ingress pattern for HTTPS/WSS. The full rollout, with every
owner decision, is in `docs/progress/real-device-test.md` §"Hosting on homeserver".

| File here | Goes to (in `infra-repo`) |
|---|---|
| `charts/nooklet/` | `k8s/charts/nooklet/` |
| `values/nooklet.yaml.gotmpl` | `k8s/values/nooklet.yaml.gotmpl` (reads the root token from SOPS) |
| `helmfile-snippet.yaml` | merge into `k8s/helmfile.yaml`, `k8s/environments/values.yaml`, `k8s/charts/tailscale-services/values.yaml`, `k8s/environments/secrets.yaml` |
| `woodpecker-nooklet.yaml` | `.woodpecker/nooklet.yaml` (the image source lives in this repo, so it builds via `BUILD_TARGET` — see that file's header) |

The image is `deploy/docker/Dockerfile` (built from this repo's root).

What the chart does, and why:

- **One replica, `Recreate`, ReadWriteOnce `database-storage` PVC** — SQLite with one writer
  process; a rolling update would briefly run two. `database-storage` is the cluster's `Retain`
  class; the PVC also carries `helm.sh/resource-policy: keep` from the first install, because
  infra-repo' own incident note says adding it later does nothing.
- **`--host 0.0.0.0 --allow-host <tailnet name>`** — nooklet binds loopback by default and, once
  exposed, answers 403 to any `Host` it was not told about (DNS-rebinding guard) on every graph
  route. The probes hit the bare `/healthz` (outside that guard) and also send `Host: localhost`.
- **Root token from a Secret**, copied to `/data/root.token` by an init container on every start, so
  the SOPS value is the source of truth (the server otherwise mints its own on first run and prints
  it once to the log).
- **Nightly consistent backup** (`backup-cronjob.yaml`): `nooklet backup` per graph (a `VACUUM INTO`
  snapshot + assets, safe while the server runs) into `/data/backups/` at 01:30, keeping 7 days.
  the home server's host-level duplicacy run at 02:00 already copies every PVC directory to Google Drive, so
  those archives ride along; the live `graph.sqlite`/`-wal` files it also copies are not guaranteed
  consistent, which is why the archive exists.
