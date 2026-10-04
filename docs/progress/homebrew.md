# Homebrew tap — progress

Task: prepare `hnykda/homebrew-nooklet` (contents in `packaging/homebrew/`), automation that bumps
the cask on each release, and docs. Nothing is pushed or created on GitHub by this task.

## Status: done, awaiting review + the coordinator's tap creation (RELEASING.md, "Homebrew tap")

- `packaging/homebrew/README.md`, `packaging/homebrew/Casks/nooklet.rb`: exactly what the tap holds
  (the release workflow stamps `version` + both `sha256`; the repo copy keeps placeholders).
- `tools/ci/homebrew-cask.mjs` + `tools/homebrew-cask.test.mjs` (3 tests; checks the real cask and
  the real dmg naming in `desktop-bundle.sh`/`release.yml`).
- `.github/workflows/homebrew-tap.yml` (workflow_call / release: published / workflow_dispatch),
  `release.yml` job `homebrew`. actionlint (with shellcheck, `rhysd/actionlint` image): clean.
- RELEASING.md "Homebrew tap" (secret `HOMEBREW_TAP_TOKEN`, token steps, creating the tap), README
  install lines + platform table, `docs/guide/getting-started.md` "Homebrew (macOS)".

## Homebrew policy (researched 2026-10-04, local Homebrew 7.0.7)

- 5.0.0 (2025-11-12, https://brew.sh/2025/11/12/homebrew-5.0.0/): "`--no-quarantine` and
  `--quarantine` flags have been deprecated as Homebrew does not wish to easily provide
  circumvention to macOS security features"; "Casks without codesigning are deprecated"; homebrew/cask
  casks failing Gatekeeper disabled September 2026. In 7.0.7 `brew install --help` no longer lists
  `--no-quarantine`.
- 6.0.0 (https://brew.sh/2026/06/11/homebrew-6.0.0/): Gatekeeper disabling "remain[s] on track";
  new **tap trust**. Verified in 7.0.7's `trust.rb`: a cask named on the command line
  (`brew install --cask hnykda/nooklet/nooklet`) loads, but untrusted taps are skipped otherwise
  (e.g. `brew upgrade`), hence `brew trust hnykda/nooklet` in the docs.
- 7.0.0 (https://brew.sh/2026/09/13/homebrew-7.0.0/): third-party cask flight blocks
  (`postflight do`) deprecated in favour of `*_steps`, disabled 2027-12-11; Intel macOS Tier 3.
- Third-party taps: "By default, we don't even check signing status on third-party taps"
  (https://github.com/orgs/Homebrew/discussions/6482). So an unsigned cask in our own tap works;
  homebrew/cask is closed to it until notarization.
- Upgrades re-quarantine: 7.0.7 `cask/upgrade.rb#quarantine_release_decision` carries the user's
  approval forward only if the new app matches the old one's designated requirement; an ad-hoc
  signature's requirement is its cdhash, which changes every build. **Believed** (read the code,
  not observed), so the docs say "after every install and upgrade".
- Not done on purpose: stripping quarantine in the cask (`postflight_steps { run "xattr" }`). It
  would work but is the circumvention Homebrew removed, done silently on the user's behalf.

## Validation (2026-10-04)

- `brew style`: no offenses (after `depends_on :macos` and distinct placeholder sha256s).
- `brew audit --cask --new --strict` against the REAL arm64 `.dmg` from the release.yml dry run
  37203229277 (served via a `file://` URL in a throwaway tap `hnykda/nooklet-test`, stamped by
  `homebrew-cask.mjs`; `brew fetch` verified the checksum): only the expected failures —
  `signing` ("Signature verification failed … the software has been altered": unsigned) and
  `github_repository` ("not notable enough"), both homebrew/cask-only criteria — plus
  `livecheck_version` erroring with 404 because no release exists yet. With those three excluded:
  clean. Tap removed with `brew untap`; trust store untouched (`HOMEBREW_NO_REQUIRE_TAP_TRUST`).
- The dmg: `nooklet.app` id `com.nooklet.desktop`, LSMinimumSystemVersion 10.15, sidecar has
  node/server.mjs/vec0.dylib/esbuild/web. The sidecar `node` is the official build (team
  HX7739G8FX, hardened runtime, `disable-library-validation`), so it can load the unsigned
  vec0.dylib.
- `command_wrapper`: simulated (not installed — the owner's app must not be touched). Built the
  sidecar, laid it out as `nooklet.app/Contents/Resources/sidecar`, wrote the exact env script
  Homebrew's `Pathname#write_env_script` produces, ran it from `/`: `graph create`, `graph list`,
  `serve` (web client served), `embed status` → `sqlite-vec: loaded (v0.1.9)`.

## Still unverified

- The tap workflow has never run (needs the tap repo + secret). actionlint/shellcheck only.
- A real `brew install --cask` / `upgrade` / `uninstall --zap` of this cask; the Gatekeeper
  dialog wording on the current macOS; whether a quarantined `vec0.dylib` loads before `xattr`.
- The Intel `.dmg` (that dry-run job had not finished; same naming, tested by the unit test).

## Decisions

- No `Formula/nooklet.rb` for 0.1.0. The cask's `command_wrapper` exposes the app's bundled server
  as `nooklet` (zero new artifacts, same Node the app ships, verified above).
- Release workflow publishes with `GITHUB_TOKEN`, which does NOT fire `release: published`
  (https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow),
  so release.yml calls the tap workflow; `release: published` covers a human publishing a kept
  draft; `workflow_dispatch` re-runs. Prereleases skipped; never downgrades the tap.
- Zap never touches `~/.nooklet` (all graphs) nor the pre-0.1.0 dev graph in
  `~/Library/Application Support/com.nooklet.desktop/graph` (only named files + `rmdir`);
  everything goes to the Trash (`trash:`), since WebKit storage can hold unsynced edits of a
  remote graph.

## Follow-ups (not done)

1. **Standalone `nooklet` formula** (Linux + servers without the app). Needs a new release artifact
   per platform: `build-sidecar.mjs` output minus `node` (server.mjs, vec0.{dylib,so}, esbuild,
   web/, plugins/, host-modules/) as `nooklet-server-X.Y.Z-<os>-<arch>.tar.gz`, then a formula with
   `depends_on "node"` and the same env wrapper. Open questions: Homebrew's `node` is built with
   `--shared-sqlite`; does `node:sqlite` there allow `loadExtension` (ADR 014)? Homebrew's node is
   the latest major, so the formula would ride whatever Node ships next. Probe both before shipping.
2. **Ad-hoc sign the whole bundle** (`bundle.macOS.signingIdentity: "-"` in tauri.conf.json, or
   `codesign --force --deep -s -` in desktop-bundle.sh). The CI app is only linker-signed: `spctl`
   says "code has no resources but signature indicates they must be present", which is the
   "damaged" verdict that offers no "Open Anyway". Believed to turn it into "cannot be verified" +
   Open Anyway; unverified.
3. **homebrew/cask submission** once notarized (and the repo passes the notability bar: 30 forks,
   30 watchers or 75 stars).

## Findings for the coordinator (not logged in BUGS.md by this task)

- `server.mjs` run from the sidecar without `--web` does not find `sidecar/web`
  (`resolveWebClientDir` looks at `../web` and `../../web` relative to the bundle, not `./web`):
  `app not served`. The desktop app passes `--web`, so it is invisible there; the cask's wrapper
  sets `NOOKLET_WEB_DIR`. Reproduced 2026-10-04 by running `sidecar/node sidecar/server.mjs serve`
  from `/`.
- Follow-up 2 above (linker-signed bundle → "damaged").
