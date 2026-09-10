/**
 * Whether `/ui/live` is currently connected, as a Solid signal — "the socket being open is the
 * feature being active" (ADR 015 §1) is literally what `./badge-state.ts#deriveBadgeState` reads.
 * A module-level singleton (same idiom as `./consent.ts#liveConsent`) so `../app/CommandLayer.tsx`'s
 * imperative socket wiring and `./ConsentBadge.tsx` share one source of truth with no prop-drilling
 * through `../shell/AppShell.tsx`.
 */

import { createSignal } from "solid-js";

const [liveConnected, setLiveConnectedSignal] = createSignal(false);

export { liveConnected };

export function setLiveConnected(connected: boolean): void {
  setLiveConnectedSignal(connected);
}
