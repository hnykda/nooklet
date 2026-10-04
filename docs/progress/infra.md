# Production deployment (infra) — progress

Slug `infra`. Started 2026-10-04 from `70b60be`. Goal: generic, public-safe deployment pieces in this
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
      `sha-<8>` + git tag; deploy trigger on `main`). Shell in `tools/ci/`. Uses the leak-audit agent's
      `tools/leak-check.mjs` + `.gitleaks.toml` (mine was dropped to avoid an add/add conflict).
- [x] Private infra PR opened as a **draft** in the owner's infrastructure repo (the owner has the
      link). Not merged, nothing applied.
- [x] Server and site images built and run locally (see "Verification").

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
- The chart is vendored there from `deploy/helm/nooklet` at `9633525`; keep templates in sync.
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
- Site image: built from a copy of the site agent's in-progress worktree (its `apps/site` + `docs/guide`,
  2026-10-04 ~09:55) with this branch's `deploy/docker/site.*` and `.dockerignore`
  (`pnpm install --filter "@nooklet/site..."` + `pnpm --filter @nooklet/site build`): 71.5 MB.
  Served on 127.0.0.1:6452: `/`, `/docs`, `/docs/agents` (→ `agents.html`), `/decisions` 200 html;
  `/docs/agents.md` 200 `text/markdown`; `/llms.txt`, `/search-index.json` 200; `/nope` 404. Re-run
  once `apps/site` is merged. nginx config alone also checked against a fake export (headers,
  immutable cache on `/_next/static/`).
- `woodpecker-cli lint` (v3.18.1, local) → valid for `images.yaml`, `leak-guard.yaml` and the
  infra repo's deploy pipeline.
- Leak guard (`zricethezav/gitleaks:v8.28.0`, against a clone of this branch): gitleaks-only
  fallback: tree scan flags the known token; with it redacted in the clone, tree + range
  `70b60be..HEAD` pass, and a range spanning the token's commit (`1e40ea0~1..HEAD`) fails, as it
  should. With the leak-audit branch's `tools/leak-check.mjs` + `.gitleaks.toml` dropped into the
  clone: nodejs installs from apk inside the gitleaks image (node 20), `--range 70b60be..HEAD`
  → clean, `--range 1e40ea0~1..1e40ea0` → 2 findings, exit 1; `--tree` fails on the pre-scrub
  docs of this branch (expected, scrubbed on the leak-audit branch).
- **Not verified:** Helm rendering of either chart (no `helm` run, by instruction); the site
  image on the merged tree; anything on the real cluster/Woodpecker; Woodpecker's
  handling of `from_secret` in plugin settings for `registry`/`repo`/`buildkit_config` (documented
  feature, not exercised).

## BUGS.md updates to fold in

- **(new, open)** `nooklet restore --graph <id>` is rejected (`unknown flag --graph`):
  `RESTORE_FLAGS` in `packages/server/src/cli-args.ts` is `["data", "force"]`, but the `restore`
  case in `cli.ts` reads `graphIdFlag(args)`. Only the `default` graph can be restored from the CLI.
  Found reading the CLI for the backup CronJob; not fixed (out of scope).
- The leaked `nk_` token in `docs/BUGS.md`/research 12 is the leak-audit agent's finding (see
  `leak-audit.md`, "Rotate"); not duplicated here.

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

`.woodpecker/leak-guard.yaml` → `tools/ci/leak-guard.sh` in the gitleaks image, on every push, tag
and PR (no secrets). Scans the tree and the commits the push/PR adds (PR: target branch..HEAD;
push: `CI_PREV_COMMIT_SHA..HEAD`; fallback `HEAD~1..HEAD`), not all history (old findings would
fail every pipeline forever). Runs `node tools/leak-check.mjs --tree` / `--range` when that file
exists (it also runs gitleaks with `.gitleaks.toml`), else plain gitleaks.

**Needed in the leak-audit branch's `.gitleaks.toml` at merge** (checked: gitleaks v8.28 refuses
to load a config that has both the legacy `[allowlist]` and `[[allowlists]]`):

1. rename its `[allowlist]` table to `[[allowlists]]` (same keys);
2. append this narrow allowlist for 5 false positives of the default `generic-api-key` rule
   (keymap entries in `apps/web/src/commands/keymap/build.test.ts` and
   `docs/spec/commands-and-keymap.md`; RFC 6455's sample nonce in `graphs/mount.test.ts` and
   `tools/probes/upgrade-socket-error.mjs`), without which the CI tree scan fails:

```toml
[[allowlists]]
description = "keymap entries ({ key: \"Mod+Shift+Enter\" }) and RFC 6455's sample Sec-WebSocket-Key nonce"
regexTarget = "line"
regexes = [
  '''(?i)["']?key["']?\s*:\s*["'](?:Mod|Shift|Alt|Ctrl|Meta|Cmd)\+''',
  '''dGhlIHNhbXBsZSBub25jZQ==''',
]
```

With both changes, the combined config loads and leaves none of those 5 (verified against this
tree). Leak-audit's findings about `deploy/` (tailnet name, host name, infra repo name, backup
internals, storage class, registry host, host-named secret names) are all resolved here:
`deploy/k8s/` is gone; nothing under `deploy/`, `.woodpecker/`, `tools/ci/` or this file matches
its shape rules (checked with the combined config).

## Notes for the coordinator

- `docs/progress/real-device-test.md` §7 (H1-H3) and D2 still point at the deleted `deploy/k8s/`
  paths; the infra PR supersedes them. That file (and `coordinator.md`, `BUGS.md`,
  `desktop-shell.md`, `server-search.md`) also names private infrastructure, which is the
  leak-audit agent's job, not changed here.
- `.woodpecker/` is new: Woodpecker runs every file in it once the owner activates the repo.
  GitHub Actions (`.github/workflows/`) are untouched.

## How to resume

Branch `worktree-agent-a3b61b4747014a1c8` (never pushed). Done from this agent's side. After the
site, docs and leak-audit branches merge: rebuild the site image on the merged tree
(`docker buildx build --platform linux/amd64 -f deploy/docker/site.Dockerfile .`, ports 6450-6454),
apply the two `.gitleaks.toml` changes above, and run `sh tools/ci/leak-guard.sh` in the gitleaks
image (see its header) — it must be clean before the owner activates the repo in Woodpecker.
