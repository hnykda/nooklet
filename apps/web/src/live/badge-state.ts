/**
 * The consent badge's three states (ADR 015 §2.6): *off* (no `/ui/live` connection), *observed*
 * (connected, control disabled — an agent can see this window but not act on it), *controlled*
 * (connected, control enabled). "The socket being open is the feature being active" (ADR 015 §1) —
 * so `connected` here means exactly "the `/ui/live` socket is currently open," not merely "the
 * view toggle is on" (a toggle can be on while the socket is reconnecting after a drop).
 */

export type BadgeState = "off" | "observed" | "controlled";

export function deriveBadgeState(input: {
  connected: boolean;
  controlEnabled: boolean;
}): BadgeState {
  if (!input.connected) return "off";
  return input.controlEnabled ? "controlled" : "observed";
}

export const BADGE_LABEL: Record<BadgeState, string> = {
  off: "Agents can't see this window",
  observed: "Agents can see this window",
  controlled: "Agents can see and control this window",
};
