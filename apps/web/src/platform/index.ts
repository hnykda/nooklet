/**
 * The active `Platform` for this build. Every other module imports the `Platform` type from
 * `./types.js` and the `platform` singleton from here — never `./web.js`/`./capacitor.js`
 * directly. That indirection is the whole point of ADR 005's adapter: `./capacitor.ts` (M5 BUILD
 * item 6) drops in behind the exact same interface, selected below at runtime, with zero changes
 * anywhere else in the app.
 *
 * `./capacitor.ts` is imported statically (so this file can stay a synchronous module — every
 * caller does `platform.foo()` today, not `(await platform()).foo()`), but it does NOT pull in
 * any `@capacitor/*` package at import time: every plugin it uses is loaded with a lazy, cached
 * `import()` inside its own functions (see its doc comment), which only actually run once
 * `isCapacitorNative()` below is true. A plain web/PWA build therefore never fetches Capacitor's
 * native SDKs (research/08-mobile.md §6), even though this file always imports the small adapter
 * module that wraps them.
 */
import { capacitorPlatform } from "./capacitor.js";
import type { Platform } from "./types.js";
import { webPlatform } from "./web.js";

export type {
  DeepLinkAdapter,
  HapticsAdapter,
  KeyboardHandle,
  LifecycleAdapter,
  LifecycleEvent,
  Platform,
  ShareAdapter,
  StorageAdapter,
  StorageEstimate,
} from "./types.js";

interface CapacitorGlobalShape {
  isNativePlatform?: () => boolean;
}

function isCapacitorNative(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobalShape }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

export const platform: Platform = isCapacitorNative() ? capacitorPlatform : webPlatform;
