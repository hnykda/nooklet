/**
 * Capacitor implementation of `Platform` (ADR 005, M5 BUILD item 6): real haptics, share, deep
 * links and lifecycle via the actual `@capacitor/*` plugins research/08-mobile.md §2.1/§3.2/§4
 * document, and exact-height keyboard events from `@capacitor/keyboard` in place of the web
 * adapter's `visualViewport` measurement/dead-band/re-measure dance (Capacitor tells us the real
 * number, so `keyboard.ts`'s heuristics are a web-only concern).
 *
 * Every `@capacitor/*` package is imported dynamically (lazily, on first use, cached per module)
 * even though `index.ts` imports THIS file statically — research/08-mobile.md §6: "Detect at
 * runtime and load adapters lazily so the web bundle never pulls native SDKs." A plain web/PWA
 * build therefore never fetches `@capacitor/keyboard` etc.; only a build actually running inside a
 * Capacitor shell (`index.ts`'s `isCapacitorNative()` check) ever calls into this file's exported
 * methods, at which point the dynamic imports resolve against the real native bridge.
 *
 * NOT implemented here: native SQLite in place of OPFS (the other half of BUILD item 6) — see the
 * doc comment at the bottom of this file for why that swap cannot happen at the `platform/` seam
 * and what it would actually take.
 */
import { applyInset, type KeyboardStyleTarget } from "./keyboard.js";
import { claimLaunchUrl, markUrlHandled } from "./launch-url.js";
import type { KeyboardHandle, LifecycleEvent, Platform } from "./types.js";

let keyboardModule: Promise<typeof import("@capacitor/keyboard")> | undefined;
function keyboard(): Promise<typeof import("@capacitor/keyboard")> {
  if (!keyboardModule) keyboardModule = import("@capacitor/keyboard");
  return keyboardModule;
}

let hapticsModule: Promise<typeof import("@capacitor/haptics")> | undefined;
function hapticsPlugin(): Promise<typeof import("@capacitor/haptics")> {
  if (!hapticsModule) hapticsModule = import("@capacitor/haptics");
  return hapticsModule;
}

let shareModule: Promise<typeof import("@capacitor/share")> | undefined;
function sharePlugin(): Promise<typeof import("@capacitor/share")> {
  if (!shareModule) shareModule = import("@capacitor/share");
  return shareModule;
}

let filesystemModule: Promise<typeof import("@capacitor/filesystem")> | undefined;
function filesystemPlugin(): Promise<typeof import("@capacitor/filesystem")> {
  if (!filesystemModule) filesystemModule = import("@capacitor/filesystem");
  return filesystemModule;
}

let appModule: Promise<typeof import("@capacitor/app")> | undefined;
function appPlugin(): Promise<typeof import("@capacitor/app")> {
  if (!appModule) appModule = import("@capacitor/app");
  return appModule;
}

// ---------------------------------------------------------------------------------------------
// Keyboard: exact height events, not a visualViewport measurement (research/08 §3.2's
// `capacitorKeyboard` reference, and the Logseq precedent §2.1/§3.2 cites: `KeyboardResize.None`
// plus a CSS variable the app's own layout uses for padding).
// ---------------------------------------------------------------------------------------------

