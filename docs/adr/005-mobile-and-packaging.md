# ADR 005: Client packaging: PWA first, Capacitor for stores, Tauri for desktop

Date: 2026-09-10. Status: accepted.

## Decision

- One Vite-built web client behind a small `platform` adapter (storage driver, keyboard insets,
  haptics, share, files, deep links, lifecycle).
- v1 ships as an installable PWA (service worker, OPFS-backed SQLite, `persist()`, badging).
- v1.x wraps the same build with Capacitor 8 for iOS/Android store apps, which adds native SQLite
  (no quota or eviction), exact keyboard height, share-sheet receiving, `vrite://` scheme for
  Shortcuts/Siri, and home-screen quick actions.
- Desktop gets Tauri 2 later for a global quick-capture hotkey, tray, and deep links. Electron,
  React Native, and Flutter are out.
- Native-feel rules for the web client: fixed app shell with a single inner scroll container,
  `viewport-fit=cover` and safe-area insets, a keyboard toolbar positioned by a measured `--kb`
  variable (never `bottom: 0`), one moving editor element re-parented between blocks so focus
  transfers inside trusted events, swipe to indent/outdent, long-press drag from the bullet.
- The local database on a phone is a cache plus an outbox; the server is the truth. Pending ops
  are flushed on pause/resume/online, never left to Background Sync.

## Why

The user wants the app to work the way native apps do without maintaining a second UI. iOS
storage for web apps is best-effort (separate containers per icon, eviction under pressure),
which makes "server is truth" mandatory anyway. Logseq's own mobile uses this exact Capacitor
configuration (`KeyboardResize.None` with a CSS keyboard-height variable).
