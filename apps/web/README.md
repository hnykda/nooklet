# @nooklet/web

M2 client foundation: Vite 8 + SolidJS 1.9 app shell, a SQLite-WASM/OPFS replica running in a
worker, the sync client (ADR 003), a `platform` adapter (ADR 005), and the one reactive data seam
every other client feature (editor, views, command palette) is meant to build on. This package
does **not** implement the editor, page/journal views, search UI, or the command palette — see the
`TODO(views)` markers in `src/routes/*.tsx`.

## Architecture at a glance

```
main.tsx ─┬─ App.tsx (router: /journals, /page/:id, /search — TODO(views) placeholders)
          │     └─ shell/AppShell.tsx (fixed shell, single scroll container, --kb, safe areas)
          │
          ├─ data/store.ts  ◄── THE SEAM: usePageTree/useJournalStream/applyOps/useSyncStatus
          │     └─ db/client.ts (Comlink.wrap, platform.lifecycle wiring)
          │           │  postMessage (async, structured-clone)
          │           ▼
          │     db/db.worker.ts  (Worker, WebWorker lib)
          │           └─ db/worker-core.ts: WorkerDb (SqlDriver-only, testable in Node)
          │                 ├─ db/sqlite-wasm-driver.ts (OPFS sahpool SqlDriver, browser-only)
          │                 └─ sync/sync-client.ts: SyncClient (SqlDriver + SyncTransport, testable)
          │                       └─ sync/http-transport.ts (fetch + WebSocket, browser-only)
          │
          └─ platform/index.ts (storage/haptics/share/deepLinks/lifecycle/keyboard adapter)
```

## The worker/driver boundary decision

