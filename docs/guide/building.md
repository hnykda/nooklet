---
title: Building from source and the toolchain
description: The toolchain, the monorepo map, every build command and what it produces, the test layers, CI, and fixes for the build problems people have hit.
order: 10
---

# Building from source and the toolchain

This page is for working on nooklet or building one of its apps yourself. To run a released
build, use the [Releases page](https://github.com/hnykda/nooklet/releases) and
[Getting started](getting-started.md). To put the iOS app on your own phone, follow
[Build and install nooklet on your iPhone](ios-from-source.md).

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node | 24 or newer (`engines` in `package.json`; CI and development use 26) | everything |
| pnpm | 12 (`packageManager` pins `pnpm@12.3.4`; `corepack enable` picks it up) | everything |
| git | any recent | cloning; the pre-commit hook |
| Rust | stable, 1.77 or newer (`rust-version` in `apps/desktop/src-tauri/Cargo.toml`), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS | the desktop app |
| Xcode | full Xcode from the App Store, not only the Command Line Tools. Last checked with Xcode 27.0; the app targets iOS 15 and later | the iOS app |
| Docker with `buildx` | any recent | the server and site images (optional) |

The iOS project resolves its native dependencies with Swift Package Manager. You do not need
CocoaPods.

```sh
git clone https://github.com/hnykda/nooklet.git
cd nooklet
pnpm install --frozen-lockfile
git config core.hooksPath tools/git-hooks    # once per clone, if you will commit
```

## The monorepo

| Path | What it is | Depends on |
|---|---|---|
| `packages/core` | Data model, outline parser and serializer, op log, `applyOps`, queries. Platform-free apart from one Node SQLite driver behind the `SqlDriver` interface. | nothing in the repo |
| `packages/plugin-api` | The types plugin authors compile against. | `core` |
| `packages/server` | SQLite store, sync, HTTP API, MCP server, importer, markdown mirror, embeddings, and the `nooklet` CLI. | `core`, `plugin-api` |
| `apps/web` | The client (Solid, SQLite WASM in a worker). The browser, the desktop window and the iOS app all show this build. Also holds the Capacitor config and the Xcode project in `apps/web/ios/`. | `core`, `plugin-api` (and `server` for its tests) |
| `apps/desktop` | The Tauri shell for macOS (Linux and Windows best-effort), with a bundled server called the sidecar. | bundles `server`, `web` and `plugins` at build time |
| `apps/site` | The public site: a Next.js static export that renders `docs/guide` and `docs/adr`. | reads `docs/` |
| `plugins/*` | Built-in plugins: mermaid, word-count, daily-summary. Workspace members so each declares its own dependencies. | `plugin-api` |
| `e2e` | Playwright tests against a real `nooklet serve` and a production build of the client. | `server`, `web` |
| `tools` | `leak-check.mjs`, the git hook, CI shell scripts in `tools/ci/`, and `tools/probes/`. | |
| `deploy` | The server and site Dockerfiles and an example Helm chart. See `deploy/README.md`. | |

The three packages have no build step. They export their TypeScript sources directly
(`"exports": "./src/index.ts"`), the server runs through `tsx`, and the apps compile what they
import. A change in `packages/core` reaches the server on its next start and the client on its
next build.

## Build commands

All commands run from the repository root.

| Command | Produces | Notes |
|---|---|---|
| `pnpm --filter @nooklet/web build` | `apps/web/dist/` | The client, with its service worker. About 15 seconds. |
| `pnpm nooklet serve` | a running server | No build; `tsx` runs the source. Serves `apps/web/dist` if it exists. |
| `docker buildx build --platform linux/amd64 -f deploy/docker/Dockerfile -t nooklet:dev .` | the server image | Self-contained, no `node_modules`. |
| `pnpm desktop` | a development run of the desktop app | Rebuilds the sidecar first. |
| `pnpm desktop:build` | `nooklet.app` and a `.dmg` under `apps/desktop/src-tauri/target/release/bundle/` | Rebuilds the sidecar first. |
| `pnpm desktop:install` | `/Applications/nooklet.app` | `desktop:build --bundles app`, then replaces the copy in `/Applications`. macOS only. |
| `pnpm ios:sync` | `apps/web/ios/App/App/public/` | Builds the client and copies it into the Xcode project. |
| `pnpm ios:open` | | Opens `apps/web/ios/App/App.xcodeproj` in Xcode. `pnpm ios` runs both. |
| `pnpm --filter @nooklet/site build` | `apps/site/out/` | The static site. |

The root `pnpm build` runs every package's `build` script, including a bare `tauri build` without
the sidecar step. Use the specific commands above instead.

### The web client and the server

`pnpm --filter @nooklet/web build` runs Vite and writes `apps/web/dist/`. Hashed files go under
`dist/static/`, because the server already uses `/assets/*` for a graph's attachments.

`pnpm nooklet <command>` runs the CLI from source with `packages/server` as its working directory,
so give it absolute paths. `serve` looks for the client in `--web <dir>`, then `$NOOKLET_WEB_DIR`,
then `apps/web/dist` in this checkout, and serves it at `/g/<graph>/`. Without a built client it
serves only the API. Its defaults are port 6100 and the data directory `~/.nooklet/default` (or
`$NOOKLET_DATA`). `pnpm nooklet --help` lists every command.

The server reads `apps/web/dist` from disk on every request. If you rebuild the client while a
server serves it, a page that loads mid-build gets an `index.html` whose scripts the build has
deleted, and shows a white screen until you reload (B-639). These commands all rebuild that folder:
`pnpm --filter @nooklet/web build`, `pnpm ios:sync`, `pnpm desktop`, `pnpm desktop:build` and
`pnpm e2e`. Finish the build, then reload. Avoid building while you test against a server from the
same checkout.

`pnpm --filter @nooklet/web dev` starts Vite's dev server. The production build served by
`nooklet serve` is the combination that ships, and the one the e2e suite tests.

The Docker image runs the desktop app's own bundler (`apps/desktop/build-sidecar.mjs`) on Linux
and copies the result into `debian:bookworm-slim`. `deploy/README.md` covers its flags and the
Helm chart, and [Self-hosting](self-hosting.md) covers running it.

### The desktop app and its sidecar

The desktop app does not read `apps/web/dist`. On startup, `src-tauri/src/main.rs` launches a
server from `apps/desktop/sidecar/`, a directory that `build-sidecar.mjs` assembles and Tauri
ships inside the app:

- `server.mjs`, the server bundled into one file by esbuild
- `node`, the official Node binary for the version running the build, downloaded from nodejs.org
  the first time and cached in `apps/desktop/.cache/` (about 140 MB of the 170 MB total)
- `vec0.dylib` (or `.so`, `.dll`), the sqlite-vec extension for semantic search
- `esbuild`, used at runtime to bundle plugins a user drops into their data directory
- `web/`, a fresh build of the client
- `plugins/` and `host-modules/`, the built-in plugins and the modules user plugins import

`pnpm --filter @nooklet/desktop run sidecar` runs that step alone. `pnpm desktop` and
`pnpm desktop:build` run it before Tauri. Running `tauri dev` or `tauri build` directly skips it,
and the app then serves whatever sidecar was last assembled, however old (B-580).

In local mode the app uses whatever already answers on its port (6100 by default). If a
`nooklet serve` from a checkout is running there, the window shows that server's client and your
rebuilt sidecar never runs. `NOOKLET_PORT` and `NOOKLET_DATA` move the app to another port and
data directory.

### The iOS app

`pnpm ios:sync` builds the client, then runs `cap sync ios` from `apps/web`, which:

- copies `apps/web/dist/` into `apps/web/ios/App/App/public/` (ignored by git)
- writes `ios/App/App/capacitor.config.json` from `apps/web/capacitor.config.ts`
- rewrites `ios/App/CapApp-SPM/Package.swift` with the Capacitor plugins found in
  `node_modules`. Don't edit it by hand.

Xcode bundles only what is in `public/`. After any change to the client, run `pnpm ios:sync`
before you build in Xcode. `Info.plist` is hand-maintained (the `nooklet://` URL scheme, the local
network usage text) and `cap sync` leaves it alone. Signing, installing on a phone, and connecting
it to a server are in [Build and install nooklet on your iPhone](ios-from-source.md).

### The site

`pnpm --filter @nooklet/site build` writes `apps/site/out/`. It reads every `docs/guide/*.md`,
ordered by the `order` field in the front matter, and the ADRs. `pnpm --filter @nooklet/site dev`
serves it on port 6445 while you edit; `pnpm --filter @nooklet/site serve` serves the built output
on 6446. `apps/site/README.md` has the details.

## Tests

A green unit suite does not show the app works. Six defects, from the client having no API
credential to editing dying after one keystroke, once shipped past 1,180 passing unit tests,
because none of those tests launched a browser against a production build served by a real
server.

| Command | What it runs | When |
|---|---|---|
| `pnpm test` | Vitest in every package; `node --test` for the desktop scripts | Constantly. Fast. |
| `pnpm typecheck` | `tsc --noEmit` everywhere (twice in `apps/web`: app and worker) | Before every commit. |
| `pnpm exec biome check --write .` | Lint and format | Before every commit. `pnpm lint` checks without writing. |
| `pnpm e2e` | Playwright: real browsers against a real `nooklet serve` and a fresh production build | Before you claim a UI change works. |
| `pnpm nooklet verify --data <dir>` | Replays a graph's whole op log and diffs it against live state | After touching sync, ops or the schema. Prints `OK` or the divergence. |
| `node tools/leak-check.mjs --tree` | Scans every tracked file for tokens, home paths, tailnet names and other private shapes | Before you push. |
| `pnpm --filter @nooklet/site e2e` | The site in Chromium at desktop and phone widths | After changing the site. |

**The e2e suite.** Its global setup builds the client, seeds a throwaway data directory and
starts `nooklet serve` on port 6188, or `NOOKLET_E2E_PORT`. It refuses to run when something
already serves nooklet on that port, so it never tests against someone else's data. Install the
browsers once with `pnpm exec playwright install chromium webkit`. The `chromium` project runs
every spec. The `webkit` project runs a short list of specs where the engine matters: the storage
fallback, focus and caret behaviour, and the phone UI. Playwright's WebKit has no OPFS inside
workers, so it cannot stand in for the whole app. Run one project or one file with
`pnpm e2e --project=webkit` or `pnpm e2e <name>.spec.ts`. On failure, traces and videos
land in `e2e/test-results/<port>/`.

**The pre-commit hook.** `git config core.hooksPath tools/git-hooks` makes every commit run
`node tools/leak-check.mjs --staged`. The repository is public; the hook stops a token, a home
directory path or a private host name before it reaches history. If you have looked at a finding
and it is a deliberate example, end that line with `leak-check: allow`.

**Probes.** `tools/probes/` keeps the small programs that settled a factual question, such as
`capacitor-network/` for what the iOS WebView can reach or `sidecar-web-freshness.mjs` for B-337.
Re-run one when you doubt the claim it backs.

## CI

GitHub Actions runs `.github/workflows/ci.yml` on every push to `main` and every pull request:
lint, typecheck, unit tests, then the e2e suite in Chromium, with traces uploaded on failure.
Woodpecker runs the leak guard (`tools/ci/leak-guard.sh`, gitleaks plus `leak-check.mjs`) on every
push and pull request, and builds the server and site images from `main` and tags. Tagged versions
build the release packages; [RELEASING.md](../../RELEASING.md) describes how a release
is cut and what it publishes.

## Troubleshooting

### The desktop app shows an old client

The sidecar is stale. Run `pnpm desktop` or `pnpm desktop:build`, which rebuild it, rather than
`tauri dev`/`tauri build` on their own (B-580). If the app still shows old code, check what
answers on its port: `lsof -nP -iTCP:6100 -sTCP:LISTEN`. A `nooklet serve` from a checkout running
there wins over the bundled server.

### A white screen after a rebuild

You rebuilt `apps/web/dist` while a server served it (B-639). Reload once the build finishes. In
the browser's developer tools, 404s on `/static/*.js` confirm it.

### A blank page, or "needs a secure context", over plain `http://`

Browsers grant `crypto.randomUUID`, `navigator.locks` and OPFS only to `https://` pages and to
`http://127.0.0.1`/`http://localhost`. A page loaded from `http://<LAN-IP>` cannot run the client;
it shows a page explaining why (B-615). Use the server machine's loopback address, or serve over
HTTPS (Tailscale gives you a certificate; see [Self-hosting](self-hosting.md)). The iOS app is
different: its page comes from `capacitor://localhost`, so it can talk to a plain `http://` server
on your LAN.

### The iOS app says "Load failed" on every request

Check that the server answers the app's CORS preflight (B-598):

```sh
curl -si -X OPTIONS \
  -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  http://<server>:6100/g/default/api/v1/graph.overview | grep -i access-control-allow-origin
```

It must print `access-control-allow-origin: capacitor://localhost`. No output means the server
predates CORS support or something in between strips the header.

### The port is in use

`nooklet serve` on a busy port exits with Node's `EADDRINUSE` stack trace. Find the other process
with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, or pick another port with `--port`. For the e2e suite,
set `NOOKLET_E2E_PORT` to a free port. The desktop app takes 6100 in local mode, so a server you
start by hand on 6100 collides with it.

### The first run fails

- `ENOENT … root.token` when the `--data` directory does not exist yet: fixed (B-638). On an older
  build, `mkdir -p` the directory first.
- `a graph called "default" already exists` after `import` or `token create` into a fresh
  directory: fixed (B-607). On an older build, run `serve` once before importing.
- `import` says it found no pages, or `--data` lands somewhere odd: `pnpm nooklet` runs inside
  `packages/server`, so relative paths resolve from there. Use absolute paths.

### Desktop build errors that mention another checkout's path

Cargo caches build scripts in `apps/desktop/src-tauri/target/`. A target directory copied or
shared from another checkout can point at paths that no longer exist. Delete the `target`
directory, or set `CARGO_TARGET_DIR` to a fresh one. (`desktop:install` expects the default
location.)

### The sidecar step fails to download Node

`build-sidecar.mjs` fetches the official Node build matching the Node that runs it, once, from
nodejs.org. It needs network access the first time; after that it uses `apps/desktop/.cache/`.
