/**
 * Web implementation of `Platform` (ADR 005). Every capability iOS Safari/Android Chrome cannot
 * give a plain web app (native deep links, real haptics beyond `vibrate`, share *receiving*) is a
 * documented no-op here rather than a thrown error, so callers never need to branch on platform —
 * see research/08-mobile.md §1.4's capability matrix for exactly what is missing and why.
 */

import { createWebKeyboardWatcher } from "./keyboard.js";
import type { LifecycleEvent, Platform } from "./types.js";

function onVisibility(cb: () => void, want: DocumentVisibilityState): () => void {
  const handler = () => {
    if (document.visibilityState === want) cb();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}

function onLifecycle(event: LifecycleEvent, cb: () => void): () => void {
  switch (event) {
    case "online":
      window.addEventListener("online", cb);
      return () => window.removeEventListener("online", cb);
    case "offline":
      window.addEventListener("offline", cb);
      return () => window.removeEventListener("offline", cb);
    case "visible":
      return onVisibility(cb, "visible");
    case "hidden":
      return onVisibility(cb, "hidden");
    // Web has no distinct pause/resume signal (research/08 §1.4: no Background Sync, the app
    // just gets a few seconds on backgrounding); visibilitychange is the closest analogue and is
    // also what Capacitor's `appStateChange` maps onto, so callers use the same event names on
    // every platform.
    case "resume":
      return onVisibility(cb, "visible");
    case "pause":
      return onVisibility(cb, "hidden");
    default: {
      const exhaustive: never = event;
      throw new Error(`unknown lifecycle event: ${exhaustive as string}`);
    }
  }
}

export const webPlatform: Platform = {
  name: "web",

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

  haptics: {
    // navigator.vibrate: Chrome Android only (user-gesture required), no-op everywhere else
    // (research/08 §3.7). The Capacitor implementation swaps in @capacitor/haptics.
    impact(style = "light") {
      navigator.vibrate?.(style === "heavy" ? 30 : style === "medium" ? 20 : 10);
    },
    selection() {
      navigator.vibrate?.(5);
    },
    notify() {
      navigator.vibrate?.([10, 40, 10]);
    },
  },

  share: {
    async share(data) {
      if (!navigator.share) return false;
      try {
        await navigator.share(data);
        return true;
      } catch {
        return false;
      }
    },
  },

  deepLinks: {
    // No in-app interception on web (research/08 §4: iOS links open in Safari with separate
    // storage; Android WebAPK link capturing needs no app-side listener). Capacitor's
    // implementation wires `App.addListener('appUrlOpen', ...)` + `App.getLaunchUrl()` here.
    onOpen() {
      return () => {};
    },
  },

  lifecycle: { on: onLifecycle },

  startKeyboardWatcher: () => createWebKeyboardWatcher(),
};
