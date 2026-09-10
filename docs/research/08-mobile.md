# 08 — Mobile + desktop packaging and "native feel" for a web-first client

Research date: 2026-09-10. Facts below were checked against vendor docs, the npm registry, MDN browser-compat-data (BCD), WebKit bug tracker and blog posts on that date; where I could not verify something it is marked *(unverified)*.

## TL;DR

**Packaging path: PWA first → Capacitor 8 for the iOS/Android stores → Tauri 2 for desktop.** One Vite build feeds all three; a thin `platform` layer hides the differences (storage driver, keyboard insets, haptics, share, deep links, files).

- **PWA (v1).** iOS 26 opens *any* site added to the Home Screen as a web app by default; push (16.4+), badging (16.4+), OPFS/sqlite-wasm, `persist()` (15.2+) all work. What iOS still lacks and will not give a PWA: share target, install prompt, app shortcuts, protocol handlers, background sync, File System Access, link capturing (links open in Safari, not the installed app), `interactive-widget` (keyboard overlays the page), `navigator.vibrate`. Storage is *best-effort* and each Home-Screen icon is a separate storage container.
- **Capacitor 8.5.1 (v1.x, stores).** Same WebKit engine on iOS, but you get: native SQLite (`@capacitor-community/sqlite` 8.1.1, no eviction/quota), exact keyboard height events + resize modes + hide the accessory bar, real haptics, share-sheet *receiving* (share extension), `vrite://` URL scheme (→ Shortcuts/Siri/Action Button), home-screen quick actions, App Store presence. ~1M weekly downloads, Logseq mobile is built on it. Submission is a normal Xcode/Play upload.
- **Tauri 2.11 (v1.5, desktop).** Excellent on desktop: global hotkey for quick capture, tray, deep-link, single-instance, updater, small binaries; Rust required but ~100 lines for v1. Tauri *mobile* works (all official plugins list iOS/Android) but has no keyboard/status-bar/share-target plugins and a smaller production base → not for the mobile store builds of an editor-heavy app.
- **Not:** Electron (fine but heavy; only if you want Node in-process), Expo DOM components (you'd still rewrite the shell in RN), Flutter.

Must-do native-feel work (section 3): app-shell layout with `position:fixed; inset:0` + inner scroll container, `viewport-fit=cover` + `env(safe-area-inset-*)`, a unified `--kb` keyboard-inset variable (visualViewport on iOS web, `interactive-widget=resizes-content` on Android web, Keyboard plugin on Capacitor), keyboard accessory toolbar positioned by `--kb` (not `bottom:0`), a *single moving editor instance* so Enter/new-block focus never leaves a focused element (iOS keyboard rule), pointer-event swipe-to-indent with `touch-action: pan-y`, long-press drag via a handle, `overscroll-behavior: none`, `-webkit-tap-highlight-color: transparent`, 16px input font, same-document View Transitions, manual scroll restoration.

---

## 0. Versions verified on 2026-09-10 (npm registry unless noted)

| Package / product | Version | Notes |
|---|---|---|
| `vite-plugin-pwa` | 1.3.0 (2026-05-05) | peer: Vite 3–8; depends on `workbox-build`/`workbox-window` ^7.4.1 (no Workbox 8) |
| `workbox-*` | 7.4.1 | |
| `@capacitor/core` / `cli` | 8.5.1 (2026-08-31) | `next` = 9.0.0-alpha.6; Cap 8.0 released 2025-12-08; 8.5 (2026-07-31) adopts UIScene for Xcode 27 |
| `@capacitor/keyboard` | 8.0.5 | `@capacitor/haptics` 8.0.2, `@capacitor/share` 8.0.1, `@capacitor/status-bar` 8.0.3, `@capacitor/app` 8.1.1, `@capacitor/filesystem` 8.1.3, `@capacitor/local-notifications` 8.3.1, `@capacitor/push-notifications` 8.1.2 |
| `@capacitor-community/sqlite` | 8.1.1 (2026-08-06) | native SQLite iOS/Android (+Electron, web via jeep-sqlite) |
| `@capawesome/capacitor-app-shortcuts` | 8.0.2 | open source |
| `@capgo/capacitor-share-target` | 8.0.50 | community share-target (Capawesome's own is sponsor-only) |
| `@tauri-apps/api` / `cli` | 2.11.1 / 2.11.4 (2026-06) | Tauri 2.0 stable Oct 2024 |
| `@tauri-apps/plugin-global-shortcut` | 2.3.2 | desktop only |
| `@tauri-apps/plugin-deep-link` | 2.4.10 | desktop + mobile |
| `@tauri-apps/plugin-sql` | 2.4.1 | sqlx; matrix lists all 5 platforms |
| `@sqlite.org/sqlite-wasm` | 3.53.4-build1 (2026-09-08) | opfs + opfs-sahpool VFS |
| `wa-sqlite` | 1.0.0 (2024-01) | OPFSCoopSyncVFS, IDBBatchAtomicVFS; newer VFSs live in the repo/PowerSync fork |
| `electron` | 44.3.0 (2026-09-08) | Electron 40 was Jan 2026; ~8-week cadence |
| `expo` / `react-native-web` | 57.0.21 / 0.21.2 | DOM components (`'use dom'`) since SDK 52 |
| `@neutralinojs/neu` | 11.7.2 | |
| Wails | v3 beta (beta.9, Aug 2026) | Go |
| Safari / iOS | 26.6 current line | WebKit blog: 26.0 (Sept 2025) … 26.6 |

---

## 1. PWA in 2026

### 1.1 Installability

**iOS/iPadOS 26 (Safari 26.0):** "By default, every website added to the Home Screen opens as a web app." No manifest, no `apple-mobile-web-app-capable`, no service worker required; the user gets an "Open as Web App" toggle in the Add-to-Home-Screen sheet. A manifest is still honoured (icons, `name`, `start_url`, `display`, `theme_color`). There is still **no install prompt / `beforeinstallprompt`** — the user must do Share → Add to Home Screen; you can only show an in-app hint (detect with `navigator.standalone` / `matchMedia('(display-mode: standalone)')`). Source: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/

**Android (Chrome):** manifest with `name`/`short_name`, 192+512 icons, `start_url`, `display` standalone/fullscreen/minimal-ui, HTTPS, `prefer_related_applications` absent → `beforeinstallprompt` fires (after an engagement heuristic); installs as a **WebAPK** which captures in-scope links, has app shortcuts and share target. Add `screenshots` + `description` for the richer install dialog. Source: https://web.dev/articles/install-criteria

**Desktop:** Chrome/Edge install on Windows/macOS/Linux; Safari 17+ "File → Add to Dock" on macOS Sonoma+ (push, badging, manifest honoured; cookies copied at install, storage otherwise separate). Firefox desktop has no install. Source: https://webkit.org/blog/14205/news-from-wwdc23-webkit-features-in-safari-17-beta/

Minimal manifest for vrite:

```json
{
  "name": "vrite", "short_name": "vrite", "id": "/",
  "start_url": "/?source=pwa", "scope": "/",
  "display": "standalone", "display_override": ["window-controls-overlay", "standalone"],
  "background_color": "#ffffff", "theme_color": "#ffffff",
  "icons": [
    { "src": "/icons/192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Quick capture", "url": "/capture?source=shortcut", "icons": [{ "src": "/icons/capture-96.png", "sizes": "96x96" }] },
    { "name": "Today's journal", "url": "/journal/today" }
  ],
  "share_target": {
    "action": "/capture", "method": "GET",
    "params": { "title": "title", "text": "text", "url": "url" }
  },
  "protocol_handlers": [{ "protocol": "web+vrite", "url": "/open?u=%s" }],
  "screenshots": [{ "src": "/shots/phone.png", "sizes": "1080x1920", "type": "image/png", "form_factor": "narrow" }]
}
```
`shortcuts`, `share_target`, `protocol_handlers` are ignored by Safari (see matrix 1.4); harmless.

Also keep the Apple-specific tags (`<link rel="apple-touch-icon">`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`, `<meta name="theme-color">`).

### 1.2 Offline / service worker

`vite-plugin-pwa` 1.3.0 wraps Workbox 7.4.1 (Vite 8 supported). Use the `injectManifest` strategy (you will need a hand-written SW anyway for share-target POST later and for `push`), `registerType: 'prompt'` with the plugin's `onNeedRefresh`/`onNeedReload` callbacks to show an "Update available" toast, precache the app shell, runtime-cache attachments, never cache the sync API.

```ts
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins: [VitePWA({
    strategies: 'injectManifest', srcDir: 'src/sw', filename: 'sw.ts',
    registerType: 'prompt', injectRegister: false,      // we register manually (skip on Capacitor/Tauri)
    manifest: false,                                    // ship /manifest.webmanifest as a static file
    injectManifest: { globPatterns: ['**/*.{js,css,html,woff2,svg,png,wasm}'], maximumFileSizeToCacheInBytes: 6_000_000 },
    devOptions: { enabled: false },
  })],
});
```

```ts
// src/sw/sw.ts
/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST); cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));
registerRoute(({ url }) => url.pathname.startsWith('/api/'), new NetworkOnly());
registerRoute(({ url }) => url.pathname.startsWith('/attachments/'),
  new CacheFirst({ cacheName: 'attachments', plugins: [new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 30 * 86400 })] }));
