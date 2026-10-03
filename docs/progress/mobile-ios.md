# Progress — mobile-ios (M5)

Picking up where M5 left off: ADR 005 and `platform/capacitor.ts`/`capacitor.config.ts` were
written and typecheck, but "has never run on a device" (`docs/PLAN.md`). This session's goal was
the next concrete step: actually generate the native iOS project and get as far toward "runs" as
this machine's tooling allows.

## Environment (verified, not assumed)

- `xcode-select -p` → `/Library/Developer/CommandLineTools` — no full `Xcode.app` installed.
- `xcodebuild -project apps/web/ios/App/App.xcodeproj -scheme App -showBuildSettings` fails:
  "xcodebuild requires Xcode, but active developer directory ... is a command line tools instance."
- `pod` is not on PATH (no CocoaPods) — turned out not to matter (see below).
- Confirms `apps/web/README.md`'s existing "no Xcode/Android Studio/CocoaPods/JDK" note was still
  accurate; this is the hard boundary for what could be done in this session.

## Done (first session; committed 2026-10-03 with the rest of the 2026-09-14..16 work)

1. Added `@capacitor/ios@8.5.1` to `apps/web/package.json` devDependencies (matches the pinned
   `@capacitor/*` versions already in the repo), `pnpm install`.
2. `pnpm --filter @nooklet/web build` (needed for `webDir: "dist"`), then `npx cap add ios` from
   `apps/web/` — **succeeded**. Capacitor 8 uses Swift Package Manager for native deps, not
   CocoaPods, so the missing `pod` binary never came up. Generated `apps/web/ios/` (real
   `App.xcodeproj`, `CapApp-SPM/Package.swift` listing all 6 `@capacitor/*`/`@capacitor-community/*`
   plugins, default placeholder icons/launch screens).
3. `npx cap sync ios` — succeeded, rewrites `Package.swift` and copies `dist/` into
   `ios/App/App/public` (gitignored).
4. Added a `CFBundleURLTypes` entry (scheme `nooklet`, matching `capacitor.config.ts`'s
   `appId: sh.nooklet.app`) to `ios/App/App/Info.plist` by hand — confirmed `cap sync` does not
   touch this file, so the edit is stable across resyncs. This was README item 3 on the "what a
   human must run" list; now done for iOS (Android's manifest intent-filter equivalent is not).
5. Root `package.json`: `ios:sync` (`pnpm --filter @nooklet/web build && ... cap sync ios`),
   `ios:open` (`... cap open ios`), `ios` (both). `pnpm ios:sync` verified to run clean from repo
   root. `ios:open` is **not** verified — `cap open` shells out to macOS `open` on the `.xcodeproj`,
   which needs `Xcode.app` registered as a handler.
6. `git add -n apps/web/ios/` → 20 files (~tens of KB; the 11 MB `public/` copy is gitignored),
   matching Capacitor's own convention (and this repo's, per the desktop Tauri project) of
   committing the generated native project.
7. Updated `apps/web/README.md`'s Capacitor section (both "what a human must run" and the manual-
   verification list) and `docs/PLAN.md`'s M5 row to reflect exactly what's verified vs. not.
8. `pnpm --filter @nooklet/web typecheck` clean after the dependency add.
9. **Closed the server-URL gap this raised**: every fetch was relative, which only resolves against
   `capacitor://localhost` under Capacitor — meaning the app as generated above could load but could
   never reach any real server. Added `storedServerUrl`/`setStoredServerUrl` to `data/bootstrap.ts`
   (`apiBaseUrl()` now checks the stored value before the build-time env vars), and a "Server
   address" field to `ConnectView.tsx` shown only when `platform.name === "capacitor"` — verified
   live against the entered address before either it or the token is stored, web/PWA path unchanged.
   `sync/http-transport.ts`'s WS URL was already `baseUrl`-derived, not `location`-derived, so it
   needed no fix. New tests `data/bootstrap.test.ts`, `views/ConnectView.test.tsx`; full web suite
   1313/1313 passing, typecheck and biome clean. Details in `apps/web/README.md`'s Capacitor section
   item 3. Not verified end to end against a real server from a real device/simulator.

## First real launch (2026-09-14, after the owner installed full Xcode + iOS Simulator)

