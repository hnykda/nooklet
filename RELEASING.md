# Releasing nooklet

For the maintainer. One command cuts a release; pushing the tag builds and publishes it.

## The flow

```sh
git switch main && git pull
pnpm release 0.2.0 --dry-run     # everything it would check, change and run; writes nothing
pnpm release 0.2.0               # checks, bumps, CHANGELOG (opens $EDITOR), commit + tag, no push
git show                         # look at it
git push origin main && git push origin v0.2.0
```

`pnpm release` (`tools/release.mjs`):

1. Refuses unless the tree is clean, on `main`, and equal to `origin/main` (it runs a read-only
   `git fetch origin main`), the tag is new, and the version is above the last tag.
2. Runs `pnpm -r typecheck`, `pnpm test`, `biome check --diagnostic-level=error` and
   `node tools/leak-check.mjs --tree`. `--skip-slow` skips the first two.
3. Writes the one version into every `package.json`, `apps/desktop/src-tauri/tauri.conf.json`,
   `Cargo.toml` and `Cargo.lock`, the iOS project (`MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`)
   and the Android project (`versionName`, `versionCode`). The help menu's version comes from
   `apps/web/package.json` at build time, so it follows.
4. Adds a `CHANGELOG.md` section from the commit subjects since the last tag: `feat` and `fix`
   listed, everything else under Other, docs/test/chore only counted. `B-123` ids link to
   `docs/BUGS.md`. It opens `$VISUAL`/`$EDITOR` (or waits for Enter) so you can edit it;
   `--no-edit` skips that. Rewrite it for people: the generated list is raw material.
5. Commits `release: vX.Y.Z`, makes an annotated tag, and prints the push commands. `--push` pushes
   after you type the version to confirm.

Undo before pushing: `git tag -d vX.Y.Z && git reset --hard HEAD~1`.

Build numbers: Android `versionCode` and iOS `CURRENT_PROJECT_VERSION` are
`major*1000000 + minor*1000 + patch` (0.1.0 → 1000). A prerelease (`0.2.0-rc.1`) gets the same number
as its final release, so on Android the final cannot be installed over the rc without uninstalling.
Prerelease tags are marked as prereleases on GitHub and never get the `latest` image tag.

### The first release: 0.1.0

0.1.0, because pre-1.0 is what the README already promises ("breaking changes before 1.0"), and
the desktop app, the plugins and the help menu already said 0.1.0. The first CHANGELOG section
covers the whole history (about 800 commits): replace it in the editor with a short summary.

Before the first tag, test the workflow without releasing anything:

1. Push a branch with this workflow, then on GitHub: Actions → **Release** → **Run workflow** on
   that branch. That is a dry run: every artifact and both image architectures build, nothing is
   pushed or released. The run's summary shows the release notes; the artifacts are downloadable
   from the run page. Fix what fails and run it again.
2. Install what you can from those artifacts: the macOS `.dmg` (with the `xattr` step from
   `docs/guide/getting-started.md`) at least, and the Linux/Windows/Android builds if you have
   the machines.
3. `pnpm release 0.1.0`, push, and watch the run. Then check the published release, the
   `docker pull ghcr.io/hnykda/nooklet:0.1.0`, and the Woodpecker tag pipeline.

After the first GHCR push, open the package's settings on GitHub (your profile → Packages →
nooklet) and set its visibility to **Public**; new packages start private. The image's
`org.opencontainers.image.source` label links it to this repository.

## What runs where

| On a `v*` tag | Where | What |
|---|---|---|
| `meta` | GitHub Actions | Checks the tag equals `apps/web/package.json`'s version; renders the notes (`tools/ci/release-notes.mjs`: a downloads table with each platform's honest status, then the CHANGELOG section). |
| `desktop` | GitHub Actions, native runners | `tools/ci/desktop-bundle.sh`: macOS arm64 `.dmg` (macos-15), macOS x64 `.dmg` (macos-15-intel), Linux `.AppImage` + `.deb` (ubuntu-22.04), Windows NSIS `-setup.exe` (windows-2025). |
| `android` | GitHub Actions | `tools/ci/android-apk.sh`: `nooklet-X.Y.Z-android-experimental.apk`, signed with your keystore, or `…-experimental-debug.apk` without it. |
| `image`, `image-manifest` | GitHub Actions | Server image on native amd64 and arm64 runners, merged into one multi-arch `ghcr.io/hnykda/nooklet` tagged `X.Y.Z`, `vX.Y.Z`, `sha-<8>`, and `latest` for a final release. |
| `release` | GitHub Actions | Creates a **draft** release with every file + `SHA256SUMS` and the notes, then publishes it. It runs only if every job above succeeded. Set the repository variable `RELEASE_KEEP_DRAFT` to `true` to stop at the draft and publish by hand. |
| `homebrew` | GitHub Actions | `homebrew-tap.yml`: copies `packaging/homebrew/` into `hnykda/homebrew-nooklet`, stamps the version and both `.dmg` checksums from `SHA256SUMS`, commits. Final releases only; needs `HOMEBREW_TAP_TOKEN` (below), skips with a warning without it. |
| `images.yaml` | Woodpecker (the home server) | Server and site images for the owner's registry, `linux/amd64` + `linux/arm64`, tagged `sha-<8>`, `vX.Y.Z`, `latest` (final releases). No deploy on tags: deploys follow `main`. |

