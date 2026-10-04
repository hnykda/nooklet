# Production deployment (infra) — progress

Slug `infra`. Started 2026-10-04 from `e3df44a`. Goal: generic, public-safe deployment pieces in this
repo; the owner-specific deployment lives in the owner's private infrastructure repo as a draft PR.
**This file is public: it names no hosts, networks, registries or secret values.**

## Status

- [x] `deploy/` made generic: `deploy/docker/Dockerfile` (server, libatomic1 fix kept),
      `deploy/docker/site.Dockerfile` + `site.nginx.conf` (site), `deploy/helm/nooklet/` (example chart,
      placeholders, `existingSecret` option, hardened pod: no SA token, no privilege escalation,
      all capabilities dropped). The owner-specific draft (`deploy/k8s/`: helmfile snippet, values,
      infra pipeline) moved to the private repo and is deleted here.
- [x] Woodpecker: `.woodpecker/leak-guard.yaml` (gitleaks on push/tag/PR/manual, no secrets),
      `.woodpecker/images.yaml` (build + push server and site images on `main`/tags, tags
      `sha-<8>` + git tag; deploy trigger on `main`). Shell in `tools/ci/`. Config `.gitleaks.toml`.
- [x] Private infra PR opened as a **draft** in the owner's infrastructure repo (the owner has the
      link). Not merged, nothing applied.
- [x] Server image built and run locally (see "Verification"). Site image: pending `apps/site`.

## The private PR, without private details

- Server: tailnet-only (Tailscale operator Ingress, HTTPS MagicDNS name, WSS), one replica,
  `Recreate`, PVC 5Gi on the cluster's Retain hostpath class (inside the host's existing nightly
  off-site backup path), root token from the infra repo's SOPS file (placeholder + instructions
  only), `--no-loopback-token`, `--allow-host <tailnet name>`, requests 50m/192Mi, limits 1/768Mi,
  `/healthz` probes, the chart's nightly backup CronJob at 01:30 (before the host backup).
- Site: public on a subdomain the owner already has a wildcard certificate for, exposed the way the
  owner's other static sites are (Traefik Ingress, existing wildcard TLS). DNS record to add is
  in the PR.
- Deploy pipeline in the infra repo, triggered by this repo's `images.yaml` with
  `BUILD_TARGET=nooklet NOOKLET_TAG=sha-<8>`: validates the tag, takes the infra repo's deploy
  lock, runs a pre-deploy backup Job, then syncs server and site.
- The chart is vendored there from `deploy/helm/nooklet` at `3b149c9`; keep templates in sync.
- Ollama/bge-m3 **not** deployed: nooklet's own measurement (Ollama ~3.4 GB RSS indexing,
  `search-fallback-verify.md`) does not fit the node's free memory. Written up as a follow-up.

### Decisions (D2/D4) as assumed in the PR

- D2: namespace `apps`; tailnet hostname `nooklet`; PVC 5Gi (hostpath: not resizable, not
  enforced); memory request 192Mi / limit 768Mi (nooklet measured 240-392 MB RSS indexing);
  image tags `sha-<8>`; chart lives in the infra repo (vendored), generic copy here.
