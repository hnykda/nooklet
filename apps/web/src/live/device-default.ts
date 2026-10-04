/**
 * B-708 (ADR 015 amendment, 2026-10-04): whether this device starts with the live agent-control
 * channel (`/ui/live`) OFF and its top-bar badge hidden.
 *
 * Off on the phone app (Capacitor) and on any touch-only device. ADR 015's channel is for an agent
 * that works beside a window someone is looking at — on the same computer, in the next terminal.
 * A phone is rarely that: nobody runs an agent "next to" it, the socket is one more connection to
 * keep alive on a radio that sleeps, and the badge took a slot in a top bar with little room. It
 * stays one switch away, in Settings → Agent access; turning it on there brings the badge back,
 * since ADR 015 §6 wants a visible signal whenever an agent can see the window.
 *
 * Only a DEFAULT: a choice this device already stored (`consent.ts`) wins, either way.
 */
import { detectPlatformFromEnvironment } from "../commands/keymap/platform.js";
import { platform } from "../platform/index.js";

export function liveOffByDefaultFor(env: { capacitor: boolean; touchOnly: boolean }): boolean {
  return env.capacitor || env.touchOnly;
}

/** For this device: Capacitor, or what the command system already calls `mobile` (an iOS/Android
 * user agent, or a coarse pointer with no hover). */
export function liveOffByDefault(): boolean {
  return liveOffByDefaultFor({
    capacitor: platform.name === "capacitor",
    touchOnly: detectPlatformFromEnvironment().mobile,
  });
}