`@nooklet/core`'s `SqlDriver` is deliberately synchronous (it mirrors `better-sqlite3`/`node:sqlite`
so `applyOps`/`rebuild` can be simple, testable, transactional code). A worker boundary is async.
**Resolution: the worker imports `@nooklet/core` directly and runs `applyOps`/`rebuild`/plain
queries inside itself, against a real (synchronous) `SqlDriver`.** Only the RPC surface the worker
exposes to the main thread (`db/worker-api.ts`'s `WorkerApi`) is async — that's the one place the
sync/async boundary is actually crossed, and it's exactly what
[Comlink](https://github.com/GoogleChromeLabs/comlink) (1.1 kB gz) is for: proxy generation,
structured-clone marshalling, one `Promise` per call. A hand-rolled `postMessage` protocol was
considered and rejected — it would just reimplement Comlink, at higher risk, for a dependency this
small.

This split also gives the crucial testability property: `db/worker-core.ts`'s `WorkerDb` class and
`sync/sync-client.ts`'s `SyncClient` class only ever talk to a `SqlDriver` interface. In production
that's `db/sqlite-wasm-driver.ts` (OPFS `opfs-sahpool`, browser-only, **not unit tested** — see
below). In tests it's `@nooklet/core`'s own `createNodeSqliteDriver` (real SQLite, in-memory or
file-backed) — the exact same substitution the task asked for, and it's why `worker-core.test.ts`
and `sync-client.test.ts` can test 100% of the logic with zero browser, zero Worker, zero OPFS.

**Why `opfs-sahpool` and not the `opfs` VFS**: research/08-mobile.md §1.3 and
research/03-sync.md §6.9 are explicit that the SharedArrayBuffer-based `opfs` VFS needs COOP/COEP
response headers (a deployment burden for every self-hosted install) and cannot run inside a
Capacitor/Tauri custom-scheme webview at all (no cross-origin isolation there). `opfs-sahpool`
needs neither, at the cost of "one connection per database file" — which is exactly why
`db.worker.ts` does leader election with `navigator.locks` before ever opening the database.

## The reactive data seam (`src/data/store.ts`)

This is the API surface the views/editor/command-palette agents should build against. Do not
import `src/db/client.ts` directly from view code — always go through `store.ts`.

```ts
import { usePageTree, useJournalStream, applyOps, useSyncStatus } from "./data/store.js";

// "give me this page's block tree" — a Solid Resource<PageTreeResult | undefined>
const tree = usePageTree(() => pageId());

// "give me the journal stream" — today (virtual if empty) + earlier non-empty days
const stream = useJournalStream(() => ({ today: todayJournalDay(), maxDays: 14 }));

// "apply these ops" — the ONLY way to mutate local state; builds ops with
// makeOp(client.nextHlc-equivalent, ...) — see db/worker-api.ts's WorkerApi.applyLocalOps doc
await applyOps([op1, op2]);

// optional: a live sync status signal for a status indicator
const status = useSyncStatus();
```

**Invalidation model** (kept deliberately simple): the worker fires one
`{ tables: ("page"|"block"|"block_prop"|"page_prop")[], pageIds: string[] }` event per write —
local, pulled, corrected, or bootstrapped (`db/worker-core.ts#notifyFromOps`). `store.ts` keeps one
Solid signal per table name and one per page id, and bumps whichever ones a given event names.
`usePageTree`/`useJournalStream` read (and thus subscribe to) exactly the signals their data
depends on inside their `createResource` source function, so they refetch automatically and only
on a relevant change — editing page A never refetches page B's tree. If you need a new kind of
read (search, references, tasks — all later milestones), add a new `use*` function here following
the same pattern rather than reaching for `db/client.ts#query` directly from a component.

## The sync loop (ADR 003 / research/03-sync.md §6.5)

`sync/sync-client.ts`'s `SyncClient` owns:

- **`applyLocal(ops)`** — apply to local state AND insert into `pending_op`, in one
  `driver.transaction()`. This is the only place ops are queued; crash-safety is proven in
  `sync-client.test.ts` by closing and reopening a real on-disk SQLite file between two
  `SyncClient` instances and asserting the queued op (and the persisted `device_id`) survive.
- **`flush()`** — drains `pending_op` to `POST /sync/push` in batches (debounced 300ms via
  `schedulePush()`, and called immediately on `online`/`visible`/`resume` through
  `platform.lifecycle` → `db/client.ts#initDb` → `WorkerDb#notifyLifecycle`). Removes rows the
  server decided on (accepted or rejected — the server is the sole structural arbiter either way)
  and applies any `corrections` it returns.
- **`pull()`** — pages `GET /sync/pull?since=cursor` until caught up, applying via
  `@nooklet/core`'s `applyOps` (idempotent — an already-seen op id is a no-op) and dropping any
  `pending_op` row that comes back from the server.
- **`bootstrap()`** — for a fresh replica, `GET /sync/snapshot` and inserts the rows directly
  (they already carry final per-field HLCs).
- **`connectLive()`** — wires the WebSocket poke (and reconnects) to `pull()`.
- HLC drift (ADR 003: "device clocks more than 60s ahead are rejected with a visible error") is
  checked *before* any state is written for a batch (both in `pull()` and for push corrections),
  so a drifted remote clock rejects the whole batch cleanly instead of partially applying it — see
  the dedicated drift test in `sync-client.test.ts`.

`sync/http-transport.ts` is the real fetch+WebSocket implementation, matching the protocol both
this package and the concurrently-developed `packages/server` sync endpoints target. It is thin by
design and **not unit tested** — see manual verification below.

## `platform` adapter (ADR 005)

`src/platform/`: one `Platform` interface (`types.ts`), two implementations (`web.ts`, `capacitor.ts`
— M5), selected once by `index.ts` and exported as the `platform` singleton. Every caller imports
the interface + the singleton, never `web.ts`/`capacitor.ts` directly, so adding a target is
"implement the interface, branch in `index.ts`", with zero changes anywhere else — see `index.ts`'s
doc comment for how `capacitor.ts` stays statically imported (so `platform` can remain a
synchronous singleton, not a Promise) while still never pulling any `@capacitor/*` package into a
plain web build's bundle (every plugin it uses is a lazy, cached `import()` inside its own
functions, only ever called once `isCapacitorNative()` is true).

