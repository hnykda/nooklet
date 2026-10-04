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
- [ ] Docs: RELEASING.md, getting-started, self-hosting, README platform table, issue template
- [ ] Verification (see below)

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
- **(new, open)** The server reports version `0.0.1` to MCP clients (`mcp/server.ts` default; `cli.ts`
  never passes one) and has no `nooklet --version`. Not touched (out of scope).
