/**
 * `/page/<alias>` shows the page and then moves the URL to the page's own name (B-104).
 *
 * Showing it is `data/store.ts#usePageByName`'s job (it falls back to aliases). Moving the URL is
 * this module's: left on the alias, the address bar, Back, the History link and a copied URL would
 * all name something other than the page, and the rename flow's own "follow the page to its new
 * name" (B-78) would compare against a name the page never had. `replace`, so Back skips the alias.
 *
 * Journals are left alone on purpose: a journal day is addressed by any of its title formats
 * (`/page/Sep 7th, 2026` and `/page/2026-09-07` are the same day) and that has never redirected.
 */

import { normalizePageName } from "@nooklet/core";
import { useNavigate } from "@solidjs/router";
import { type Accessor, createEffect, type Resource } from "solid-js";
import { pageRoutePath, pageZoomRoutePath } from "../routes/page-path.js";

interface ResolvedPage {
  name: string;
  key: string;
  journalDay: number | null;
}

/** The path to replace the current route with, or `null` to stay. Pure. */
export function canonicalPageRedirect(
  routeName: string,
  page: ResolvedPage | null | undefined,
  blockId: string | undefined,
): string | null {
  if (!page || page.journalDay !== null) return null;
  // Same key means the URL already names this page (maybe in another case); only an alias — the
  // one other way `usePageByName` finds a non-journal page — gets here with a different key.
  if (normalizePageName(routeName) === page.key) return null;
  return blockId ? pageZoomRoutePath(page.name, blockId) : pageRoutePath(page.name);
}

export function useCanonicalPageRoute(
  routeName: Accessor<string>,
  page: Resource<ResolvedPage | null | undefined>,
  blockId: Accessor<string | undefined>,
): void {
  const navigate = useNavigate();
  createEffect(() => {
    // While a new name is loading the resource still returns the PREVIOUS route's page; comparing
    // that against the new name would bounce every page-to-page navigation straight back.
    if (page.loading || page.error !== undefined) return;
    const path = canonicalPageRedirect(routeName(), page(), blockId());
    if (path !== null) navigate(path, { replace: true });
  });
}
