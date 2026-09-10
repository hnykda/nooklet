/**
 * Resolves the `WhenContext.platform`/`mobile` fields (R7) from the runtime environment. This is
 * intentionally small and pure-ish: `detectPlatform`/`detectMobile` take an injectable
 * `navigator`-shaped object so they're fully unit-testable without a real browser, and
 * `detectPlatformFromEnvironment` is the one impure call site (reads the real `navigator`) that
 * the app wires up once, at startup (see provider/CommandProvider.tsx).
 */
import type { WhenContext } from "../types.js";

export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

/** Best-effort OS family detection from `navigator.userAgent`/`navigator.platform`. Order
 * matters: iPadOS 13+ reports as "MacIntel" with touch points, so it must be checked before the
 * plain "mac" branch. */
export function detectPlatform(nav: NavigatorLike): WhenContext["platform"] {
  const ua = nav.userAgent ?? "";
  const plat = nav.platform ?? "";

  if (/iPhone|iPod/.test(ua)) return "ios";
  // iPadOS reports UA as Macintosh but exposes touch points; real Macs report maxTouchPoints 0.
  if (/iPad/.test(ua) || (plat === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(plat) || /Macintosh/.test(ua)) return "mac";
  if (/Win/.test(plat) || /Windows/.test(ua)) return "windows";
  return "linux";
}

/** `mobile` (R7): `platform` is ios/android, OR the device is touch-primary with no hardware
 * keyboard detected — approximated here by "coarse pointer, no hover" (the standard touch-primary
 * media-query signal) since a real keyboard-attached check needs DOM APIs this pure function
 * doesn't have; callers on a real device additionally combine this with actual keyboard-event
 * observation over time if they have it (out of scope for this pure detector). */
export function detectMobile(platform: WhenContext["platform"], coarsePrimaryPointer: boolean): boolean {
  return platform === "ios" || platform === "android" || coarsePrimaryPointer;
}

/** The one impure call site: reads the real `navigator` and `matchMedia`, for app startup. */
export function detectPlatformFromEnvironment(): { platform: WhenContext["platform"]; mobile: boolean } {
  const nav: NavigatorLike =
    typeof navigator !== "undefined"
      ? { userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }
      : {};
  const platform = detectPlatform(nav);
  const coarsePrimaryPointer =
    typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches && !matchMedia("(hover: hover)").matches;
  return { platform, mobile: detectMobile(platform, coarsePrimaryPointer) };
}

/** R15: `Mod` resolves to `Cmd` on mac (and, per R14, mac-attached-keyboard iOS) and `Ctrl`
 * elsewhere. */
export function resolveModForPlatform(platform: WhenContext["platform"]): "Cmd" | "Ctrl" {
  return platform === "mac" || platform === "ios" ? "Cmd" : "Ctrl";
}