On `main` nothing above runs except Woodpecker's usual amd64 build and deploy.

The workflow has no `pull_request` trigger, so a fork never runs it or sees its secrets; tags and
manual runs need write access. Each job has only the permissions it needs (`contents: write` only
in `release`, `packages: write` only for the image jobs), and every action is pinned to a commit.
To update a pin: `gh api repos/<owner>/<action>/commits/<tag> --jq .sha`.

### Woodpecker

No new secrets: the tag steps reuse `registry`, `server_image`, `site_image` and
`registry_buildkit_config`, which must already allow the `tag` event (deploy/README.md, "CI and
forks"). The arm64 halves are emulated with QEMU. If they fail with `exec format error`, the build
node lacks binfmt handlers; register them once on that node (for example
`docker run --privileged --rm tonistiigi/binfmt --install arm64`, or the equivalent in the infra
repo). The emulated server build is slow; the step's memory limit is 6Gi. This has not run on the
owner's CI yet.

## Secrets

Add them in GitHub → Settings → Secrets and variables → Actions. Everything works without them;
each group switches its signing on as soon as it exists. Names only:

**Android signing** (sideloaded APK, no Play Store):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 < nooklet-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | the key alias |
| `ANDROID_KEY_PASSWORD` | the key password (if different from the keystore's) |

Make the keystore once and keep it (and its passwords) somewhere backed up. Every future APK must be
signed with the same key, or Android refuses to update the installed app:

```sh
keytool -genkeypair -v -keystore nooklet-release.jks -alias nooklet -keyalg RSA -keysize 4096 \
  -validity 10000 -dname "CN=nooklet"
```

**macOS signing and notarization** (needs the Apple Developer Program):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of a "Developer ID Application" certificate exported as `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | the Apple ID email used for notarization |
| `APPLE_PASSWORD` | an app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | the 10-character team id |

With the first three, `desktop-bundle.sh` imports the certificate into a temporary keychain, signs
the sidecar's `node`, `esbuild` and `vec0.dylib` with the hardened runtime and
`apps/desktop/src-tauri/sidecar.entitlements` (Node needs JIT), and Tauri signs the app. With the
last three as well, Tauri notarizes and staples it. **Unverified:** none of this has run, because
no certificate exists yet. Expect the first signed run to need fixes; the likeliest is a nested
binary notarization rejects, listed in the notarization log.

**iOS / TestFlight (later).** Not wired up. When the Developer Program exists, add a macOS job that
runs `pnpm ios:sync`, then `xcodebuild archive` + `-exportArchive` with an App Store Connect API key,
and uploads with `xcrun altool --upload-app` (or `fastlane pilot`). Secrets it would need:
`APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_P8`
(base64), plus an Apple Distribution certificate (`IOS_DISTRIBUTION_CERTIFICATE`,
`IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`) and a provisioning profile for `sh.nooklet.app`
(`IOS_PROVISIONING_PROFILE`). The bundle id and `nooklet://` URL type are already in the project.

**Windows signing** is not designed yet; the installer is unsigned and SmartScreen warns.

## Homebrew tap

`brew install --cask hnykda/nooklet/nooklet` installs the macOS app from the release's `.dmg`
files. The tap repository, `hnykda/homebrew-nooklet`, is generated: its contents are
`packaging/homebrew/` in this repo (README, `Casks/nooklet.rb`), and every final release copies
that directory over and stamps `version` and the two `sha256` values from the release's own
`SHA256SUMS` (`tools/ci/homebrew-cask.mjs`, tested by `tools/homebrew-cask.test.mjs`). Change the
cask here, never in the tap.

How it runs: `release.yml`'s `homebrew` job calls `.github/workflows/homebrew-tap.yml` right after
publishing. It cannot be triggered by `release: published` instead, because a release published
with `GITHUB_TOKEN` starts no other workflow; the tap workflow does also listen to
`release: published`, which fires when *you* publish a kept draft, and has a **Run workflow**
button taking a tag, for re-running by hand. Prereleases are skipped (the cask follows final
releases), and it never moves the tap to a version older than the one it has.

**Secret: `HOMEBREW_TAP_TOKEN`.** A fine-grained personal access token that can write to the tap
and nothing else:

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** →
   Generate new token.
2. Resource owner: `hnykda`. Expiration: a year at most; put the date in your calendar (an expired
   token makes the job fail after the release is already out, and a re-run fixes it).
3. Repository access: **Only select repositories** → `hnykda/homebrew-nooklet`.
4. Permissions → Repository permissions → **Contents: Read and write**. Nothing else (Metadata:
   read is added automatically).
5. Save it as the Actions secret `HOMEBREW_TAP_TOKEN` in `hnykda/nooklet`.

A deploy key (an SSH key with write access on the tap repository only) would scope it as tightly
and never expire, but `actions/checkout` would then need `ssh-key:` instead of `token:`; the PAT
keeps the workflow simpler.

**Creating the tap (once, after the first release exists):**

1. Create the public repository `hnykda/homebrew-nooklet` **with** "Add a README file" ticked, so
   it has a `main` branch for the workflow to check out (the workflow overwrites that README).
2. Create the token and the secret above.
3. Actions → **Homebrew tap** → Run workflow, tag `v0.1.0`. It checks out the tap, copies
   `packaging/homebrew/` in, stamps it, and pushes the first commit. (With the secret in place
   before the tag, `release.yml` does this itself.)
4. Check it from a clean shell: `brew info --cask hnykda/nooklet/nooklet` shows 0.1.0; then
   `brew fetch --cask hnykda/nooklet/nooklet` downloads the `.dmg` and verifies its checksum
   without installing.

**Unsigned.** Homebrew deprecated unsigned casks in 5.0.0 and disables those in homebrew/cask that
fail Gatekeeper from September 2026; third-party taps are not checked, which is why this is a tap
and not a homebrew/cask submission. Users clear the quarantine themselves after each install and
upgrade (`packaging/homebrew/README.md` has the commands and sources). Once macOS signing and
notarization exist (Secrets above), the caveat can go, and a homebrew/cask submission becomes
possible.

## Auto-update (designed, off)

Today the help menu shows the version and links to the Releases page. Tauri's updater plugin can
do better, but it needs:

1. A key pair from `pnpm --filter @nooklet/desktop exec tauri signer generate -w ~/.tauri/nooklet.key`.
   The public key goes in `tauri.conf.json` (`plugins.updater.pubkey`); the private key and its
   password become secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
   which `tauri build` reads to sign each bundle's update archive (`.app.tar.gz`, AppImage, NSIS).
2. `bundle.createUpdaterArtifacts: true`, the `tauri-plugin-updater` crate and JS package, and
   `plugins.updater.endpoints` pointing at
   `https://github.com/hnykda/nooklet/releases/latest/download/latest.json`.
3. A step in the `release` job that writes `latest.json` (version, notes, per-platform URL +
   signature) and attaches it.
4. A "Check for updates" action in the app that calls the plugin and asks before installing.

It stays off until macOS signing exists: an updater that replaces an unsigned app re-triggers the
quarantine problem on every update, and losing the updater key means no installed app can ever
update again, so it should be created once, deliberately, and backed up with the Android keystore.

## Rolling back a bad release

- **Not yet published** (the run failed, or `RELEASE_KEEP_DRAFT`): delete the draft on the Releases
  page. Delete the tag if you will re-cut the same version:
  `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`, fix, and release again.
- **Published, broken**: do not reuse the version. Mark the release as a pre-release or edit its
  notes to say "broken, use X.Y.Z+1", then release a patch version with the fix (or a revert).
  Deleting a published release breaks links people already have, and GHCR tags others may have pulled.
- **The `latest` image**: point it back at the last good version:
  `docker buildx imagetools create -t ghcr.io/hnykda/nooklet:latest ghcr.io/hnykda/nooklet:<good>`.
  The owner's registry: same with its name. Version tags are never moved.
- **The home deployment** pins `sha-<8>` tags and follows `main`, not tags, so it is rolled back the
  usual way: revert on `main`, or set the previous `sha-` tag in the infra repo.
- **Data:** releases only ever add schema (migrations add tables and columns), and an older build
  refuses newer data rather than damaging it. Going back a version that migrated the schema
  means restoring the backup taken before the upgrade (docs/guide/self-hosting.md, "Upgrades").
- **Android:** a bad APK can be replaced by a higher `versionCode` only; users of a debug-signed APK
  must uninstall (losing local data) to move to a signed one.

## Why not a universal macOS app

The app ships its own server: `apps/desktop/build-sidecar.mjs` copies the building machine's
official Node binary, esbuild binary and sqlite-vec library. A universal app would need all three
merged with `lipo` from two builds, plus the Rust shell built for both targets. Two native `.dmg`
files cost nothing to build on GitHub's runners and avoid that.