This environment's earlier limitation lifted mid-session: the owner installed Xcode 26.6 and the
iOS 26.5 Simulator runtime. First-ever verification beyond the CLI layer:

- `xcodebuild -sdk iphonesimulator build` — **succeeds**, no code signing needed for Simulator
  ("Sign to Run Locally"), no CocoaPods needed (confirmed again: SPM resolves cleanly, including
  fetching `capacitor-swift-pm`/`SQLCipher`/`ZIPFoundation` straight from GitHub).
- Installed and launched on iPhone 17 (iOS 26.5) via `xcrun simctl install`/`launch` — the WKWebView
  loads `index.html` from `App/App/public` and the SolidJS app boots and renders correctly. This is
  the first time any part of this app has run on any device or simulator.
- **B-562** (found on this first launch, fixed same session): `ConnectView`'s heading was obscured
  by the status bar/Dynamic Island — it renders outside `AppShell` so never got `--sat` safe-area
  padding. One-line CSS fix in `connect.css`, verified by re-screenshotting.
- **B-563** (owner feedback on this first launch): the address+token form read as "syncing is
  mandatory." Added a choice screen (just this device / sync with a server, `Smartphone`/`Server`
  icons from `lucide-solid`) shown before the form whenever a skip path exists — `ConnectView.tsx`,
  `connect.css`, 4 new tests in `ConnectView.test.tsx`. Verified both in tests and visually on the
  Simulator.
- The B-561-session server-URL field (`storedServerUrl`/`apiBaseUrl`) was also confirmed live in the
  real WKWebView for the first time here (previously jsdom-only) — the "Server address" field
  renders correctly once "Sync with a server" is chosen.
- Still not exercised even now: actually completing a connect (needs a real reachable server), any
  `@capacitor/*` plugin call (keyboard, haptics, share, deep link) reaching its native bridge, and
  anything on a physical device rather than Simulator.

## B-569: the real "Just this device" bug, found and fixed on the actual Simulator (2026-09-14)

