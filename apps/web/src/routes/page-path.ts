/**
 * The page routes' paths, and the ONE place the client builds them (B-331). No imports: the
 * renderer (`editor/render/*`), the views, the shell, the command hosts and the plugin host all need
 * a page's URL, and none of them should pull the data layer in to get it — which is why this is not
 * `views/navigateTarget.ts` (that one resolves block ids through `data/store.ts`).
 *
 * Route shape: `/page/*name` (a splat param, so a namespace name's internal "/" survives as real
 * path segments — `/page/Projects/Aurora` — rather than needing `%2F`), with an optional
 * `?block=<id>` query param for the zoom view, and `/history/*name` for a page's timeline.
 *
 * Twelve call sites once built these inline, six of them (the rendered links) with
 * `encodeURIComponent` over the whole name, which turned a namespace's "/" into `%2F`. The route
 * still opened the page, so nothing looked wrong until someone copied the link.
 * `source-guards.test.ts` keeps the next one from being written inline.
 */

/** Page name -> URL path segments, one `encodeURIComponent` per segment so spaces/unicode survive
 * but the "/" that separates namespace levels stays a real path separator. */
export function pageNameToPath(name: string): string {
  return name
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Inverse of `pageNameToPath` — safe to call on the whole joined splat param at once, since
 * nothing in the app builds a page path any other way, and this encoding never produces a literal
 * "%2F" (each "/" was added back unencoded). */
export function pathToPageName(path: string): string {
  return decodeURIComponent(path);
}

export function pageRoutePath(name: string): string {
  return `/page/${pageNameToPath(name)}`;
}

export function pageZoomRoutePath(name: string, blockId: string): string {
  return `${pageRoutePath(name)}?block=${encodeURIComponent(blockId)}`;
}

export function historyRoutePath(name: string): string {
  return `/history/${pageNameToPath(name)}`;
}
