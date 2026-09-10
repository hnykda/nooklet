import type { CapacitorConfig } from "@capacitor/cli";
// Safe to import for real here (unlike `src/platform/capacitor.ts`'s lazy `import()`s): this file
// is read only by the Capacitor CLI on Node at build/sync time and never ships to the browser, so
// it does not affect the web/PWA bundle research/08-mobile.md §6 asks that file to stay lazy for.
import { KeyboardResize } from "@capacitor/keyboard";

/**
 * Capacitor 8 config for the nooklet iOS/Android store shell (ADR 005 "v1.x"; M5 BUILD item 5).
 *
 * Lives in `apps/web/` (not a separate `apps/mobile/`) because it wraps the SAME web build every
 * target uses (`webDir: "dist"`) — there is no separate mobile app code, only `src/platform/
 * capacitor.ts`'s implementation of the existing `Platform` adapter behaving differently at
 * runtime. A dedicated `apps/mobile/` would hold nothing but this file plus generated `ios/`/
 * `android/` native projects; Capacitor's own convention (and Logseq's, per research/08-mobile.md
 * §2.1's citation) is to keep `capacitor.config.ts` at the root of the web project it wraps, so
 * `npx cap` commands run from `apps/web/` naturally find both the config and `dist/`.
 *
 * This repo does NOT check in generated `ios/`/`android/` Xcode/Gradle projects — there is no
 * Xcode or Android Studio in this environment to generate or verify them (`npx cap add ios` /
 * `npx cap add android` need the respective native SDKs installed). See `README.md`'s "Capacitor:
 * what a human must run" section for the exact commands and the native-file edits (deep-link
 * scheme registration, share extension) that only make sense once those folders exist.
 */
const config: CapacitorConfig = {
  appId: "sh.nooklet.app",
  appName: "nooklet",
  webDir: "dist",

  // `server.hostname`/`server.iosScheme`/`server.androidScheme` are deliberately left at their
  // defaults (`localhost` / `capacitor` / `https`): research/08-mobile.md §2.1 warns "origin =
  // storage key — changing server.hostname/iosScheme later loses all webview data. Native SQLite
  // avoids this entirely" (once BUILD item 6's native-SQLite follow-up lands; until then the
  // OPFS-backed replica is exactly as origin-sensitive as that warning describes, so this must
  // not change after the first release).

  plugins: {
    Keyboard: {
      // We own layout entirely via the `--kb` CSS variable (`src/platform/capacitor.ts`); letting
      // iOS resize the WebView itself would fight that. Logseq's own capacitor.config.ts does the
      // same (research/08 §2.1/§3.2 cites `src/main/mobile/externals.js`).
      resize: KeyboardResize.None,
      // The device's light/dark appearance already drives the keyboard style; no override needed.
    },
  },
};

export default config;
