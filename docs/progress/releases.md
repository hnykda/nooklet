# Release mechanism — progress

Slug `releases`. Started 2026-10-04 from `78d0475`. Branch `worktree-agent-a35e09962cdb1ead8`
(never pushed). Goal: `pnpm release <version>`, a GitHub Actions release workflow (desktop,
Android, GHCR image, draft-then-publish release), multi-arch Woodpecker images on tags, docs.

## Status

- [x] `822be67` Android project generated (`@capacitor/android` 8.5.1), deep link, cleartext
      policy, launcher icons; server CORS allows `https://localhost` (see "Decisions").
- [x] `cf5a046` In-app version read from `apps/web/package.json` (was a hard-coded literal), help
      menu line links to the Releases page ("check for updates").
- [x] `94513ea` `tools/release.mjs` + `tools/release-lib.mjs` (+ tests), `.github/workflows/release.yml`
      rewrite, `tools/ci/{desktop-bundle.sh,android-apk.sh,release-notes.mjs}`, Woodpecker
      multi-arch tag steps, `image-tags.sh` (`latest` on final tags), site build on
      `$BUILDPLATFORM`, Windows fixes in `build-sidecar.mjs`.
- [x] `21a5638` Docs: RELEASING.md, getting-started (downloads, unsigned-app steps per OS,
      "Android (experimental)"), self-hosting (GHCR), README "Platform support" (after Quick
      start, anchor used by main's Project status block), `.github/ISSUE_TEMPLATE/platform-report.yml`.
- [x] `a1e9a0a` CI fixes forwarded by the coordinator: B-686, B-687, B-690.
- [x] Last commit: e2e `help.spec.ts` follows the package version; apps/web README Android item;
      this file. Verification below.

## Owner: test on a branch, then tag

1. Push this branch; GitHub → Actions → **Release** → **Run workflow** on it (a dry run: builds
   every artifact and both image architectures, pushes and releases nothing). Fix and re-run until green.
2. Download the run's artifacts; install at least the macOS `.dmg` (with the `xattr` step).
3. Merge to `main`, `pnpm release 0.1.0` (replace the 800-commit CHANGELOG section with a summary
   in the editor), `git push origin main && git push origin v0.1.0`. Then make the GHCR package
   public, and check the Woodpecker tag pipeline (arm64 needs binfmt on the node).

Secrets (names only, all optional): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`; later `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`,
`APPLE_TEAM_ID`. Repo variable `RELEASE_KEEP_DRAFT=true` to stop at a draft.

## Verification (2026-10-04, local)

- `pnpm release 0.1.0 --dry-run` on this branch (exit 1 because of the three WOULD STOPs, as
  intended off main). Excerpt:

  ```text
  == Preconditions
     WOULD STOP: the working tree is not clean: ?? docs/progress/releases.md
     WOULD STOP: releases are cut from main, this is "worktree-agent-a35e09962cdb1ead8"
     WOULD STOP: HEAD (94513ea7) is not origin/main (6f314da9): pull or push first
     previous tag: (none: first release)
  == Checks
     would run: pnpm -r typecheck / pnpm test / biome check . --diagnostic-level=error / leak-check --tree
  == Version -> 0.1.0
     apps/desktop/package.json  (already at this version)
     apps/site, apps/web, packages/{core,plugin-api,server}/package.json: "0.0.1" -> "0.1.0"
     package.json: + "version": "0.1.0"
     plugins/*, tauri.conf.json, Cargo.toml, Cargo.lock  (already at this version)
     project.pbxproj: CURRENT_PROJECT_VERSION 1 -> 1000, MARKETING_VERSION 1.0 -> 0.1.0 (x2)
     android/app/build.gradle: versionCode 1 -> 1000, versionName "1.0" -> "0.1.0"
  == CHANGELOG.md
     810 commits since the beginning; new section: ## [0.1.0](…/releases/tag/v0.1.0) - 2026-10-04
     ### Features / ### Fixes / ### Other (B-ids linked to docs/BUGS.md anchors)
     Also 339 docs, 76 test, 11 chore, 2 style, 2 probe, 1 wip commits, not listed
  == Git
     would commit: "release: v0.1.0" (9 files); would tag v0.1.0; then: git push origin main && git push origin v0.1.0
  ```

- Real run on throwaway branch `release-rehearsal` (`--allow-branch --skip-slow --no-edit`):
  biome + leak check ran, commit `release: v0.1.0` (9 files, CHANGELOG 399 lines) + annotated tag.
  After it: `pnpm install --frozen-lockfile` up to date, biome clean, `release-notes.mjs 0.1.0`
  extracts the section, the web build's help menu says `0.1.0`. Branch and tag deleted locally.
- `actionlint` 1.7.12 (Docker image, with shellcheck) on `ci.yml` + `release.yml`: clean.
  shellcheck on `tools/ci/*.sh`: clean. `woodpecker-cli lint` 3.18.1: valid with
  `--plugins-privileged woodpeckerci/plugin-docker-buildx:5-insecure` (without it, the same
  "no longer privileged by default" error the unmodified file gives; a server setting).
- `tools/probes/image-tags-cases.sh`: main → `sha-` only; `v0.1.0` → + `v0.1.0`, `latest`;
  `v0.2.0-rc.1` → no `latest`.
- Server image: built for linux/amd64 (emulated) and linux/arm64 (native) locally; both start,
  `/healthz` 200; amd64: `/` 307 → `/g/default/`, `/api/session` `loopback_token_disabled`,
  an `Origin: https://localhost` preflight gets `access-control-allow-origin: https://localhost`,
  `token create` works via `docker exec`. Site image built for amd64 and arm64 (separately; the
  local docker driver has no multi-platform build).
- macOS: `pnpm desktop:build` → `nooklet.app` + `nooklet_0.1.0_aarch64.dmg` (ad-hoc signed, sidecar
  inside); `tools/ci/desktop-bundle.sh 0.1.0-local macos-arm64 app,dmg` → `dist/nooklet-0.1.0-local-macos-arm64.dmg`.
- `pnpm test` (core 479, plugin-api 17, server 813, web 1624, tools 7), `pnpm -r typecheck`,
  `biome check . --diagnostic-level=error`, `leak-check --tree`: all pass.
- e2e: `help.spec.ts` failed first (it pinned "nooklet 0.1.0"; the build said 0.0.1): fixed to read
  the package version. help/views/desktop-shell/keys-in-fields specs pass (chromium). Full `pnpm e2e` (port 6478,
  23.5 min): 776 passed, 2 skipped, 1 failed: `mermaid-lazy-cache.spec.ts` "a diagram rendered once
  renders again offline" (timed out waiting for the offline re-render). Re-run alone with
  `--repeat-each=3`: 6/6 pass. Treated as load-dependent flakiness, not caused by this branch (its
  only client change is the help-menu line and the version `define`); worth a BUGS entry if it recurs.

### Not verified (only CI can)

- The GitHub workflow itself: runner labels (`macos-15-intel`, `windows-2025`, `ubuntu-24.04-arm`),
  Linux/Windows/Intel bundles, the Windows sidecar fixes, the Android Gradle build (no Android SDK
  here), GHCR push-by-digest + manifest, release creation. macOS signing/notarization (no
  certificate exists). Woodpecker multi-arch (QEMU on the owner's node).
- Android at runtime: nothing about the APK has ever run.

## Decisions

- **Version 0.1.0.** First tagged release; pre-1.0 says "expect breaking changes", which the README
  already promises. The desktop app, plugins and the old help-menu literal already said 0.1.0, so
  nothing a user has seen goes backwards.
- **Android cleartext.** `network_security_config.xml` permits cleartext in `base-config`: Android
  cannot scope it to local addresses (domain-config does not match IP literals), and a LAN server by
  IP is a documented setup. `android.allowMixedContent: true` because the WebView origin is
  `https://localhost`. Cost: a token over plain HTTP is readable on that network, same as iOS's
  `NSAllowsLocalNetworking` already accepts. Docs push HTTPS/Tailscale.
- **Android CORS.** Without `https://localhost` in `APP_SHELL_ORIGINS` (`packages/server/src/graphs/mount.ts`)
  the APK could reach no server (its every request is cross-origin, like iOS before B-598). The
  comment there anticipated adding it "once an Android project exists". Cost written in the comment:
  a page served at `https://localhost` by something else on the server machine could read
  `/api/session`'s loopback token; `--no-loopback-token` removes that. Capacitor cannot give Android
  its own hostname without changing iOS's origin (orphaning iOS data).
- **No universal macOS app.** The sidecar ships the building machine's Node/esbuild/sqlite-vec; a
  universal app would need lipo'd copies of all three. Two native .dmg builds instead.
- **GHCR on native arm64 runners** (push by digest, then one manifest job) rather than QEMU.
- **Woodpecker arm64 via QEMU** (only option on the owner's CI); site export built on
  `$BUILDPLATFORM` so only nginx is emulated.

## BUGS.md updates to fold in

- **(new, fixed)** The help menu's version was a literal `"0.1.0"` in `apps/web/vite.config.ts`
  while `apps/web/package.json` said `0.0.1`. Now read from package.json. Test:
  `apps/web/src/shell/HelpMenu.test.tsx` "names the package.json version and links to the Releases page".
- **(new, fixed)** The Android shell could not have reached any server: `APP_SHELL_ORIGINS` lacked
  `https://localhost`. Test: `packages/server/src/graphs/mount.test.ts` "answers the Android shell's
  preflight too".
- **(new, believed fixed, unverified)** `apps/desktop/build-sidecar.mjs` could not have worked on
  Windows: `spawnSync("pnpm")` without a shell (pnpm.cmd), esbuild.exe looked up under `bin/`, zip
  extracted with `unzip`. Fixed by reading; no Windows machine here, first real test is the Windows CI job.
- **B-686, B-687, B-690 → fixed** in `a1e9a0a` (ci.yml installs WebKit too; traces uploaded from
  `e2e/test-results/`; `apps/desktop` `build` runs `build-sidecar.mjs` first). No automated test:
  CI config; B-690 checked by reading. **B-689** (stale `capacitor.config.ts` comment) → fixed by
  `822be67`'s rewrite of that comment.
- **(new, fixed)** `e2e/tests/help.spec.ts` pinned "nooklet 0.1.0", the stale literal's value; it
  now reads `apps/web/package.json`. Would have failed on every release that was not 0.1.0.
- **(new, open)** The server reports version `0.0.1` to MCP clients (`mcp/server.ts` default; `cli.ts`
  never passes one) and has no `nooklet --version`. Not touched (out of scope).
