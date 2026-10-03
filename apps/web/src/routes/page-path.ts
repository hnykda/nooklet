/**
 * The page routes' paths, and the ONE place the client builds them (B-331). No imports: the
 * renderer (`editor/render/*`), the views, the shell, the command hosts and the plugin host all need
 * a page's URL, and none of them should pull the data layer in to get it — which is why this is not
 * `views/navigateTarget.ts` (that one resolves block ids through `data/store.ts`).
 *
 * These paths are APP-RELATIVE ("/page/...", never "/g/<slug>/page/..."), deliberately: a call site
 * that hands one to `@solidjs/router`'s `<A>`/`useNavigate()` (most of them — the views, the shell,
 * the command hosts) gets ADR 025's `/g/<slug>` prefix for free, since `App.tsx`'s `<Router base>`
 * already applies it to everything that goes through the router. Prepending it here too would
 * double it for exactly those call sites (`/g/default/g/default/page/...` — a real bug, caught by
 * `namespace-paths.spec.ts`). The ONLY call sites that need to add the prefix themselves are the
 * handful that render a raw `<a href>` outside the router entirely — markdown content links
 * (`editor/render/*`) — see their own doc comments for why.
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
import { samePathGraphPrefix } from "../data/bootstrap.js";

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

/**
 * For the handful of call sites that render a raw `<a href>` OUTSIDE `@solidjs/router` entirely —
 * markdown content links (`editor/render/tokens.tsx`'s `NavLink`, `EmbedView.tsx`,
 * `QueryFenceView.tsx`) — so their `href` attribute is the real, copyable/bookmarkable/middle-
 * clickable address (B-331's own concern), not just correct once the router's own `onClick`
 * handler intercepts a plain left-click. Every OTHER call site (views, shell, command hosts —
 * anything using `<A>`/`useNavigate()`) must NOT use this: the router already applies this same
 * prefix itself, and doing it twice double-prefixes the path.
 */
export function rawAnchorHref(appRelativePath: string): string {
  return `${samePathGraphPrefix() ?? ""}${appRelativePath}`;
}
