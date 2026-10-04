/**
 * Proposal 006 Phase 1 (ADR 033): turns `nooklet://capture|today|search` links into navigation.
 * Every native entry point arrives as one of these: a link opened from anywhere, a Home Screen
 * quick action or Android App Shortcut, an Android share, the "Open nooklet to add" App Intent.
 *
 * Mounted once in `App.tsx` next to `PairingLinkPrompt`, OUTSIDE the token gate and the router, so
 * a capture link works on a first launch too (the capture screen then says there is no graph yet
 * and keeps the text). Because it sits outside `<Router>` it cannot use `useNavigate`; it changes
 * the URL with `history.pushState` and fires `popstate`, which is the event the router itself
 * follows for back/forward, and which `App` also watches to re-check its gate.
 *
 * A capture link only opens the capture screen pre-filled; it never writes (see
 * `capture-link.ts`).
 */
import { type JSX, onCleanup } from "solid-js";
import { samePathGraphPrefix } from "../data/bootstrap.js";
import { platform } from "../platform/index.js";
import { appLinkPath, parseAppLink } from "./capture-link.js";

/** Navigates the app to an app-relative path from outside the router. */
export function navigateApp(appPath: string): void {
  const target = `${samePathGraphPrefix() ?? ""}${appPath}`;
  if (`${location.pathname}${location.search}` === target) return;
  history.pushState(history.state, "", target);
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

export function AppLinkHandler(): JSX.Element {
  const stop = platform.deepLinks.onOpen((url) => {
    const link = parseAppLink(url);
    if (link === undefined) return; // a pairing link, or something else: not ours
    navigateApp(appLinkPath(link));
  });
  onCleanup(stop);
  return null;
}