self.addEventListener('message', e => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
```

```ts
// src/platform/web/sw-register.ts — only on real web/PWA, never inside Capacitor/Tauri
import { registerSW } from 'virtual:pwa-register';
export function registerServiceWorker(onUpdate: (apply: () => void) => void) {
  const update = registerSW({ immediate: true, onNeedRefresh: () => onUpdate(() => update(true)) });
}
```

iOS notes: the SW only matters in Safari/PWA; WKWebView on a custom scheme (`capacitor://localhost`) does not run service workers, so Capacitor builds must not register one (assets are bundled anyway). Safari 26.6 fixed two SW registration bugs (missing main/imported scripts now auto-unregister). Source: https://webkit.org/blog/18178/webkit-features-for-safari-26-6/

### 1.3 Storage: sqlite-wasm + OPFS, quotas, eviction, `persist()`

**OPFS + SQLite options (PowerSync survey, May 2026 — https://powersync.com/blog/sqlite-persistence-on-the-web):**

| VFS | Needs | Concurrency | Safari |
|---|---|---|---|
| `sqlite-wasm` **opfs** | dedicated Worker + SharedArrayBuffer → COOP/COEP headers | multi-connection | needs Safari ≥ 17 (sub-worker bug below 17) |
| `sqlite-wasm` **opfs-sahpool** | Worker, *no* COOP/COEP | **one connection per DB** (cross-tab must be done by you) | Safari ≥ 16.4 |
| `wa-sqlite` **OPFSCoopSyncVFS** | dedicated Worker | multi-tab cooperative (SQLITE_BUSY retry) | works; recommended general-purpose |
| `wa-sqlite` **OPFSWriteAheadVFS** (Apr 2026) | Chrome 121+ `readwrite-unsafe` | concurrent reads | Chrome-only feature |
| `wa-sqlite` **IDBBatchAtomicVFS** | IndexedDB | multi-tab | fallback (private mode, old browsers); slow > ~100 MB, Safari "Maximum call stack" on huge queries |

Hard constraints: SharedWorkers and ServiceWorkers **cannot** open OPFS sync access handles (so the DB worker must be a dedicated Worker; elect a leader across tabs with `navigator.locks` + `BroadcastChannel`); Safari private browsing has no OPFS; Firefox can spawn dedicated workers from a SharedWorker, Chrome/Safari cannot. **Capacitor/iOS-specific:** PowerSync reports OPFS access handles get closed when the app goes to the background, causing errors on resume → in Capacitor use the native SQLite plugin (or the IDB VFS), not OPFS. BCD: `FileSystemSyncAccessHandle` Safari 15.2+/iOS, Chrome 102 (Android 109), Firefox 111. sqlite.org persistence doc: https://sqlite.org/wasm/doc/trunk/persistence.md

**Quotas (Safari 17 policy, still current — https://webkit.org/blog/14403/updates-to-storage-policy/):** browser apps: per-origin up to 60 % of disk, all origins 80 %; **non-browser apps (WKWebView, i.e. Capacitor/Tauri iOS) 15 % / 20 %**; Home Screen web apps get the same quota as Safari. Chrome: per-origin up to 60 % of disk (Android same order). Eviction is per origin, LRU by last interaction, on quota/system pressure, and via ITP inactivity. `navigator.storage.estimate()` works everywhere.

**`navigator.storage.persist()`:** supported Safari 15.2+ (BCD). WebKit "grants a request based on heuristics like whether the website is opened as a Home Screen Web App" — no prompt. Chrome grants silently based on engagement/installed/bookmarked/notification permission. Firefox prompts. Persistence only protects against *automatic* eviction, never against the user clearing site data. Call it after install, and read back `persisted()` to show a warning if false. Source: https://web.dev/articles/persistent-storage

**The 7-day rule (ITP):** Safari deletes all script-writable storage (IndexedDB, localStorage, OPFS, SW registrations, Cache) for an origin after **7 days of Safari use without user interaction with that site**. WebKit's exact wording: "Web applications added to the home screen are not part of Safari and thus have their own counter of days of use. Their days of use will match actual use of the web application which resets the timer." So a Home Screen web app that is actually used is *not* affected; a vrite tab left in Safari is. https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/

**Separate containers (important for vrite):** on iOS, Safari tabs, *each* Home-Screen icon, and each app's WKWebView all have separate storage. Consequences: (1) a user who used vrite in Safari, then installs it, starts with an empty local DB and must log in and re-sync; (2) a second icon for `/capture` would have its own DB — do not use that trick; (3) storage on iOS is best-effort even when persisted, so the local DB must always be reconstructable from the server, and the unsynced-ops queue must be flushed aggressively (on `visibilitychange`, `pagehide`, Capacitor `appStateChange`, and on reconnection). Design principle: **local DB = authoritative cache + outbox; server = durable truth.**

### 1.4 Capability matrix (BCD, 2026-09)

| Capability | Chrome Android (PWA/WebAPK) | Safari iOS Home-Screen app | Notes |
|---|---|---|---|
| Install prompt (`beforeinstallprompt`) | yes | **no** | iOS: manual Add to Home Screen; iOS 26 opens as app by default |
| Service worker offline | yes | yes | iOS: no SW inside `capacitor://` WKWebView |
| OPFS sync access handles | 109+ | 15.2+ | see 1.3 |
| `storage.persist()` | 55+ (auto-grant heuristics) | 15.2+ (heuristic incl. Home Screen) | |
| Web Push | yes | **16.4+** (Home Screen only; permission request must be in a user gesture; SW `push` must show a notification); **Declarative Web Push 18.4+** (no SW needed) | https://webkit.org/blog/13878/ , https://webkit.org/blog/16535/meet-declarative-web-push/ |
| Badging `setAppBadge` | **no** on Android (BCD `chrome_android: false`) | 16.4+ Home Screen only, needs notification permission; `0` clears | macOS Safari 17+, Chrome desktop 81+ |
| Web Share (`navigator.share`) | 61+ | 12.1+ | outbound sharing fine everywhere |
| **Web Share Target** (receive) | 76+ | **no** (WebKit bug 194593 open since 2019, position "neutral") | Firefox parses but no-op |
| `shortcuts` (long-press icon) | 84+ | **no** on iOS (macOS Safari 17.4+ yes) | |
| `protocol_handlers` | Chrome desktop 96+ only | no | not on Android either |
| `file_handlers`, `launch_handler`, `launchQueue` | desktop Chrome only | no | |
| File System Access (`showOpenFilePicker`) | 132+ | **no** | use `<input type=file>` + `<a download>` on iOS |
| Background Sync / Periodic Sync | Chrome only | **no** (Firefox no) | flush on visibility/online instead |
| `interactive-widget` viewport meta | Chrome Android 108+, Firefox Android 133+, Android WebView | **no** (WebKit bug 259770, open, P2) | keyboard overlays on iOS |
| VirtualKeyboard API / `env(keyboard-inset-*)` | Chrome 94+ | no | |
| `navigator.vibrate` | Chrome Android (needs user gesture) | **no** | Firefox Android disabled |
| View Transitions same-document | 111+ | 18+ | Firefox 144+ |
| View Transitions cross-document | 126+ | 18.2+ | Firefox no |
| `env(safe-area-inset-*)` | 69+ | 11+ | |
| `overscroll-behavior` | 63+ (full 144+) | 16+ (partial: no effect without scrollable overflow) | |
| Link capturing (open in installed app) | WebAPK captures in-scope links | **no** — links open in Safari | |
| Multiple windows / fullscreen without status bar | — | no | |

### 1.5 What is still broken or missing on iOS PWAs (2026)

1. No share target, no app shortcuts, no protocol handlers, no link capturing, no install prompt.
2. Keyboard overlays content (no `interactive-widget`), and iOS 26.0/26.1 shipped a regression where `position:fixed` elements jitter and `visualViewport.height` stays ~24 px short after the keyboard is dismissed (WebKit 297779 → Radar 159439271; "partially fixed in 26.1", reports continued into Dec 2025). Test on the current 26.x before shipping any fixed toolbar. https://bugs.webkit.org/show_bug.cgi?id=297779 , https://developer.apple.com/forums/thread/800125
3. Keyboard cannot be raised programmatically outside a user gesture (section 3.4).
4. Storage is best-effort; separate containers per icon/Safari; no guarantee under storage pressure.
5. No background execution at all (no Background Sync/Fetch, SW is killed quickly); the app gets a few seconds on backgrounding.
6. No haptics from the web (`vibrate` unsupported).
7. Every iOS browser is WebKit (except rare EU alternative-engine browsers), so "test Safari" is the whole matrix. *(EU note, unverified wording: Apple announced in Feb 2024 that Home-Screen web apps would be dropped in the EU under the DMA and reversed that on 1 March 2024 before iOS 17.4 shipped; some 2026 blog posts still repeat the old claim. Assume EU users have the same PWA capabilities.)*
8. Standalone mode quirks: external links open in an in-app browser sheet; `<a download>` reliability in standalone mode has historically been poor — test.

---

## 2. Native wrappers

### 2.1 Capacitor 8 (recommended for stores)

- **State 2026:** 8.0 (Dec 2025): SPM default for iOS, `SystemBars` core plugin with Android edge-to-edge; 8.5 (Jul 2026): UIScene lifecycle for Xcode 27 (one `npx cap migrate`); 9 in alpha (multi-window/foldables). Requirements: Node ≥ 22, **Xcode 26+, iOS 15 deployment target**, Android minSdk 24 / compile+target 36, AGP 8.13, Kotlin 2.2. ~1M weekly downloads. https://ionic.io/blog/announcing-capacitor-8 , https://capacitorjs.com/docs/updating/8-0
- **How it runs the web build:** `webDir: 'dist'`, served by a WKURLSchemeHandler at `capacitor://localhost` (iOS) and `https://localhost` (Android). Both are secure contexts (`localhost` is potentially-trustworthy) so `crypto.subtle`, WebCrypto, etc. work. **Origin = storage key**: changing `server.hostname`/`iosScheme` later loses all webview data — settle it once. Native SQLite avoids this entirely.
- **Plugins you need:** `@capacitor/keyboard` (resize modes `native|body|ionic|none`, `keyboardWillShow` with exact `keyboardHeight`, `setAccessoryBarVisible(false)` to remove the ◀ ▶ Done bar, `setScroll`), `@capacitor/haptics` (impact/notification/selection; web fallback uses `vibrate`), `@capacitor/status-bar` + core `SystemBars` (edge-to-edge; injects `--safe-area-inset-*` CSS vars where the Android WebView < 140 gets `env()` wrong), `@capacitor/share`, `@capacitor/app` (`appUrlOpen`, `getLaunchUrl`, `appStateChange`, back button), `@capacitor/filesystem`, `@capacitor/local-notifications`, `@capacitor-community/sqlite`, `@capawesome/capacitor-app-shortcuts` (icon quick actions), share receiving via `send-intent` (MIT; iOS needs a Share Extension target + App Group + URL scheme; https://github.com/carsten-klaffke/send-intent) or `@capgo/capacitor-share-target` or Capawesome's sponsor-only plugin.
- **Storage inside Capacitor:** prefer `@capacitor-community/sqlite` (native, no quota, no eviction, survives backgrounding). If you want to reuse the wasm engine, use `opfs-sahpool` (no COOP/COEP needed — a custom-scheme handler cannot provide cross-origin isolation, so the SharedArrayBuffer-based `opfs` VFS is out) but beware the background access-handle closure on iOS reported by PowerSync; IDB VFS is the safe wasm fallback.
- **WKWebView vs Safari differences that matter for the editor:** same engine, but: you control keyboard resize behaviour and the accessory bar; no ITP 7-day timer for your own origin; `allowsLinkPreview` and long-press behaviours are configurable; `ios.contentInset`, `scrollEnabled` (turn off webview scrolling if you scroll inside a container); `preferredContentMode`; the WebView is a *single* scroll view — the Logseq config sets `KeyboardResize.None` and manages layout itself (see 3.3).
- **App Store effort:** it is a normal Xcode project — icons/launch screen, signing, privacy manifest (Capacitor ships one), TestFlight, review. Budget 1–2 days the first time. Review risk is Guideline 4.2 (minimum functionality) for "just a website" — vrite is offline-first with native integrations, so it passes as long as it works without network and does not look like a login-walled site. https://capacitorjs.com/docs/ios/deploying-to-app-store
- **Precedent:** Logseq's mobile app is Capacitor (`capacitor.config.ts` in the repo: `Keyboard.resize = None`, status bar overlays webview, safe-area handling, custom `Logseq` iOS scheme). *(Obsidian mobile is also widely reported to be Capacitor-based — unverified today.)*

### 2.2 Tauri 2 (recommended for desktop; mobile optional)

- 2.11.x (mid-2026); stable since Oct 2024; patch releases every few weeks. Rust required (`rustup`), Xcode for iOS, Android Studio + NDK for Android. Webviews: WebView2 (Windows), WKWebView (macOS/iOS — same WebKit limits as Safari), webkit2gtk (Linux — often older WebKit; test the editor there), Android System WebView. https://v2.tauri.app/reference/webview-versions/ , https://v2.tauri.app/start/prerequisites/
- **Official plugin matrix (https://v2.tauri.app/plugin/):** fs, sql (sqlx), store, notification, haptics, biometric, nfc, barcode-scanner, os, clipboard, dialog, opener, updater, window-state, http, websocket, log → all 5 platforms. **Desktop-only:** global-shortcut, single-instance, shell, autostart, positioner. **Missing on mobile:** keyboard (height/resize/accessory bar), status bar, safe-area, share-sheet receiving, app shortcuts — you'd write Swift/Kotlin plugin code yourself.
- **Mobile maturity:** functional and shipping, but the team itself says not all desktop plugins are ported; community consensus in 2026 is "fine for internal tools/early products, Capacitor/RN more proven". App Store publishing is documented (`tauri ios build --export-method app-store-connect` + `altool`). https://v2.tauri.app/distribute/app-store/
- **Desktop story for vrite** (section 5): global hotkey capture window, tray, deep-link (macOS registers scheme only when bundled in /Applications; Windows/Linux need single-instance), updater, autostart, ~5–10 MB installers.

### 2.3 Electron / ToDesktop / Neutralino / Wails

- **Electron 44.3.0** (Sept 2026; Chromium-bundled, ~100+ MB, Node in-process). Only worth it if you want to embed the Node sync server or use `better-sqlite3` in the app process. Logseq desktop is Electron. **ToDesktop** = hosted build/sign/update service on top of Electron (active changelog 2026). **Neutralino 6.x** (tiny, system webview, no mobile). **Wails v3** Go, beta.9 (Aug 2026), desktop only. None beat Tauri for vrite's desktop needs.

### 2.4 React Native / Expo

Expo SDK 57; **DOM components** (`'use dom'`) render a React DOM component inside a WebView with serializable props and async "native action" props; each is an isolated WebView; Expo docs recommend them for rich-text/markdown, WebGL and auxiliary screens, not the app core. `react-native-web` 0.21 goes the other way (RN → web). Either way the outliner shell, navigation and storage would be re-written in RN. Not for vrite; revisit only if a fully native shell is ever demanded. https://docs.expo.dev/guides/dom-components/

### 2.5 Trusted Web Activity (Play Store without Capacitor)

Bubblewrap/PWABuilder wrap the PWA in a TWA: needs `assetlinks.json` (Digital Asset Links), installable manifest, Chrome ≥ 72; runs in the user's browser, so storage is shared with Chrome and share-target/shortcuts work, but **no native plugins** (no native SQLite, no haptics beyond `vibrate`, no share extension needed on Android anyway). Good enough as a fast Play listing before Capacitor Android is ready. https://developer.chrome.com/docs/android/trusted-web-activity/

### 2.6 Recommended path and why

1. **v1 — PWA** (web + installable on all platforms). Gets iOS users a standalone app with push/badge/offline today; zero store overhead; instant updates.
2. **v1.x — Capacitor iOS + Android** from the same `dist/`: share-sheet capture, `vrite://` + Shortcuts/Siri, home-screen quick actions, native SQLite, exact keyboard control, store presence. Optionally ship Android via TWA first.
3. **v1.5 — Tauri desktop**: global capture hotkey, tray, deep links, auto-update. Keep the wasm SQLite path inside Tauri initially (fewer adapters), move to rusqlite/`plugin-sql` when you need embeddings/FTS performance.
4. Tauri-for-everything is tempting (one toolchain) but for a keyboard-centric editor the Capacitor keyboard/accessory/share-target plugins are exactly the pieces Tauri mobile lacks; Capacitor's production base is also far larger. Revisit if Tauri gains keyboard/status-bar plugins.

### 2.7 The block editor inside webviews

- Both WKWebView (Capacitor/Tauri iOS) and Safari are the same engine, so the editor behaves identically; Android WebView ≈ Chrome. The differences are keyboard/inset control (2.1) and the ability to hide the accessory bar.
- **One editor instance at a time.** Logseq renders every block as static HTML and mounts a single `<textarea>` only on the block being edited; Workflowy uses contenteditable. Do the same: mount one textarea/CodeMirror `EditorView` and *move* it between blocks. This is what makes iOS focus rules tractable (3.4), keeps DOM small (hundreds of blocks), and makes swipe/drag gestures simpler (non-editing rows are plain divs).
- CodeMirror 6 works on iOS/Android (composition/IME via `beforeinput`), but a plain textarea is lighter for mobile; if CM is used, one shared `EditorView` with `setState` per block is the right shape. Set `autocapitalize="sentences" autocorrect="on" spellcheck enterkeyhint="enter"` on the editor element and keep `font-size ≥ 16px` to avoid iOS focus-zoom.

---

## 3. Native-feel techniques for mobile web (code)

### 3.1 Viewport, safe areas, app shell

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
```
`viewport-fit=cover` unlocks `env(safe-area-inset-*)` on notch/home-indicator devices; `interactive-widget=resizes-content` makes Android Chrome/WebView shrink the *layout* viewport for the keyboard (Chrome's default since 108 is `resizes-visual`, i.e. iOS-like overlay); Safari ignores it.

```css
:root { --kb: 0px; --toolbar-h: 44px; --sat: env(safe-area-inset-top, 0px); --sab: env(safe-area-inset-bottom, 0px); }
html, body { height: 100%; margin: 0; overflow: hidden; overscroll-behavior: none; background: var(--bg); }
#app { position: fixed; inset: 0; display: flex; flex-direction: column; padding-top: var(--sat); }
/* the ONLY scroll container: iOS then never scrolls the document, so visualViewport.offsetTop stays 0 */
.page-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding-bottom: calc(var(--kb) + var(--toolbar-h) + var(--sab)); scroll-padding-bottom: calc(var(--kb) + var(--toolbar-h)); }
body, button, a { -webkit-tap-highlight-color: transparent; }
button, .bullet, .row-handle { touch-action: manipulation; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
textarea, input { font-size: 16px; }              /* < 16px triggers iOS auto-zoom on focus */
@supports (height: 100dvh) { .full { height: 100dvh; } } /* alternative to the fixed shell */
```
Momentum scrolling is native for overflow containers on iOS 13+ (no `-webkit-overflow-scrolling` needed). Capacitor Android edge-to-edge: the `SystemBars` plugin (`insetsHandling: 'css'`) injects `--safe-area-inset-*`; use `env(safe-area-inset-bottom, var(--safe-area-inset-bottom, 0px))` if you must support WebView < 140. https://capacitorjs.com/docs/apis/system-bars

### 3.2 A single keyboard-inset variable `--kb`

Three sources, one CSS variable:

```ts
// platform/keyboard.ts
export interface KeyboardAdapter { start(): () => void; hide?(): Promise<void>; }
const root = document.documentElement;
const apply = (px: number) => { root.style.setProperty('--kb', `${px}px`); root.classList.toggle('kb-open', px > 0); };

// Web / PWA (iOS Safari + Android Chrome). On Android with interactive-widget=resizes-content innerHeight shrinks too → inset ≈ 0, which is correct.
export const webKeyboard: KeyboardAdapter = {
  start() {
    const vv = window.visualViewport; if (!vv) return () => {};
    let raf = 0;
    const measure = () => { raf = 0;
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      apply(inset < 80 ? 0 : Math.round(inset));      // ignore URL-bar collapse and the iOS 26 ~24px residue
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    vv.addEventListener('resize', schedule); vv.addEventListener('scroll', schedule);
    const onBlur = () => setTimeout(schedule, 350);   // re-measure after the hide animation (iOS 26 leaves stale values)
    window.addEventListener('focusout', onBlur);
    measure();
    return () => { vv.removeEventListener('resize', schedule); vv.removeEventListener('scroll', schedule); window.removeEventListener('focusout', onBlur); };
  },
};

// Capacitor: exact height *before* the animation, and we own the layout (resize mode None)
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
export const capacitorKeyboard: KeyboardAdapter = {
  async start() {
    await Keyboard.setResizeMode({ mode: KeyboardResize.None });
    await Keyboard.setAccessoryBarVisible({ isVisible: false });   // iPhone only; gives us the space for our own bar
    const a = await Keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) => apply(keyboardHeight));
    const b = await Keyboard.addListener('keyboardWillHide', () => apply(0));
    return () => { a.remove(); b.remove(); };
  },
  hide: () => Keyboard.hide(),
};
```
Logseq does the equivalent: `KeyboardResize.None` in `capacitor.config.ts`, then on `keyboardWillShow` sets `document.body.style.height = docHeight - keyboardHeight` and a `--ls-native-kb-height` root variable that its CSS uses for padding/popup heights (`src/main/mobile/externals.js`, `src/main/frontend/handler/events.cljs`). Android Chrome additionally offers `navigator.virtualKeyboard.overlaysContent = true` + `env(keyboard-inset-height)`; not needed if you use `interactive-widget=resizes-content`.

### 3.3 Keyboard accessory toolbar (indent / outdent / move / bullet / done)

```html
<div class="kb-toolbar" role="toolbar" aria-label="Editing">
  <button data-cmd="outdent">⇤</button><button data-cmd="indent">⇥</button>
  <button data-cmd="moveUp">↑</button><button data-cmd="moveDown">↓</button>
  <button data-cmd="link">[[ ]]</button><button data-cmd="tag">#</button><button data-cmd="todo">☐</button>
  <span class="spacer"></span><button data-cmd="done">Done</button>
</div>
```
```css
.kb-toolbar { position: absolute; left: 0; right: 0; bottom: var(--kb); height: var(--toolbar-h);
  padding-bottom: var(--sab); box-sizing: content-box; display: flex; gap: 4px; background: var(--bar-bg);
  border-top: 1px solid var(--hairline); transition: bottom 120ms ease-out; }
.kb-open .kb-toolbar { padding-bottom: 0; }        /* keyboard covers the home indicator: drop the safe-area padding */
.kb-toolbar button { min-width: 44px; height: 44px; font-size: 18px; }
```
```ts
// Buttons must NOT steal focus from the editor, or iOS closes the keyboard.
toolbar.addEventListener('pointerdown', e => e.preventDefault());        // keeps focus in the textarea
toolbar.addEventListener('click', e => { const cmd = (e.target as HTMLElement).closest('button')?.dataset.cmd; if (cmd) editor.exec(cmd); });
```
Pitfalls and why the bar "jumps":
1. `position: fixed; bottom: 0` is relative to the *layout* viewport, which iOS does not shrink → the bar sits under the keyboard. Position it by `--kb` inside the fixed app shell instead (above).
2. If the document itself is scrollable, Safari scrolls the page to reveal the focused field; `visualViewport.offsetTop` becomes > 0 and fixed elements appear to float. The single inner scroll container (3.1) prevents document scrolling, so `offsetTop` stays 0. If you must allow document scroll, apply `transform: translateY(${vv.offsetTop + vv.height - window.innerHeight}px)` (MDN's "device-fixed" example: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport).
3. `blur`/`focus` between blocks fires `keyboardWillHide`/`Show` pairs; debounce `apply(0)` by ~100 ms or move focus without blurring (3.4).
4. iOS 26.0/26.1 leaves `visualViewport.height` ≈ 24 px short after dismissal → the dead-band and the post-blur re-measure above.
5. In Safari tabs the system form accessory bar (◀ ▶ Done) is always present above the keyboard and you cannot remove it; only Capacitor can (`setAccessoryBarVisible`). Design the toolbar to look fine stacked under it.
6. Android with `resizes-content`: `--kb` stays 0 and `bottom: 0` inside the shrunken shell is already right; nothing else to do. In Capacitor Android the WebView resizes natively (`adjustResize`); keep `--kb` = 0 there (only apply Keyboard events on iOS, or set `resizeOnFullScreen: true` if you go fullscreen).

### 3.4 Focus management on iOS ("Enter creates a block and focuses it")

Rule (Safari): the keyboard is only *raised* by `focus()` called synchronously inside a trusted user-event handler (touch/click/key). `focus()` from a resolved promise, `setTimeout`, or after an async render is silently ignored — the keyboard drops. But **moving focus between editable elements while one is already focused (keyboard up) is allowed**, and a key event (Enter) *is* a user gesture.

Design that avoids the problem entirely: one editor element that moves.

```tsx
// Enter handler — everything synchronous, inside the trusted keydown
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const newId = flushSync(() => store.splitBlockAtCaret(currentId));   // React: commit synchronously so the row exists
    editorHost.attachTo(newId);       // re-parents the SAME <textarea>/EditorView into the new row and sets its value
    editorHost.el.focus();            // still the same task → keyboard stays up; also fine on desktop
    editorHost.el.setSelectionRange(0, 0);
  }
}
```
When you cannot avoid async work (opening a page, loading a block from the DB), use the hidden-input handoff (Logseq's `mobile-focus-hidden-input` does this):

```ts
// inside the tap handler (trusted):
hiddenInput.focus();                 // keyboard comes up now
const block = await db.loadBlock(id); // async
render(block);
editorEl.focus();                    // focus *transfer* → keyboard stays
```
Other rules: never call `blur()` between blocks; toolbar buttons `preventDefault()` on `pointerdown`; use `inputmode`/`enterkeyhint` per field; `autofocus` does not raise the keyboard on iOS. Sources: https://blog.mobiscroll.com/annoying-ios-safari-input-issues-with-workarounds/ , Logseq `src/main/frontend/mobile/util.cljs`.

### 3.5 Swipe a block to indent/outdent (Workflowy-style)

Use Pointer Events with `touch-action: pan-y` on the row: the browser keeps vertical scrolling native and hands you horizontal moves (a vertical pan cancels your pointer with `pointercancel`). `touch-action` must already be set when the touch starts (Safari reads it at `pointerdown`).

```css
.block-row { touch-action: pan-y; will-change: transform; }
.block-row.swiping { transition: none; } .block-row { transition: transform 150ms ease-out; }
```
```ts
export function attachSwipe(row: HTMLElement, id: string, actions: { indent(id: string): void; outdent(id: string): void }) {
  let start: { x: number; y: number } | null = null, mode: 'undecided' | 'swipe' | 'scroll' = 'undecided', dx = 0;
  row.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return; start = { x: e.clientX, y: e.clientY }; mode = 'undecided'; dx = 0;
    row.setPointerCapture(e.pointerId);
  });
  row.addEventListener('pointermove', e => {
    if (!start) return; dx = e.clientX - start.x; const dy = e.clientY - start.y;
    if (mode === 'undecided') { if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) mode = 'scroll'; else if (Math.abs(dx) > 12) { mode = 'swipe'; row.classList.add('swiping'); } }
    if (mode === 'swipe') { e.preventDefault(); row.style.transform = `translateX(${Math.max(-72, Math.min(72, dx))}px)`; }
  });
  const end = () => {
    if (mode === 'swipe') { if (dx > 48) { actions.indent(id); haptics.selection(); } else if (dx < -48) { actions.outdent(id); haptics.selection(); } }
    row.classList.remove('swiping'); row.style.transform = ''; start = null; mode = 'undecided';
  };
  row.addEventListener('pointerup', end); row.addEventListener('pointercancel', end);
}
```
Show a faint chevron/indent guide under the row proportional to `dx` for affordance; skip the gesture while text is selected.

### 3.6 Long-press to drag blocks

Drag from the **bullet/handle**, not the text (text long-press must stay iOS text selection). On the handle: `touch-action: none; -webkit-touch-callout: none; user-select: none`. Activate after 250–400 ms with < 8 px movement; `setPointerCapture`; render a lifted clone with `transform` + shadow; auto-scroll the `.page-scroll` container near edges; drop targets computed from cached row rects. dnd-kit's `PointerSensor` with `activationConstraint: { delay: 300, tolerance: 8 }` implements exactly this if you use React. Fire `haptics.impact('medium')` on lift and `selection()` when the drop index changes.

### 3.7 Haptics

```ts
export const haptics = {
  impact: (style: 'light' | 'medium' | 'heavy' = 'light') => platform.haptics?.impact(style) ?? navigator.vibrate?.(style === 'heavy' ? 30 : 10),
  selection: () => platform.haptics?.selection() ?? navigator.vibrate?.(5),
  notify: (t: 'success' | 'warning' | 'error') => platform.haptics?.notification(t) ?? navigator.vibrate?.([10, 40, 10]),
};
```
`navigator.vibrate`: Chrome Android only (needs a user gesture), Safari none, Firefox Android disabled. In Capacitor use `@capacitor/haptics` (`Haptics.impact({ style: ImpactStyle.Light })`, `selectionChanged()`, `notification()`); in Tauri mobile `@tauri-apps/plugin-haptics`. *(Known hack, use sparingly: toggling an `<input type="checkbox" switch>` produces a system haptic in Safari 17.4+; it is a side effect of the switch control, not an API.)*

### 3.8 Overscroll, pull-to-refresh, tap highlight, zoom, selection

- `html, body { overscroll-behavior: none }` disables Chrome Android's pull-to-refresh and Safari 16+ rubber-banding on the document (partial: only when the element is a scroll container with overflow; the fixed shell + inner container pattern is what actually stops iOS bounce on the body).
- `-webkit-tap-highlight-color: transparent` on interactive elements; `touch-action: manipulation` on buttons (kills double-tap zoom).
- Keep inputs ≥ 16 px rather than `maximum-scale=1` (accessibility).
- `-webkit-touch-callout: none` on bullets/handles and images you don't want the preview sheet on; `user-select: none` on chrome, but never on the editor.
- `content-visibility: auto` on collapsed subtrees / off-screen pages to keep long outlines cheap (Safari 18+).

### 3.9 Page transitions, scroll restoration, back/forward cache

- Same-document View Transitions: Chrome 111+, Safari 18+, Firefox 144+ → use them for page → page navigation in the SPA; respect `prefers-reduced-motion`.
```ts
export function navigate(to: string) {
  const go = () => router.replace(to);
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
  document.startViewTransition(() => { go(); });
}
```
```css
::view-transition-old(page) { animation: 180ms ease-out both slide-out; } ::view-transition-new(page) { animation: 180ms ease-out both slide-in; }
.page { view-transition-name: page; }
```
Cross-document transitions (Chrome 126+, Safari 18.2+) are irrelevant for an SPA.
- Scroll restoration: `history.scrollRestoration = 'manual'`; store `{ blockId, offset }` per history entry (block id, not pixels, because virtualised/collapsed outlines change height); restore after the page's blocks are mounted. Listen to `pageshow` (`event.persisted`) to refresh state when the page comes back from bfcache.

---

## 4. Deep links, share-to-app, quick capture, shortcuts, Siri

**URL grammar (same on every platform):**
- `vrite://page/<name>` ↔ `https://<host>/page/<name>`
- `vrite://block/<uuid>` ↔ `https://<host>/block/<uuid>`
- `vrite://capture?text=…&url=…&title=…` ↔ `https://<host>/capture?text=…` → appends to today's journal locally first, then syncs; shows a 1-screen confirm/edit sheet.
- `vrite://search?q=…`