`keyboard.ts` splits the `--kb` inset math into a pure, unit-tested function
(`computeKeyboardInset`, see `keyboard.test.ts` for the 80px dead-band / iOS-26-residue /
offsetTop/rounding cases) and a DOM-wiring function (`createWebKeyboardWatcher`) that needs a real
browser. `capacitor.ts`'s keyboard watcher reuses the same `applyInset`/`--kb`/`.kb-open` CSS
contract but drives it from `@capacitor/keyboard`'s exact `keyboardWillShow`/`keyboardWillHide`
height events instead of a `visualViewport` measurement — no dead-band or re-measure heuristics
are needed there, because Capacitor reports the real number directly.

### Capacitor (M5 BUILD items 5–6): what's implemented, and what a human must run

`capacitor.config.ts` (repo root of this package, not a separate `apps/mobile/` — see its own doc
comment for why) configures the same `dist/` build every target uses: `appId`/`appName`/`webDir`,
`Keyboard.resize = "none"` (Logseq's own configuration, research/08-mobile.md §2.1/§3.2). `src/
platform/capacitor.ts` implements the full `Platform` interface for real: `@capacitor/keyboard`
(exact heights), `@capacitor/haptics` (impact/selection/notification), `@capacitor/share`
(outbound), `@capacitor/app` (`appUrlOpen`/`getLaunchUrl`, deduped, for `nooklet://` deep links;
`pause`/`resume` lifecycle). None of this can be exercised without a real device or simulator —
see the manual-verification list below.

**Not implemented: native SQLite in place of OPFS.** `capacitor.ts`'s trailing doc comment explains
why in full; in short, `@nooklet/core`'s `SqlDriver` is deliberately synchronous (mirrors
`node:sqlite`) so `WorkerDb` can call it directly inside the dedicated Worker, but every
`@capacitor-community/sqlite` call is an async native-bridge call reachable only from `window` —
which a dedicated Worker's global scope does not have. Wiring real native SQLite needs either an
async-capable `SqlDriver` shared with the server (`packages/core`), or moving `WorkerDb` onto the
main thread for Capacitor builds — both cross-cutting changes out of this milestone's scope. Until
then, a Capacitor build keeps using the existing `db/sqlite-wasm-driver.ts` (`opfs-sahpool`), which
research/08 §2.1 confirms already runs inside a Capacitor WKWebView.

**iOS: done as of 2026-09-14** (this environment has `xcodebuild` from the Command Line Tools but
no full `Xcode.app` — confirmed with `xcode-select -p` → `/Library/Developer/CommandLineTools`, and
`xcodebuild ... -showBuildSettings` on the generated project failing with "requires Xcode" — so
everything below the CLI layer is genuinely unverified, not just unattempted):

