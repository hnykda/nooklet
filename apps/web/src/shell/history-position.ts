/**
 * B-649: whether the top bar's Back and Forward have anywhere to go, so they can be greyed out
 * when they do not.
 *
 * Two sources, best first:
 * - The Navigation API (`navigation.canGoBack` / `canGoForward`), where the engine has it. It only
 *   counts this document's own same-origin entries, so in a browser tab Back is not "enabled" just
 *   because the tab came from some other site.
 * - Otherwise the `_depth` that `@solidjs/router` stamps on every entry it creates
 *   (`saveCurrentDepth`: `history.length - 1` right after each push). `history.length` counts the
 *   entries AHEAD of the current one too, and a push drops those, so "forward exists" is exactly
 *   `depth < history.length - 1`. Older WebKit (the Mac app's WKWebView on older macOS) lands here.
 */
import { useLocation } from "@solidjs/router";
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";

export interface HistoryPosition {
  canGoBack: boolean;
  canGoForward: boolean;
}

interface NavigationLike {
  canGoBack: boolean;
  canGoForward: boolean;
}

export function readHistoryPosition(env: {
  navigation?: NavigationLike | undefined;
  depth: unknown;
  length: number;
}): HistoryPosition {
  const nav = env.navigation;
  if (nav && typeof nav.canGoBack === "boolean" && typeof nav.canGoForward === "boolean") {
    return { canGoBack: nav.canGoBack, canGoForward: nav.canGoForward };
  }
  // No stamp at all (something replaced `history.state`): say "yes" rather than lock the user in.
  if (typeof env.depth !== "number") return { canGoBack: true, canGoForward: true };
  return { canGoBack: env.depth > 0, canGoForward: env.depth < env.length - 1 };
}

function current(): HistoryPosition {
  return readHistoryPosition({
    navigation: (globalThis as { navigation?: NavigationLike }).navigation,
    depth: (window.history.state as { _depth?: unknown } | null)?._depth,
    length: window.history.length,
  });
}

/**
 * Re-read on every route change and every traversal. Must be called under the router.
 *
 * Read a macrotask AFTER the location changes, not in the same reactive pass: the router's location
 * signal changes before the history entry is written and stamped (`pushState`, `_depth`), so a
 * read on the change itself saw the previous entry — Back stayed greyed out on the second page.
 * `currententrychange` (Navigation API) and `popstate` cover traversals.
 */
export function useHistoryPosition(): () => HistoryPosition {
  const location = useLocation();
  const [pos, setPos] = createSignal<HistoryPosition>(current(), {
    equals: (a, b) => a.canGoBack === b.canGoBack && a.canGoForward === b.canGoForward,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reread = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => setPos(current()), 0);
  };
  createEffect(on(() => [location.pathname, location.search, location.key], reread));
  onMount(() => {
    const nav = (globalThis as { navigation?: EventTarget }).navigation;
    window.addEventListener("popstate", reread);
    nav?.addEventListener?.("currententrychange", reread);
    onCleanup(() => {
      clearTimeout(timer);
      window.removeEventListener("popstate", reread);
      nav?.removeEventListener?.("currententrychange", reread);
    });
  });
  return pos;
}
