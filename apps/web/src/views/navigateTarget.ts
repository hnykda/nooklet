/**
 * Turning a `NavigateTarget` (the shape `InlineContent`/`BlockTree`/search results/`PageFinder`
 * all call `onNavigate` with) into an actual route change. Split out from the views that use it so
 * the path-encoding half is unit-testable (`navigateTarget.test.ts`) without a router.
 *
 * Route shape: `/page/*name` (a splat param, so a namespace name's internal "/" survives as real
 * path segments — `/page/Projects/Aurora` — rather than needing `%2F`), with an optional
 * `?block=<id>` query param for the zoom view (BUILD item 3).
 */

import { resolveBlockPageName } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";

/** Page name -> URL path segments, one `encodeURIComponent` per segment so spaces/unicode survive
 * but the "/" that separates namespace levels stays a real path separator. */
export function pageNameToPath(name: string): string {
  return name
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Inverse of `pageNameToPath` — safe to call on the whole joined splat param at once, since none
 * of its own encoding ever produces a literal "%2F" (each "/" was added back unencoded). */
export function pathToPageName(path: string): string {
  return decodeURIComponent(path);
}

export function pageRoutePath(name: string): string {
  return `/page/${pageNameToPath(name)}`;
}

export function pageZoomRoutePath(name: string, blockId: string): string {
  return `${pageRoutePath(name)}?block=${encodeURIComponent(blockId)}`;
}

export type NavigateFn = (path: string) => void;

/** Resolve `target` to a path and call `navigate`. A "block" target only carries an id (the
 * promised interface's shape), so this looks up its page locally first; if the block cannot be
 * found (e.g. a stale/foreign search hit before the local replica has synced it), it does nothing
 * rather than navigating somewhere wrong. */
export async function goToTarget(navigate: NavigateFn, target: NavigateTarget): Promise<void> {
  if (target.kind === "page") {
    navigate(pageRoutePath(target.name));
    return;
  }
  const pageName = await resolveBlockPageName(target.id);
  if (!pageName) return;
  navigate(pageZoomRoutePath(pageName, target.id));
}