1. `npx cap add ios` (run from `apps/web/`) generated `apps/web/ios/` — a real Xcode project
   (`App.xcodeproj`), committed per Capacitor's own convention (its `.gitignore` already excludes
   `App/App/public` [the copied web build], `App/build`, `App/Pods`, `DerivedData`, `xcuserdata`,
   and the generated `capacitor.config.json`/`config.xml`). Capacitor 8 wires native dependencies
   through Swift Package Manager, not CocoaPods (`ios/App/CapApp-SPM/Package.swift`, listing all 6
   `@capacitor/*`/`@capacitor-community/*` plugins) — so `cap add ios` needed no CocoaPods/`pod`
   install step at all, only Ruby's absence would have mattered and didn't come up. `Package.swift`
   points at plugin sources inside `node_modules/.pnpm/...` (pnpm's content-addressable layout);
   `npx cap sync ios` rewrites it, so it self-heals after any dependency change — don't hand-edit it.
2. Deep link scheme: `ios/App/App/Info.plist` now has a `CFBundleURLTypes` entry for `nooklet://`
   (`CFBundleURLName: sh.nooklet.app`, matching `capacitor.config.ts`'s `appId`). `cap sync` does
   not touch `Info.plist`/`AppDelegate.swift`/etc., so this survives repeated syncs.
3. **Server address, so a packaged build can actually sync (closed 2026-09-14)**: every API/sync
   call was a *relative* fetch (`data/bootstrap.ts#apiBaseUrl`, `data/api-client.ts`,
   `sync/http-transport.ts`), which only ever resolves against the page's own origin — correct for
   a browser tab (the address bar's origin IS the server) but meaningless under Capacitor, whose
   WKWebView origin is the fixed `capacitor://localhost` scheme. `ConnectView.tsx` now shows a
   "Server address" field before the token field, but only when `platform.name === "capacitor"`
   (web/PWA is unchanged — still same-origin, no field); the address is verified live (same
   `graph.overview` check the token gets) before either is stored, in `data/bootstrap.ts`'s new
   `storedServerUrl`/`setStoredServerUrl` (localStorage key `nooklet.serverUrl`), which `apiBaseUrl()`
   now checks before falling back to the build-time `VITE_API_BASE_URL`/`VITE_SYNC_BASE_URL`/
   same-origin chain. `sync/http-transport.ts`'s WebSocket URL already derived correctly from
   `baseUrl` rather than `location`, so no change was needed there. Covered by
   `data/bootstrap.test.ts` and `views/ConnectView.test.tsx`; **not** verified against a real
   server from a real device/simulator — nothing here can be, without one.
4. Root `package.json` scripts: `pnpm ios:sync` (build `apps/web`, then `cap sync ios` — verified to
   run clean end to end from the repo root) and `pnpm ios:open` (`cap open ios`, i.e. launch Xcode —
   **unverified**, since `open`-ing an `.xcodeproj` needs `Xcode.app` registered as its handler,
   which this environment doesn't have). `pnpm ios` runs both.
5. **Not done here, needs a Mac with full Xcode installed**: opening the project, resolving the SPM
   packages, building, and running on a simulator or device — the entire point of an "app" is
   unverified past what the CLI can generate. Also pending: app icons/launch screens (Capacitor's
   placeholder `AppIcon.appiconset`/`Splash.imageset` are committed as-is — same "1–2 days the first
   time" budget research/08 §2.1 flags), signing, and the privacy manifest Capacitor ships by
   default.
6. Share-sheet *receiving* (a Share Extension + App Group) needs either the `send-intent` plugin
   wired into `ios/` or hand-written native code — research/08 §4; not attempted, this is real
   native-project work, not a CLI step.
7. **Android not started**: no `npx cap add android` run, no `android/` directory, no `@capacitor/
   android` dependency. Same shape of work as above (`AndroidManifest.xml` intent-filter for the
   `nooklet://` scheme, icons, signing, plus its own server-address entry point — the new field in
   `ConnectView.tsx` is gated on `platform.name === "capacitor"`, which is also true on Android, so
   it already covers this once the Android project exists) once picked up.

## What's stubbed for other agents

- **Views**: `src/routes/{Journals,Page,Search}Route.tsx` are placeholders marked `TODO(views)`,
  each demonstrating the one `data/store.ts` call the real view would use. Do not build on these
  directly — replace their contents.
- **Editor**: no CodeMirror surface exists; `data/tree.ts#buildBlockTree` gives the editor agent a
  ready-made nested block tree (pure, unit-tested) to render from `usePageTree`'s result.
- **Command palette / keybindings**: not started; `src/routes/SearchRoute.tsx` notes where it
  would eventually hang the palette trigger.
- **Server sync endpoints**: `sync/http-transport.ts` and `sync/types.ts` are written against
  ADR 003 / research/03-sync.md §6.5's protocol exactly, since `packages/server`'s `/sync/*` routes
  are being built concurrently against the same spec. If the real endpoints' response shapes end
  up differing, only `sync/types.ts` and `sync/http-transport.ts` need to change — every other file
  in `src/sync/` is written against the `SyncTransport` interface, not the wire format.

## Needs manual browser verification

Nothing here can be unit-tested in Node; each is structured so the surrounding logic *is* tested
(see "worker/driver boundary" above) and only the browser-specific glue is unverified:

1. `db/sqlite-wasm-driver.ts` — the actual `@sqlite.org/sqlite-wasm` OPFS `opfs-sahpool` calls
   (`installOpfsSAHPoolVfs`, `OpfsSAHPoolDb`, `exec`/`changes`/`selectValue`). The driver's *shape*
   (transaction/savepoint depth counter, `run`/`all`/`get`) mirrors `@nooklet/core`'s
   `createNodeSqliteDriver` exactly, which is tested; only the sqlite-wasm API surface itself is
   unverified.
2. `db/db.worker.ts`'s leader election (`navigator.locks`) — verify a second tab actually blocks
   rather than erroring, and that closing the leader tab releases the lock for another tab to pick
   up. **Known gap, not a bug**: a non-leader tab currently just waits forever rather than proxying
   its calls to the leader over `BroadcastChannel`; multi-tab-at-once is out of this milestone's
   scope (single tab is the primary target) and is left as a documented follow-up.
3. `platform/keyboard.ts#createWebKeyboardWatcher` — real `visualViewport` behavior on iOS Safari
   26.x specifically (the ~24px post-dismiss residue and the `position:fixed` jitter bug the dead
   band and post-blur re-measure exist to absorb, research/08-mobile.md §1.5).
4. `sync/http-transport.ts` end-to-end against the real `/sync/push|pull|snapshot|live` server
   once `packages/server`'s implementation lands.
5. PWA install/offline behavior (`vite-plugin-pwa`'s generated service worker, `public/manifest.webmanifest`)
   across Safari iOS / Chrome Android / desktop — see research/08-mobile.md §1 for the capability
   matrix (no install prompt on iOS, no background sync anywhere, etc.) this app already designs
   around rather than assumes away.
6. `navigator.storage.persist()`/`estimate()` (`platform/web.ts`) — heuristic grants, best
   verified by hand per browser.
7. Real PNG icons: `public/icon.svg` is a placeholder; the manifest references only an SVG "any"
   icon today. A design pass should add proper 192/512/maskable PNGs.
8. **M5 gestures** (`editor/gestures/{swipe,longPressDrag}.ts`): the decision logic (thresholds,
   direction lock, cancellation on vertical scroll, long-press timing, row-crossing math) is fully
   unit-tested with synthetic pointer events. What is NOT and cannot be tested here: real touch
   hardware's pointer event ordering/coalescing, whether `touch-action: pan-y`/`none` actually
   suppress the expected native gestures on iOS Safari and Android Chrome/WebView, `setPointerCapture`
   behavior across a real finger lift, and the haptics calls it triggers (`platform.haptics` — no-op
   on this machine's browser automation). Needs a real phone or at minimum a touch-emulating
   browser devtools session.
9. **M5 quick capture** (`/capture`, `capture/quickCapture*.ts`, `views/CaptureView.tsx`): the
   op-building and the async service are unit-tested against a fake data seam
   (`quickCaptureService.test.ts`), and the UI against a fake `submit` prop
   (`views/CaptureView.test.tsx`). NOT verified here: the PWA manifest's `share_target`/`shortcuts`
   actually appearing in Android's share sheet / long-press app icon menu (Chrome/WebAPK only,
   research/08 §1.4 — Safari ignores both, harmlessly), and offline behavior end-to-end through a
   real service worker.
10. **M5 Capacitor** (`capacitor.config.ts`, `platform/capacitor.ts`, `ios/`): the native iOS
    project now exists and `cap add`/`cap sync` are verified to run clean (see the dedicated
    "what a human must run" section above), but nothing past the CLI layer can run without full
    Xcode, which this environment doesn't have — no build, no simulator launch, no plugin call ever
    actually reaching the native bridge. The adapter code itself typechecks against the real
    `@capacitor/*` type packages (installed as real dependencies, not stubbed) but every plugin call
    inside it is exercised for the first time on a real device. Android has no generated project yet
    at all.

## Scripts

- `pnpm --filter @nooklet/web dev` — Vite dev server.
- `pnpm --filter @nooklet/web build` — production build (also runs the PWA service-worker
  generation step).
- `pnpm --filter @nooklet/web preview` — preview the production build.
- `pnpm --filter @nooklet/web test` — Vitest (node environment; no browser tests in this package).
- `pnpm --filter @nooklet/web typecheck` — runs `tsc --noEmit` twice: once for the main app
  (`tsconfig.json`, DOM lib) and once for `db/db.worker.ts` (`tsconfig.worker.json`, WebWorker
  lib) — the two libs can't coexist in one `tsconfig` (both declare an incompatible global `self`),
  so the worker entry point is excluded from the main project and typechecked separately. Every
  other file under `src/db/` has no DOM/WebWorker-specific globals of its own and is typechecked by
  both projects.
