/**
 * Turning a `NavigateTarget` (the shape `InlineContent`/`BlockTree`/search results/`PageFinder`
 * all call `onNavigate` with) into an actual route change. Split out from the views that use it so
 * it is unit-testable (`navigateTarget.test.ts`) without a router. The paths themselves come from
 * `../routes/page-path.ts`.
 */

import { resolveBlockPageName } from "../data/store.js";
import type { NavigateTarget } from "../data/types.js";
import { pageRoutePath, pageZoomRoutePath } from "../routes/page-path.js";

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
