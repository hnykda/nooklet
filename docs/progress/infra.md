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
- [ ] Private infra PR (see below).
- [ ] Image builds verified locally (see "Verification").

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
