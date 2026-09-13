# Bugs inbox: rv-web-security (M8 branch `m8/rv-web-security`)

Entries in `docs/BUGS.md`'s format, for the coordinator to merge. Source: the independent review of
the M7 web client (security and cleanliness), recorded in
`docs/review/2026-09-13-m7-rv-web-security.md`. Numbers B-135..B-139 were allotted to this branch.

---

### B-135 · After opening Trash or History, pages stop updating until a reload
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, web review (F1) · **Tests:**
`e2e/tests/change-bus.spec.ts` "a page still picks up an API write after the Trash view was opened
and left"; `apps/web/src/db/client.test.ts`

Open a page, open Trash from the sidebar, press Back, then have an agent append a block over the
API: the page keeps showing its old content indefinitely (15 s and counting), although the write
reached this device. The same holds for the journal stream, All Pages, tasks, backlinks, query
fences and `((ref))` text, and the sync indicator stops moving. A reload fixes it until Trash or
History is opened again. Reproduced in the e2e spec above before the fix ("Received string:
first").

**Fixed 2026-09-13.** The worker keeps one change callback and one sync-status callback, each
registration replacing the last, and `db/client.ts` forwarded every subscription straight through.
`data/history.ts` subscribed its own copy of the invalidation bus the first time Trash or History
rendered, which unplugged `data/store.ts`'s — and store's "already wired" flag meant it never
plugged back in. `db/client.ts` now registers with the worker once and fans out to a set of
subscribers (each gets an unsubscribe; one throwing listener cannot starve the rest).
`history.ts` no longer keeps its own counters: it stamps through store's new `serverStampedFor`.
The push-queue-drained bump (B-83) moved from `useSyncStatus` into store's wiring, so it no longer
depends on the sync indicator being mounted and fires once per drain rather than once per mounted
indicator; `useSyncStatus` unsubscribes on cleanup, so Diagnostics opening and closing does not
leak listeners. `client.test.ts` fails against a pass-through client (single-slot fake worker);
`change-bus.spec.ts` fails against the old build.

---

### B-136 · History, Trash and a query fence sit on "Loading…" forever when their read fails
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, web review (F2) · **Tests:**
`e2e/tests/load-errors.spec.ts` "History says it could not load, and Retry recovers", "Trash says
it could not load, and Retry recovers"; `apps/web/src/views/load-errors.test.tsx` (all three
views)

Open `/history/<page>` or `/trash` while the server is unreachable (or answers 401, or does not
know the page yet): "Loading…" stays indefinitely and the "Could not load … Retry" line never
appears; the error surfaces only as an unhandled rejection in the console. A ```` ```query ````
fence whose evaluation fails stays on "Running query…" and never says "Query failed". B-10 and
B-80 again, in the M7 views. Reproduced in both tests above before the fix.

**Fixed 2026-09-13.** Reading an errored Solid resource — `resource()` and `resource.latest` both —
re-throws, and each view read its resource directly in a `when` or `each`. With no error boundary,
the throw discarded the render pass, so the error branch the views already had was never written.
Every read now goes through a guard that returns `undefined` while the resource is errored:
`usePageHistory` exposes `page` (and derives `batches`/`hasMore`/`loadMore` from it),
`TrashView` reads `list()`, `QueryFenceView` reads `latest()` and drops "Running query…" once the
evaluation has failed. "Older changes" failing now says so too instead of rejecting silently.

---

### B-137 · Alt+Enter on an asset link opens a blank app page instead of the file
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, web review (F3) · **Tests:**
`e2e/tests/untrusted-content.spec.ts` "Alt+Enter on an asset link opens the asset from the server
root, not below the page route"; `apps/web/src/app/hosts.test.ts`

Put the caret in `[spec](../assets/x.pdf)` on `/page/Projects/Aurora` and press Alt+Enter ("Follow
link under cursor"): the new tab opens `/page/assets/x.pdf` — the app shell, not the PDF.
Clicking the same rendered link works. B-51 again, on the keyboard path. Reproduced in the e2e
test before the fix ("Received: http://127.0.0.1:6473/page/assets/rv-sec-spec.pdf"). With
`VITE_API_BASE_URL` pointing at another server even a root-relative path went to the wrong origin.

**Fixed 2026-09-13.** `createNavigationHost#followLink` handed the token's raw href to
`window.open`, which resolves a relative URL against the current route; the rendered `<a>` goes
through `editor/render/asset-url.ts#assetUrl`, and now so does this.

---

### B-139 · Alt+Enter on a `((block ref))` does nothing
**Status:** open · **Severity:** low · **Found:** 2026-09-13, reading `app/hosts.ts` for B-137 ·
**Test:** none yet

Put the caret inside `((<block id>))` and press Alt+Enter: nothing happens. Found by reading, not
yet reproduced in a browser. `followLink`'s block case resolves the page through
`NavDeps.pageNameForId(link.id)`, but B-82's fix wired `pageNameForId` to `store.ts#resolvePageName`,
which looks the id up in the PAGE table — a block id never matches, so the navigation is silently
skipped. Fix: resolve a block's page with `resolveBlockPageName` in that case (a separate dep, or
call it directly as `revealBlock` already does).

---