**Why a custom scheme and not universal links:** universal/app links need `apple-app-site-association` / `assetlinks.json` on the *exact* domain and the domains listed in the app's entitlements at build time. With self-hosted servers every user has a different domain, so only an official hosted domain could get universal links. Ship `vrite://` everywhere; offer "Open in app" from the web app on mobile.

**Capacitor:** Info.plist `CFBundleURLTypes` (scheme `vrite`), Android `<intent-filter>` with `<data android:scheme="vrite"/>`; handle warm and cold starts:
```ts
import { App } from '@capacitor/app';
App.addListener('appUrlOpen', ({ url }) => deepLinks.open(url));
App.getLaunchUrl().then(r => r?.url && deepLinks.open(r.url));   // cold start fires before listeners exist
```
(Logseq does exactly this, and dedupes because `appUrlOpen` can fire twice for one intent — `src/main/mobile/init.cljs`.) https://capacitorjs.com/docs/guides/deep-links

**Tauri:** `tauri-plugin-deep-link` 2.4.10 on all platforms; mobile schemes must be declared in `tauri.conf.json` (`plugins.deep-link.mobile`), desktop in `plugins.deep-link.desktop`; on macOS the scheme only works for a bundled app in /Applications; on Windows/Linux pair with `single-instance` (`deep-link` feature) so a running instance receives the URL. https://v2.tauri.app/plugin/deep-linking/

