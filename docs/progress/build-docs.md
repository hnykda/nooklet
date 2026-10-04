# Progress: build documentation

Goal: two guide pages, `docs/guide/building.md` (toolchain, every build command, test layers,
CI, troubleshooting) and `docs/guide/ios-from-source.md` (iPhone install for a person with a Mac
and a free Apple ID), linked from README and getting-started. Branch: this worktree's branch,
based on `c536cad`. Not merged, not pushed.

## Status

- [x] Sources read: progress files (real-device-test, mobile-ios, desktop-remote-mode, pairing),
      root and package `package.json`s, `build-sidecar.mjs`, `tauri.conf.json`,
      `capacitor.config.ts`, `vite.config.ts`, `e2e/playwright.config.ts`, `e2e/global-setup.ts`,
      `tools/`, `.github/workflows/`, `.woodpecker/`, `deploy/README.md`, `apps/site/README.md`,
      BUGS B-580, B-598, B-607, B-615, B-638, B-639.
- [x] Commands run on a scratch data dir (ports 6485): see "Verified" below.
- [x] Pages written: `docs/guide/building.md` (order 10), `docs/guide/ios-from-source.md` (order 7)
- [x] README ("Build from source" section + two Documentation entries) and one link line each in
      getting-started's "Install from source" and "The iOS app". Guide order is now: what-is 1,
      features 2, how-it-works 3, sync 4, getting-started 5, self-hosting 6, iOS 7, security 8
      (was 7), agents 9 (was 8), building 10, faq 11 (was 9).
- [x] Site build, biome, leak-check (see Verified)
- No screenshots: no scratch GUI session for Xcode/Settings was available, and the steps read
  fine as text.

## Verified (2026-10-04, this worktree)

- `pnpm install --frozen-lockfile` OK. `pnpm --filter @nooklet/web build` OK, 13 s, writes
  `apps/web/dist/` (index.html, `static/`, `sw.js`).
- `pnpm nooklet serve --data <tmp>/fresh --port 6485` on a data dir that did not exist: starts,
  mints a root token, `/healthz` OK, `/g/default/` 200 serving `apps/web/dist`, CORS preflight
  from `capacitor://localhost` answered. `token create --link` prints the pairing link.
  `verify` prints OK.
- A second `serve` on the same port: dies with Node's raw `EADDRINUSE` stack trace (finding F1).
- `pnpm -r typecheck` clean.
- `pnpm ios:sync` OK (Xcode 27.0 present); `git status` clean afterwards (it rewrites
  `Package.swift` and `public/`, both unchanged/ignored). `xcodebuild -sdk iphonesimulator build`
  into a scratch DerivedData: BUILD SUCCEEDED.
- `pnpm --filter @nooklet/desktop run sidecar` OK, 21 s with Node cached: 169 MB under
  `apps/desktop/sidecar/`, Node 139 MB of it. It rebuilds `apps/web/dist` itself.
- `pnpm desktop:build --bundles app` OK (Rust 1.98.1): `nooklet.app` 167 MB under
  `apps/desktop/src-tauri/target/release/bundle/macos/`. `desktop:install` not run (it replaces
  `/Applications/nooklet.app`).
- `pnpm e2e --list`: 779 tests in 148 files. `NOOKLET_E2E_PORT=6486 pnpm e2e --project=webkit
  phone-ui.spec.ts`: 8 passed.
- `pnpm --filter @nooklet/site build` OK; both pages in `out/docs/`, in the sidebar of every page
  (between self-hosting/security and agents/faq), in `search-index.json`; every in-page and
  cross-page anchor the guides use exists in the built HTML.
- `pnpm exec biome check . --diagnostic-level=error` clean (1279 files); `leak-check --tree` clean.

## Findings (fold into BUGS.md; not logged there by this agent to avoid B-number collisions with
## the parallel agents)

- F1. `nooklet serve` on a port already in use prints an unhandled `EADDRINUSE` stack trace
  instead of a one-line message naming the port and `--port`.
- F2. CI (`.github/workflows/ci.yml`) installs only Chromium, but `pnpm e2e` runs the `webkit`
  project too. Expected to fail those specs with "Executable doesn't exist" unless CI runs WebKit
  elsewhere. Not checked against a real CI run.
- F3. `apps/web/capacitor.config.ts`'s doc comment says the repo does not check in `ios/`; it does
  (`apps/web/ios/`, since the M5 work).
- F4. `apps/web/ios/App/App.xcodeproj/project.pbxproj` carries a `DEVELOPMENT_TEAM` value from
  the owner's signing. Anyone building sees someone else's team preselected and must change it;
  a fork that commits its own does the same to the next person. The iOS guide tells readers not
  to commit theirs.
- F5. Root `pnpm build` is `pnpm -r build`, which includes `@nooklet/desktop`'s `build`
  (`tauri build`, without the sidecar step) and the site. Nothing documents it and it is not the
  way to build any single target.
- F6. Every client build (`vite build`, `ios:sync`, `desktop` sidecar step, `pnpm e2e`'s global
  setup) rewrites `apps/web/dist`, which a running `nooklet serve` from the checkout serves live
  (B-639). The guides say so; a fix would be `serve` snapshotting the dir.

- F7. `ci.yml` uploads `playwright-report/` and `test-results/` from the repo root on failure, but
  the Playwright config writes to `e2e/test-results/<port>/` (and the CI reporter is `list`, so no
  HTML report). The upload likely finds nothing. Not checked against a real CI run.

## For the releases agent (cross-links)

- `docs/guide/building.md` links `RELEASING.md` (CI paragraph; the site turns it into a GitHub
  `blob/main` URL, which 404s until RELEASING.md is on main) and the GitHub Releases page.
  When RELEASING.md lands, it could link back to `docs/guide/building.md` for local builds.
- README's "Platform support" table (theirs) could point "build from source" rows at
  `docs/guide/building.md` and `docs/guide/ios-from-source.md`.
- I added one link line to `getting-started.md` (iOS section) and one to README's Quick start
  area; no other edits to their sections.

## How to resume

Scratch data dir: a `mktemp -d` under `/var/folders`; no server left running. Pages under
`docs/guide/`. Run `pnpm --filter @nooklet/site build`, then grep `apps/site/out/search-index.json`
for the new slugs.