B-566's timeout fix (above) was a real improvement but didn't fix what the owner still saw:
"Just this device" → journal bullet stuck on "Loading…" forever, sidebar never populated. The
actual cause only showed up by instrumenting the running app (a temporary on-screen debug log,
since neither Xcode nor the system log surfaces this WKWebView's JS console — screenshotted a
fresh Simulator launch to read it) and reading the real exception: `sync-client.ts#bootstrap()`
and `http-transport.ts`'s `connectLive()`/`wsUrl()` both throw `SyntaxError: The string did not
match the expected pattern.` near-instantly — a synchronous crash, not a hang — because resolving
a relative `URL()` against a dedicated Worker's own `self.location` doesn't behave the way it does
on web/PWA when that worker is loaded from Capacitor's `capacitor://` scheme. `WorkerDb.start()`
only wrapped `bootstrap()` in `try/catch`; the uncaught throw from `connectLive()` right after it
made `start()` itself reject, which permanently poisons `db.worker.ts`'s cached `dbPromise` —
every later worker call (page tree, journal stream, the sidebar's queries) rejects forever, and
with no `ErrorBoundary` anywhere in the app, the UI just freezes on its first "Loading…" state.

Fixed in `db/worker-core.ts` (wrap `connectLive()`/`pull()` in `start()` with the same tolerance
`bootstrap()` already had) and `sync/http-transport.ts` (guard `connect()`'s own
`new WebSocket(wsUrl())`, since reconnect attempts call it again from a bare `setTimeout`). Two
new unit tests in `db/worker-core.test.ts` reproduce the exact exception via a fake transport.
**Verified on the real Simulator, not just in tests**: fresh install → "Just this device" →
sidebar populated (Command palette, Journals, Pages, Tasks, Search, Graph, Trash all present) and
the Pages view showed real content, confirmed by the owner ("yeah, works fine!") and independently
screenshotted. Full details: `docs/BUGS.md` B-569.

## Storage durability: Options A/B/C implemented (2026-09-15)

Following up on B-573 (local-only mode has no eviction backstop): the owner asked what other apps
do, ruled out the async-`SqlDriver` rewrite (E) and the `wa-sqlite` IndexedDB VFS (D, verified from
source to be fundamentally async, not a sync-preserving alternative) via
`docs/proposals/004-capacitor-storage-durability.md`, then asked for A + B + C, explicitly ruling
user-initiated storage clearing and app uninstall out of scope ("that's their mistake... it's
fine").

Implemented: the real `navigator.storage.persist()` call (A); `db/reopen-on-resume.ts`, a generic
one-retry-after-`resume` wrapper now used by every `db.worker.ts` API method (B); and
`db/capacitor-checkpoint.ts` (new `@capacitor/filesystem@8.1.3` dependency) — a debounced periodic
export of the live SQLite bytes to native app-sandbox storage, restored on startup only into a pool
with nothing under the replica's filename yet (C). Full detail and exact file list in `docs/BUGS.md`
B-573.

**Verified**: `pnpm --filter @nooklet/web typecheck`/`test` clean (1336 tests, 15 new across three
test files), `biome check` clean, a full rebuild + `cap sync ios` + Xcode build + Simulator
install/launch with `@capacitor/filesystem` newly bundled — the app boots and renders the "Set up
this device" screen correctly (screenshotted; a first blank screenshot right after boot was cold-
start lag on a freshly-booted simulator, not a real problem — a second screenshot 5s later showed
the app rendered fine). This proves the new dependency and the checkpoint-read-before-`init()` path
don't break startup.

**Not verified, and cannot be from here**: the actual OPFS-closes-on-backgrounding failure B exists
to catch (needs a real background/resume cycle on a device or simulator — no tap/backgrounding
automation exists in this environment, confirmed repeatedly this session), and a real eviction-then-
restore cycle for C. Whoever picks this up on a real device: background the app for a while (or use
Simulator's own memory-pressure/background simulation if it has one), resume, confirm the app is
still responsive rather than stuck on "Loading…"; separately, to test C's restore path, would need
to actually clear the app's OPFS storage (e.g. via Safari's Web Inspector storage panel attached to
the Simulator, if that's reachable) while leaving the rest of the app sandbox intact, then relaunch
and confirm the checkpoint restores rather than starting fresh.

## Not done / explicitly still open

(Rewritten 2026-10-03. The earlier version of this list predated the first Simulator launch and
said nothing past `cap sync` had run, which the sections above had already made untrue.)

- **Verified on the Simulator**: Xcode build, SPM resolution, launch, the app booting, "Just this
  device" working end to end (B-569), the Server address field rendering, and startup with
  `@capacitor/filesystem` bundled (B-573's checkpoint read).
- **Still unverified**: any physical device; any `@capacitor/*` plugin call (keyboard, haptics,
  share, app/deep link) reaching its native bridge; actually completing a connect to a reachable
  server from the Simulator; a real background/resume cycle (B-573 option B) and a real
  eviction-then-restore (option C); ADR 025's graph switcher on the Simulator (its M7, see
  `docs/progress/multi-graph-hosting.md`).
- Android: no `@capacitor/android` dependency, no `npx cap add android`, nothing generated.
- Share-sheet *receiving* (Share Extension + App Group) — native-project work, not attempted.
- App icons/launch screens are Capacitor's stock placeholders; signing and the privacy manifest are
  untouched (both flagged in the README as a "1–2 days the first time" budget item).
- `ios/App/CapApp-SPM/Package.swift` embeds paths into `node_modules/.pnpm/...` (pnpm's content-
  addressable store). This is expected — `cap sync ios` rewrites the file after any dependency
  change — but is worth knowing before ever hand-editing it (don't; it says so at the top).

## How to resume

`pnpm ios:sync`, then `cd apps/web/ios/App && xcodebuild -sdk iphonesimulator build` (or open
`App.xcodeproj` in Xcode and Run), then `xcrun simctl install`/`launch` on a booted simulator — the
WKWebView's JS console is not visible from Xcode or the system log, so B-569's on-screen debug log
trick is how to read exceptions. Next checks, in order of worth: the graph switcher (ADR 025 M7),
a connect to a real `nooklet serve` reachable from the Simulator, the keyboard inset (`--kb` via
`@capacitor/keyboard`), `nooklet://test` from Safari reaching `platform/capacitor.ts`'s `onOpen`,
and a background/resume cycle. Log whatever happens, pass or fail, in `docs/BUGS.md`.
