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

### B-138 · Block text reaches the render sinks unchecked: `javascript:` links, app classes, page-sized formulas
**Status:** fixed · **Severity:** low (security hardening) · **Found:** 2026-09-13, web review
(F4, F5, F6) · **Tests:** `e2e/tests/untrusted-content.spec.ts` (one test per sink);
`apps/web/src/editor/render/untrusted-content.test.tsx`; `apps/web/src/app/hosts.test.ts`

Block text arrives by sync, import and MCP agents, so anything it can make the renderer do, a
synced device or an agent can do. Three sinks took it as given:

1. **Links (F4).** `[x](javascript:alert(document.domain))` rendered as
   `<a class="vr-link" href="javascript:…">`, and Alt+Enter handed the same href to `window.open`.
   In Chromium and WebKit neither ran script in the app origin (where `localStorage` holds the
   device token), but only because both sinks carry `target=_blank`/`noopener` — the review's
   probe leaked the token from the same anchor without `target`. The SPA sends no CSP, and the
   Tauri WKWebView (`csp: null`) was not tested. Reproduced in the e2e test before the fix: the
   anchor carried `href="javascript:alert(document.domain)"`.

**Fixed 2026-09-13 (links).** `editor/render/asset-url.ts#safeHref` allows http, https, mailto, tel
and relative hrefs, reading the scheme with the WHATWG URL parser so `java\tscript:` or a leading
control character resolve as the browser would; anything else renders its label with no `href`,
and `followLink` opens nothing. The allowlist is exactly what the owner's graph uses (2,298 links:
https/http/relative/mailto/tel — `tools/probes/link-schemes-in-graph.ts`), so no existing link
lost its target; an app scheme added later (`zotero://`) needs adding there.

2. **Code fence classes (F5).** The whole fence info string went into `<code class>`, so
   ```` ```js cmd-overlay ```` gave `class="language-js cmd-overlay hljs"`: any app class, including
   the command palette's fixed full-screen `.cmd-overlay` scrim, from one synced block. Inside the
   outline `.vr-row`'s `content-visibility: auto` contains a fixed descendant to its row; in the
   Shelf, which has no containment, it covers the viewport. Reproduced in the e2e test before the
   fix (`["language-js", "cmd-overlay", "vr-row", "hljs"]`).

**Fixed 2026-09-13 (fence classes).** `editor/render/highlight.ts#languageClass` takes the first
word only — the rule `resolveLanguage` already used for the grammar — reduced to `[\w+-]`; both
branches of `CodeFence` use it. `data-lang` keeps the raw info string (an inert attribute value).
In the owner's graph every fence info string but one is a single language word; the exception is a
log line pasted after the backticks, which now yields `language-Wed`.

3. **Formula sizes (F6).** KaTeX ran with its default `maxSize` of Infinity, so
   `$\rule{99999em}{99999em}$` painted a box 99,999em square: the e2e test measured its row at
   1,574,998 px tall before the fix. `\raisebox{99999em}` and `\hspace{99999em}` did the same.

**Fixed 2026-09-13 (formula sizes).** `editor/render/math.ts#renderTexSync` passes `maxSize: 20`,
which KaTeX applies to `\rule`, `\raisebox` and `\hspace`. `\kern` is not capped by KaTeX; it
shifts content sideways, and the e2e test checks a `\kern99999em` block does not widen the page.
The review also suggested `display: inline-block; overflow: hidden` on `.vr-math-rendered`; not
done: `tools/probes/inline-block-clip-baseline.mjs` shows it lifts every formula 11 px off the text
baseline in Chromium and WebKit, and clipping would not stop a tall box growing its row anyway.
`math.test.ts` (real KaTeX; failed before) and the e2e test above.

---
