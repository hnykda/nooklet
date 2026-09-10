/**
 * The active `Platform` for this build. Every other module imports the `Platform` type from
 * `./types.js` and the `platform` singleton from here — never `./web.js` (or a future
 * `./capacitor.js`) directly. That indirection is the whole point of ADR 005's adapter: dropping
 * in a Capacitor build later is "implement `./capacitor.ts`, branch on a build-time flag below",
 * with zero changes anywhere else in the app.
 */
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

export const platform: Platform = webPlatform;