function startKeyboardWatcher(
  root: KeyboardStyleTarget = document.documentElement,
): KeyboardHandle {
  let stopped = false;
  let removeListeners: (() => void) | undefined;

  void (async () => {
    const { Keyboard, KeyboardResize } = await keyboard();
    // We own layout entirely via --kb (the same variable the web adapter drives) rather than
    // letting iOS resize the WebView itself — Logseq's own capacitor.config.ts does exactly this
    // (research/08 §2.1/§3.2).
    await Keyboard.setResizeMode({ mode: KeyboardResize.None }).catch(() => {});
    // iPhone-only; a harmless no-op on Android — frees the space our own toolbar uses instead of
    // stacking under the system's un-hideable ◀ ▶ Done bar (research §3.3 pitfall 5).
    await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {});
    if (stopped) return;
    const shown = await Keyboard.addListener("keyboardWillShow", ({ keyboardHeight }) =>
      applyInset(root, keyboardHeight),
    );
    const hidden = await Keyboard.addListener("keyboardWillHide", () => applyInset(root, 0));
    if (stopped) {
      void shown.remove();
      void hidden.remove();
      return;
    }
    removeListeners = () => {
      void shown.remove();
      void hidden.remove();
    };
  })();

  return {
    stop() {
      stopped = true;
      removeListeners?.();
      applyInset(root, 0);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Haptics: real device haptics (research §3.7) instead of the web adapter's `navigator.vibrate`
// (Safari has none at all; Chrome Android needs a user gesture). Fire-and-forget, matching the
// synchronous `HapticsAdapter` contract every caller already expects.
// ---------------------------------------------------------------------------------------------

function impact(style: "light" | "medium" | "heavy" = "light"): void {
  void hapticsPlugin().then(({ Haptics, ImpactStyle }) =>
    Haptics.impact({
      style:
        style === "heavy"
          ? ImpactStyle.Heavy
          : style === "medium"
            ? ImpactStyle.Medium
            : ImpactStyle.Light,
    }),
  );
}

function selection(): void {
  void hapticsPlugin().then(({ Haptics }) => Haptics.selectionChanged());
}

function notify(type: "success" | "warning" | "error"): void {
  void hapticsPlugin().then(({ Haptics, NotificationType }) =>
    Haptics.notification({
      type:
        type === "success"
          ? NotificationType.Success
          : type === "warning"
            ? NotificationType.Warning
            : NotificationType.Error,
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Share: outbound only (receiving needs a Share Extension/intent filter built at the native
// project level — research §4 "Share-to-app"; out of scope for config-only, no-Xcode work, and
// tracked in apps/web/README.md's "what a human must run" section).
// ---------------------------------------------------------------------------------------------

async function doShare(data: { title?: string; text?: string; url?: string }): Promise<boolean> {
  try {
    const { Share } = await sharePlugin();
    const can = await Share.canShare();
    if (!can.value) return false;
    await Share.share(data);
    return true;
  } catch {
    return false;
  }
}

/** A blob's bytes as base64, which is what `Filesystem.writeFile` takes for binary data. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * B-736: the native share sheet takes `file://` URLs, not bytes — so the file goes to the app's
 * cache directory first (the OS may clear it; nothing else needs it) and is shared from there.
 * The sheet is where "Save Image" / "Save to Files" live on both platforms, so this is the phone's
 * download as well as its share.
 */
async function doShareFile(file: { name: string; blob: Blob }): Promise<boolean> {
  try {
    const [{ Share }, { Filesystem, Directory }] = await Promise.all([
      sharePlugin(),
      filesystemPlugin(),
    ]);
    if (!(await Share.canShare()).value) return false;
    const safeName = file.name.replace(/[^\w.\- ]+/g, "_") || "image";
    const written = await Filesystem.writeFile({
      path: `shared/${safeName}`,
      directory: Directory.Cache,
      data: await blobToBase64(file.blob),
      recursive: true,
    });
    await Share.share({ files: [written.uri] });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Deep links: `nooklet://...` opens, cold start included, deduped — research §4: "Logseq...
// dedupes because appUrlOpen can fire twice for one intent."
// ---------------------------------------------------------------------------------------------

function onOpen(cb: (url: string) => void): () => void {
  let lastUrl: string | undefined;
  let lastAt = 0;
  const notifyOnce = (url: string): void => {
    const now = Date.now();
    if (url === lastUrl && now - lastAt < 500) return;
    lastUrl = url;
    lastAt = now;
    cb(url);
  };

  let stopped = false;
  let removeListener: (() => void) | undefined;

  void (async () => {
    const { App } = await appPlugin();
    const handle = await App.addListener("appUrlOpen", (e) => {
      markUrlHandled(e.url, globalThis.sessionStorage);
      notifyOnce(e.url);
    });
    if (stopped) {
      void handle.remove();
      return;
    }
    removeListener = () => void handle.remove();
    // Cold start: the listener above misses the URL the process was launched with, so it must
    // also be checked explicitly (research §4's `App.getLaunchUrl()` call, right after
    // `addListener` so a URL that arrives between the two is never dropped).
    // `claimLaunchUrl`/`markUrlHandled`: `getLaunchUrl()` is really "last opened URL" and
    // outlives a page reload (see `launch-url.ts`).
    const launch = await App.getLaunchUrl();
    if (launch?.url && claimLaunchUrl(launch.url, globalThis.sessionStorage)) {
      notifyOnce(launch.url);
    }
  })();

  return () => {
    stopped = true;
    removeListener?.();
  };
}

// ---------------------------------------------------------------------------------------------
// Lifecycle: native pause/resume (the App plugin) instead of the web adapter's `visibilitychange`
// proxy for those two; online/offline/visible/hidden stay ordinary DOM events, which fire
// correctly inside a Capacitor WebView too.
// ---------------------------------------------------------------------------------------------

function onLifecycle(event: LifecycleEvent, cb: () => void): () => void {
  switch (event) {
    case "online":
      window.addEventListener("online", cb);
      return () => window.removeEventListener("online", cb);
    case "offline":
      window.addEventListener("offline", cb);
      return () => window.removeEventListener("offline", cb);
    case "visible":
    case "hidden": {
      const handler = () => {
        if (document.visibilityState === event) cb();
      };
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    }
    case "pause":
    case "resume": {
      let stopped = false;
      let removeListener: (() => void) | undefined;
      void (async () => {
        const { App } = await appPlugin();
        // Two literal calls (not one call with a `"pause" | "resume"` union) — `addListener` is
        // overloaded per event-name literal, and TS can't dispatch a union across overloads.
        const handle =
          event === "pause"
            ? await App.addListener("pause", cb)
            : await App.addListener("resume", cb);
        if (stopped) {
          void handle.remove();
          return;
        }
        removeListener = () => void handle.remove();
      })();
      return () => {
        stopped = true;
        removeListener?.();
      };
    }
    default: {
      const exhaustive: never = event;
      throw new Error(`unknown lifecycle event: ${exhaustive as string}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Storage (docs/proposals/004-capacitor-storage-durability.md, Option A): this used to be a
// hardcoded no-op under the assumption native SQLite would land first, making `navigator.storage`
// irrelevant (it governs the WebView's own OPFS quota, not a native SQLite file). It hasn't landed
// — a Capacitor build still runs OPFS (`../db/sqlite-wasm-driver.ts`) — so that assumption made
// this the one API that actually protects against *automatic* eviction never being called at all.
// Same implementation as `./web.ts`: `navigator.storage` is a standard Web API, still present
// inside a Capacitor WKWebView.
// ---------------------------------------------------------------------------------------------

export const capacitorPlatform: Platform = {
  name: "capacitor",
  storage: {
    async persist() {
      try {
        return (await navigator.storage?.persist?.()) ?? false;
      } catch {
        return false;
      }
    },
    async persisted() {
      try {
        return (await navigator.storage?.persisted?.()) ?? false;
      } catch {
        return false;
      }
    },
    async estimate() {
      try {
        const e = await navigator.storage?.estimate?.();
        return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : undefined;
      } catch {
        return undefined;
      }
    },
  },
  haptics: { impact, selection, notify },
  share: { share: doShare, shareFile: doShareFile },
  deepLinks: { onOpen },
  lifecycle: { on: onLifecycle },
  startKeyboardWatcher: () => startKeyboardWatcher(),
};

/**
 * NOT implemented here: native SQLite in place of OPFS (BUILD item 6's other half, research §1.3's
 * "OPFS access handles are closed when a Capacitor app backgrounds").
 *
 * `@nooklet/core`'s `SqlDriver` (`packages/core/src/sync/driver.ts`) is deliberately SYNCHRONOUS —
 * `exec`/`run`/`all`/`get` return values directly, not Promises — so `db/worker-core.ts`'s
 * `WorkerDb` can call it exactly like `better-sqlite3`/`node:sqlite`. Every
 * `@capacitor-community/sqlite` call is an async native-bridge call, like every Capacitor plugin
 * method above, and the bridge itself only exists on `window` — a dedicated Worker's global scope
 * has no `window`, so even an async-capable driver could not reach it from inside `db.worker.ts`
 * without a second, hand-rolled postMessage relay back to the main thread for every single query.
 *
 * Wiring real native SQLite therefore needs one of:
 * 1. An async-capable `SqlDriver`/`applyOps` in `packages/core` (shared by the server and every
 *    client — a cross-cutting change), or
 * 2. Moving `WorkerDb` off the dedicated Worker and onto the main thread for Capacitor builds,
 *    where it can reach `window.Capacitor` directly (at the cost of losing the worker-isolation
 *    this milestone's foundation deliberately built).
 * Either is real, cross-cutting work beyond this milestone's scope, and — per this task's own
 * instructions — not verifiable here without a device/simulator regardless.
 *
 * Until one lands, a Capacitor build should keep using the existing
 * `../db/sqlite-wasm-driver.ts` (`opfs-sahpool`), which research/08 §2.1 confirms already runs
 * inside a Capacitor WKWebView: "no COOP/COEP needed — a custom-scheme handler cannot provide
 * cross-origin isolation, so the SharedArrayBuffer-based `opfs` VFS is out [anyway]." What IS done,
 * short of that larger change (docs/proposals/004-capacitor-storage-durability.md, Options A–C):
 * the real `persist()` call above, `../db/reopen-on-resume.ts` (reopens the sahpool connection
 * after the app resumes from background, the PowerSync failure this file's intro cites), and a
 * periodic checkpoint to `@capacitor/filesystem` as a backstop outside OPFS entirely, wired from
 * `../db/client.ts` (main-thread only — like `@capacitor-community/sqlite`, `@capacitor/filesystem`
 * needs `window`, which the dedicated Worker `db.worker.ts` runs in does not have). See
 * `apps/web/README.md`'s Capacitor section for the human-facing version of this note.
 */