**PWA:** Android WebAPK captures in-scope `https://` links; `protocol_handlers` (`web+vrite`) only on Chrome desktop. iOS: nothing — links open in Safari (separate storage!).

**Share-to-app:**
- Android PWA: `share_target` GET → `/capture?text=&url=&title=` (POST + files needs a SW `fetch` handler; MDN example).
- Capacitor Android: `ACTION_SEND` intent filter (`send-intent` plugin or ~50 lines of Kotlin in `MainActivity`).
- Capacitor iOS: a **Share Extension** target (Swift) writes the payload to an App Group container and opens `vrite://capture?…`; `send-intent` (MIT) and `@capgo/capacitor-share-target` provide the scaffolding. This is the only way to get vrite into the iOS share sheet.
- Tauri mobile: no plugin; native code needed.

**Quick capture (the #1 mobile use case):**
1. Always-visible "+" (FAB) on the journal, and `start_url=/journal/today` with the composer pre-opened (cannot pre-raise the keyboard on iOS; one tap is the floor).
2. Icon quick actions: PWA `shortcuts` (Android/desktop only); Capacitor `@capawesome/capacitor-app-shortcuts` (iOS + Android; `set()`, `addListener('click')`).
3. Share sheet (above).
4. **iOS Shortcuts / Siri / Action Button / Back Tap / lock-screen widget** — all via the Shortcuts app running "Open URL → `vrite://capture?text=[Dictated text]`". That gives "Hey Siri, vrite this" for free without App Intents; document a ready-made shortcut. Requires the Capacitor build (a PWA's URL would open Safari, whose storage is not the app's).
5. Android: Quick Settings tile / widget need native code — later.
6. Desktop: global hotkey (section 5).

Push/badging are secondary for vrite (sync is pull-based); reminders could use local notifications (`@capacitor/local-notifications`) or Declarative Web Push on the PWA.

---

## 5. Desktop: minimal story for v1

- **v1: installed PWA.** Chrome/Edge "Install" (Windows/macOS/Linux) and Safari "Add to Dock" (macOS 14+). Offline via the SW; updates instantly. Keyboard shortcuts: an installed PWA window receives almost everything, but the browser still owns Cmd/Ctrl+W/T/N/Q, Cmd+Shift+T, Ctrl+Tab, Cmd+, (settings), F11/Cmd+Ctrl+F, Cmd+L (Chrome), Cmd+H (macOS). Don't bind those; expose rebinding. `display_override: ["window-controls-overlay"]` lets Chrome draw a native-looking title bar (`env(titlebar-area-*)`).
- **What a PWA cannot do:** global (system-wide) quick-capture hotkey, tray/menu-bar item, launch at login, custom URL scheme on macOS (Chrome desktop supports `protocol_handlers` for `web+vrite` only), local Node/Ollama integration beyond HTTP.
- **v1.5: Tauri 2 wrapper** for exactly those:

```ts
// desktop-only startup (Tauri)
import { register } from '@tauri-apps/plugin-global-shortcut';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { TrayIcon } from '@tauri-apps/api/tray';
import { Menu } from '@tauri-apps/api/menu';

async function openCapture() {
  const w = await WebviewWindow.getByLabel('capture') ?? new WebviewWindow('capture',
    { url: '/capture?source=hotkey', width: 560, height: 220, decorations: false, alwaysOnTop: true, resizable: false, skipTaskbar: true });
  await w.show(); await w.setFocus();
}
await register('CommandOrControl+Shift+Space', e => { if (e.state === 'Pressed') openCapture(); });
const menu = await Menu.new({ items: [
  { id: 'capture', text: 'Quick capture', action: openCapture },
  { id: 'open', text: 'Open vrite', action: () => WebviewWindow.getByLabel('main').then(w => w?.show()) },
  { id: 'quit', text: 'Quit', action: () => import('@tauri-apps/plugin-process').then(m => m.exit(0)) },
] });
await TrayIcon.new({ icon: 'icons/tray.png', menu, tooltip: 'vrite', menuOnLeftClick: true });
```
Cargo: `tauri = { features = ["tray-icon"] }`, plugins `global-shortcut`, `single-instance`, `deep-link`, `updater`, `autostart`, `window-state`, `sql` (or your own rusqlite commands). Capability files must allow `global-shortcut:allow-register`, `tray`, `menu`, `webview-window` permissions. (Rust-side registration, per the Tauri docs, is equally short if you'd rather keep the handler out of the webview.) https://v2.tauri.app/plugin/global-shortcut/ , https://v2.tauri.app/learn/system-tray/
- Electron only if you decide the desktop app should embed the Node sync server; otherwise Tauri.

---

## 6. One codebase → web/PWA, Capacitor, Tauri: the `platform` layer

Build once with Vite (`dist/`); Capacitor `webDir: 'dist'`, Tauri `frontendDist: '../dist'`. Detect at runtime and load adapters lazily so the web bundle never pulls native SDKs:

```ts
// src/platform/index.ts
export type PlatformKind = 'web' | 'pwa' | 'capacitor-ios' | 'capacitor-android' | 'tauri-desktop' | 'tauri-mobile';
export interface Platform {
  kind: PlatformKind;
  db: DbDriver;                       // exec/query/transaction over SQLite; same schema everywhere
  keyboard: KeyboardAdapter;          // sets --kb, hides accessory bar, hide()
  haptics?: { impact(s: 'light'|'medium'|'heavy'): void; selection(): void; notification(t: 'success'|'warning'|'error'): void };
  share: { canShare(): boolean; share(d: { title?: string; text?: string; url?: string; files?: File[] }): Promise<void> };
  files: { pick(accept: string[]): Promise<File[]>; save(name: string, blob: Blob): Promise<void> };
  deepLinks: { onOpen(cb: (url: string) => void): () => void; launchUrl(): Promise<string | null> };
  shortcuts?: { set(items: { id: string; title: string; url: string }[]): Promise<void> };
  notifications?: { requestPermission(): Promise<boolean>; local(n: LocalNotification): Promise<void>; setBadge?(n: number): Promise<void> };
  lifecycle: { onResume(cb: () => void): () => void; onPause(cb: () => void): () => void; onOnline(cb: (online: boolean) => void): () => void };
  secureStore: { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> };  // sync tokens
  updates: { check(): Promise<void>; onAvailable(cb: (apply: () => void) => void): void };            // SW vs Tauri updater vs store
  safeArea: { top: number; bottom: number };                                                          // for JS-side layout math
}

export async function createPlatform(): Promise<Platform> {
  if ('__TAURI_INTERNALS__' in window) return (await import('./tauri')).create();
  const cap = (window as any).Capacitor;
  if (cap?.isNativePlatform?.()) return (await import('./capacitor')).create(cap.getPlatform());
  return (await import('./web')).create();
}
```
Adapters:
- **web/pwa:** `db` = wa-sqlite OPFSCoopSyncVFS (or sqlite-wasm opfs-sahpool) in a dedicated Worker with `navigator.locks` leader election, IDB VFS fallback; `keyboard` = visualViewport; `share` = `navigator.share`; `files` = `<input type=file>` / `<a download>` (File System Access when present); `deepLinks` = parse `location` + `protocol_handlers`; `lifecycle` = `visibilitychange`/`online`; `updates` = SW `onNeedRefresh`; `secureStore` = IndexedDB (tokens are not secret from the device anyway).
- **capacitor:** `db` = `@capacitor-community/sqlite`; `keyboard` = Keyboard plugin (iOS) / no-op (Android); `haptics`, `share`, `files` (Filesystem + Share), `deepLinks` (App plugin), `shortcuts` (Capawesome), `notifications` (Local/Push), `lifecycle` (`appStateChange`, Network), `secureStore` (Preferences or a keychain plugin), `updates` = store / Capgo live update. Skip SW registration.
- **tauri:** `db` = start with the same wasm driver as web (WKWebView/WebView2 both support OPFS), later `plugin-sql`/rusqlite via `invoke`; `deepLinks` = plugin-deep-link; `updates` = plugin-updater; desktop extras (global shortcut, tray) live in `platform/tauri/desktop.ts`; on Tauri mobile fall back to the web keyboard adapter and `plugin-haptics`.
- Everything above the platform layer (outliner, sync engine, search) sees only the interfaces. Use `import.meta.env.VITE_TARGET` for the rare compile-time branches (e.g. not bundling `virtual:pwa-register` into native builds).
- The sync engine treats every platform the same: local outbox in SQLite, flush on `lifecycle.onResume/onOnline/onPause` (use `fetch(..., { keepalive: true })` on pause), never rely on Background Sync.

---

## 7. iOS-specific risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Storage is best-effort; ITP 7-day purge for Safari-tab usage; eviction under pressure | Loss of unsynced edits, forced re-sync | Home-Screen install (own days-of-use counter), `persist()` + `persisted()` check, aggressive outbox flush, server is truth, "unsynced" indicator |
| Separate storage per Safari / each Home-Screen icon / WKWebView | Empty DB after install, no cross-icon tricks | Fast first-sync, "install" onboarding, one icon only, Capacitor for capture entry points |
| No `interactive-widget`; iOS 26.0/26.1 fixed-position + `visualViewport` regressions | Toolbar under/over keyboard, jitter | Fixed shell + inner scroll + `--kb` from visualViewport; dead-band + post-blur re-measure; Capacitor Keyboard plugin gives exact heights |
| Keyboard only rises inside a trusted event; async `focus()` ignored | Enter/new-block loses keyboard | Single moving editor element, `flushSync`, hidden-input handoff, toolbar `pointerdown.preventDefault()` |
| No share target / shortcuts / link capturing / protocol handlers for PWAs | Quick capture limited to opening the app | Capacitor build: share extension, `vrite://` + Shortcuts/Siri, app shortcuts |
| No background execution or Background Sync | Sync only while foregrounded | Flush on pause with keepalive; resume-sync on foreground |
| WKWebView quota 15 %/20 % of disk (non-browser apps) | Large graphs with attachments in Capacitor wasm/OPFS | Native SQLite + Filesystem for attachments |
| OPFS handles closed when Capacitor app backgrounds (PowerSync report) | DB errors on resume | Native SQLite (or IDB VFS) in Capacitor |
| System accessory bar (◀ ▶ Done) cannot be hidden in Safari | Two stacked bars | Design for it; hide via Capacitor |
| No `vibrate` | No haptic feedback on PWA | Capacitor Haptics; optional switch-checkbox hack |
| App Review 4.2 "minimum functionality" for web wrappers | Rejection | Offline-first, native integrations, no web-only login wall, privacy manifest, works without server |
| Xcode/iOS cadence: Cap 8 needs Xcode 26; 8.5 UIScene for Xcode 27 | Yearly migration chores | Stay on current Capacitor minor; `npx cap migrate` |
| Every iOS browser is WebKit | No escape hatch | Treat Safari as the only iOS target; keep Chrome-only APIs behind feature detection |

---

## Sources

- WebKit: Safari 26.0 features (Home Screen web apps default) https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ ; 26.4 https://webkit.org/blog/17862/webkit-features-for-safari-26-4/ ; 26.6 https://webkit.org/blog/18178/webkit-features-for-safari-26-6/ ; storage policy https://webkit.org/blog/14403/updates-to-storage-policy/ ; 7-day cap https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ; Web Push iOS https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ ; Declarative Web Push https://webkit.org/blog/16535/meet-declarative-web-push/ ; Badging https://webkit.org/blog/14112/badging-for-home-screen-web-apps/ ; macOS web apps https://webkit.org/blog/14205/news-from-wwdc23-webkit-features-in-safari-17-beta/
- WebKit bugs: interactive-widget 259770 (open) https://bugs.webkit.org/show_bug.cgi?id=259770 ; Web Share Target 194593 (open) https://bugs.webkit.org/show_bug.cgi?id=194593 ; iOS 26 fixed-position/visualViewport 297779 https://bugs.webkit.org/show_bug.cgi?id=297779 ; Apple forum thread https://developer.apple.com/forums/thread/800125
- MDN browser-compat-data (raw JSON, 2026-09): SyncManager, view-transition, interactive-widget, StorageManager.persist, manifests/webapp/{share_target,shortcuts,protocol_handlers,file_handlers,launch_handler}, Navigator.{vibrate,setAppBadge,share}, Window.{launchQueue,showOpenFilePicker}, FileSystemSyncAccessHandle, VirtualKeyboard, PushManager, css env(), overscroll-behavior — https://github.com/mdn/browser-compat-data ; caniuse view-transitions https://caniuse.com/view-transitions ; VisualViewport https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport ; share_target https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target ; VirtualKeyboard API https://developer.chrome.com/docs/web-platform/virtual-keyboard
- Storage: PowerSync "SQLite persistence on the web, May 2026" https://powersync.com/blog/sqlite-persistence-on-the-web ; sqlite.org persistence https://sqlite.org/wasm/doc/trunk/persistence.md ; web.dev persistent storage https://web.dev/articles/persistent-storage ; install criteria https://web.dev/articles/install-criteria ; MagicBell iOS PWA limitations guide (2026; note its EU-push claim is stale) https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide ; Firt on iOS persistence https://medium.com/@firt/there-is-no-persistent-storage-api-on-ios-and-you-dont-have-control-of-that-unfortunately-because-361adb5e9dc0
- Capacitor: 8 announcement https://ionic.io/blog/announcing-capacitor-8 ; 8.5 https://ionic.io/blog/capacitor-8-5-released ; upgrade guide https://capacitorjs.com/docs/updating/8-0 ; config https://capacitorjs.com/docs/config ; Keyboard https://capacitorjs.com/docs/apis/keyboard ; SystemBars https://capacitorjs.com/docs/apis/system-bars ; deep links https://capacitorjs.com/docs/guides/deep-links ; App Store https://capacitorjs.com/docs/ios/deploying-to-app-store ; community sqlite https://github.com/capacitor-community/sqlite ; send-intent https://github.com/carsten-klaffke/send-intent ; Capawesome share-target (sponsor-only) https://capawesome.io/plugins/share-target/ ; app-shortcuts https://capawesome.io/plugins/app-shortcuts/
- Logseq mobile (real-world Capacitor reference): https://github.com/logseq/logseq/blob/master/capacitor.config.ts ; https://github.com/logseq/logseq/blob/master/src/main/mobile/externals.js ; https://github.com/logseq/logseq/blob/master/src/main/mobile/init.cljs ; https://github.com/logseq/logseq/blob/master/src/main/frontend/mobile/util.cljs
- Tauri: plugins matrix https://v2.tauri.app/plugin/ ; prerequisites https://v2.tauri.app/start/prerequisites/ ; webviews https://v2.tauri.app/reference/webview-versions/ ; mobile dev https://v2.tauri.app/develop/ ; deep-link https://v2.tauri.app/plugin/deep-linking/ ; global shortcut https://v2.tauri.app/plugin/global-shortcut/ ; sql https://v2.tauri.app/plugin/sql/ ; App Store https://v2.tauri.app/distribute/app-store/ ; 2.0 release https://v2.tauri.app/blog/tauri-20/
- Others: Electron releases https://releases.electronjs.org/ ; Wails v3 beta https://v3.wails.io/blog/wails-v3-beta/ ; Neutralino https://github.com/neutralinojs/neutralinojs/releases ; ToDesktop https://www.todesktop.com/changelog ; Expo DOM components https://docs.expo.dev/guides/dom-components/ ; TWA https://developer.chrome.com/docs/android/trusted-web-activity/ ; iOS focus workarounds https://blog.mobiscroll.com/annoying-ios-safari-input-issues-with-workarounds/ ; interactive-widget explainer https://github.com/bramus/viewport-resize-behavior/blob/main/explainer.md