- D4: **answered from source, not observed live.** The operator's Ingress proxy is tailscaled's
  `serve` reverse proxy, which sets the outgoing `Host` to the incoming one and adds
  `X-Forwarded-Host/-Proto/-For` (`ipn/ipnlocal/serve.go` at the operator's version, v1.102.4;
  `cmd/k8s-operator/ingress.go` builds a `ServeConfig` proxying to the Service's ClusterIP). So
  `--allow-host` needs only the MagicDNS name. If wrong, the 403 names the host.

## Owner steps (summary; exact commands are in the PR)

1. DNS record for the site subdomain. 2. Root token into SOPS. 3. Remove any stale tailnet
machine with the same name; optional ACL tag. 4. Activate this repo in Woodpecker: approval for
all PRs, untrusted, six secrets limited to push/tag/manual. 5. Merge the PR. 6. Push `main` here
(or trigger the deploy pipeline by hand). 7. Verify `/healthz`, the Host guard, the site, and the
next morning's backup archive. 8. Mint device tokens with `nooklet token create` via `kubectl exec`.

## Verification

- `docker buildx build --platform linux/amd64 -f deploy/docker/Dockerfile .`: builds (layers were
  partly cached from the earlier draft's build). Run on 127.0.0.1:6450 with the chart's args
  (`--allow-host notes.example.com --no-loopback-token`): `/healthz` 200; allowed Host →
  `token:null, reason: loopback_token_disabled`; `Host: evil.example` → 403 naming it;
  `Host: localhost` → no token; `backup --data /data --graph default --out …` → archive written.
- `woodpecker-cli lint` (v3.18.1, local) → valid for `images.yaml`, `leak-guard.yaml` and the
  infra repo's deploy pipeline.
- Leak guard, against a clone of this branch: tree scan finds the 2 token findings (below);
  with them redacted in the clone, tree + range `e3df44a..HEAD` pass; range from before the token
  commit (`727d358~1..HEAD`, 714 commits) fails with 2 findings, as it should. Fallback `-1 HEAD`
  works.
- **Not verified:** Helm rendering of either chart (no `helm` run, by instruction); the site
  image (needs `apps/site`); anything on the real cluster/Woodpecker; Woodpecker's
  handling of `from_secret` in plugin settings for `registry`/`repo`/`buildkit_config` (documented
  feature, not exercised).

## BUGS.md updates to fold in

- **(new, open)** `nooklet restore --graph <id>` is rejected (`unknown flag --graph`):
  `RESTORE_FLAGS` in `packages/server/src/cli-args.ts` is `["data", "force"]`, but the `restore`
  case in `cli.ts` reads `graphIdFlag(args)`. Only the `default` graph can be restored from the CLI.
  Found reading the CLI for the backup CronJob; not fixed (out of scope).
- **(new, open, security hygiene)** A real-shaped token `nk_7960…` is in `docs/BUGS.md` (B-25)
  and `docs/research/12-multi-user-and-pairing.md`. It came from a throwaway server on port 6198,
  so it is almost certainly dead, but it is the only finding the leak guard reports. Redact it in
  both files, and it stays in git history (the guard scans only new commits, by design).

## How the public pipelines avoid leaking to forks

A pull request can rewrite `.woodpecker/*`, so the YAML is not the protection. The protections,
which the owner sets when enabling the repo in Woodpecker (also in `deploy/README.md`, "CI and forks"):

1. Every secret (`registry`, `registry_buildkit_config`, `server_image`, `site_image`,
   `deploy_trigger_url`, `deploy_trigger_token`) is created with events `push`, `tag`, `manual`
   only. Woodpecker withholds them from `pull_request` pipelines regardless of their YAML.
2. Repo setting *Require approval* = all pull requests (minimum: forks). A PR pipeline is a pod
   in the CI cluster even without secrets; unapproved, it never starts.
3. Repo stays untrusted (no privileged/volumes/network trust).
4. `images.yaml` has no `pull_request` trigger; `main` and tags need write access (branch
   protection on `main`).

Registry and image names are secrets too, so this public repo names no infrastructure. The repo
holds **no cluster credential**: the deploy step only starts a pipeline in the private infra repo
with `BUILD_TARGET=nooklet NOOKLET_TAG=sha-<8>`; that pipeline holds the credentials.

## Leak guard

`tools/ci/leak-guard.sh`: gitleaks `dir` over the tree + `git` over the commits the push/PR adds
(not all history: old findings would fail every pipeline forever). Verified locally with
`zricethezav/gitleaks:v8.28.0` against this tree: default rules + `.gitleaks.toml` leave exactly
two findings, both the same **real-shaped nooklet token** `nk_7960…` (rule `nooklet-token`) in
`docs/BUGS.md` (B-25) and `docs/research/12-multi-user-and-pairing.md` line 123. It came from a
throwaway server on port 6198 in Sep 2026 — almost certainly dead, but it must be redacted from
those files (and so the guard fails on `main` until then — deliberately not allowlisted). Five
default-rule false positives (keymap `key: "Mod+…"` entries, RFC 6455's sample
`Sec-WebSocket-Key`) are allowlisted narrowly in `.gitleaks.toml`.

## Notes for the coordinator

- `docs/progress/real-device-test.md` §7 (H1-H3) and D2 still point at the deleted `deploy/k8s/`
  paths; the infra PR supersedes them. That file (and `coordinator.md`, `BUGS.md`,
  `desktop-shell.md`, `server-search.md`) also names private infrastructure, which is the
  leak-audit agent's job, not changed here.
- `.woodpecker/` is new: Woodpecker runs every file in it once the owner activates the repo.
  GitHub Actions (`.github/workflows/`) are untouched.

## How to resume

Branch `worktree-agent-a3b61b4747014a1c8` (never pushed). Remaining: build the site image once
`apps/site` lands (`docker buildx build --platform linux/amd64 -f deploy/docker/site.Dockerfile .`,
run on 6450-6454 only), and address `docs/progress/leak-audit.md` findings about `deploy/`.
