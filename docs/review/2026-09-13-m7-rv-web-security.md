# Code review follow-up: M7 web client, security and cleanliness, 2026-09-13

Brief (coordinator, M8 workflow): fix ten findings from an independent review of the web client
(`apps/web`), each confirmed by a second, sceptical reviewer. Reproduce each one first with a
failing test, fix the cause, one commit per finding, high severity first; a finding that does not
reproduce is left and said so. Branch `m8/rv-web-security`, from `61279a2`.

This document is the record: what was in scope, what each finding turned out to be, what was
changed (with hashes and the test that failed before), what was deliberately not done, and what
is still unverified. Defects have entries in `docs/bugs-inbox/rv-web-security.md` (B-135..B-139,
for the coordinator to merge into `docs/BUGS.md`); cleanliness findings are summarised here only.

## Scope

Read in full for this work: `apps/web/src/db/{client,worker-api,db.worker}.ts`,
`data/{store,history,api-client,refactor-api,queries,appearance,bootstrap}.ts`,
`views/{HistoryView,TrashView,FindReplaceView,ReferencesPanel(undo path),PageIcon,navigateTarget}`,
`editor/render/{tokens.tsx,QueryFenceView.tsx,asset-url.ts,highlight.ts,math.ts,math.css}`,
`editor/{linkAtCaret.ts,BlockTree.tsx (header)}`, `app/{hosts.ts,CommandLayer.tsx (nav wiring)}`,
`shell/{Sidebar,Shelf}.tsx` (link and resolveBlockRef sites), Solid 1.9.15's `createResource`
(to know exactly when a read throws), `packages/server/src/http/web-client.ts` (SPA headers),
`packages/core/src/tokens.ts` (link, autolink and fence tokenizing). The reviewer's probes in the
session scratchpad were read and the ones that settled facts are now in `tools/probes/`.

Real data: a `.backup` copy of the owner's graph (18,628 live blocks) for the link-scheme census
and `nooklet verify`.

## Findings by severity

| # | Severity | Where | Verdict | Outcome |
|---|---|---|---|---|
| F1 | high | `apps/web/src/data/history.ts:43`, `db/client.ts:96` | reproduced (unit + e2e) | fixed, B-135 |
| F2 | medium | `views/HistoryView.tsx:238`, `views/TrashView.tsx:48`, `editor/render/QueryFenceView.tsx:172` | reproduced (component + e2e) | fixed, B-136 |
| F3 | low | `app/hosts.ts:239` | reproduced (unit + e2e) | fixed, B-137 |
| F4 | low (hardening) | `editor/render/tokens.tsx:384`, `app/hosts.ts:239` | reproduced (unit + e2e) | fixed, B-138 |
| F5 | low | `editor/render/tokens.tsx:124,128` | reproduced (unit + e2e) | fixed, B-138 |
| F6 | low | `editor/render/math.ts:43` | reproduced (unit + e2e) | fixed (cap only), B-138 |
| F7 | low | `editor/render/highlight.ts:136` | reproduced (guard test) | fixed, plus two more files |
| F8 | low | `data/api-client.ts:129` | reproduced (unit + component) | fixed |
| F9 | low | `editor/render/QueryFenceView.tsx:103` and seven more | reproduced (component) | fixed |
| F10 | low | `views/PageIcon.tsx:7`, `editor/BlockTree.tsx:14-21,31`, `editor/render/tokens.tsx:23-25`, `data/appearance.ts:143` | verified against code | fixed |
| — | low | `app/hosts.ts:250` (found in passing) | reproduced (e2e) | fixed, B-139 |

All ten reproduced. Details, in order:

**F1 — Trash/History unplugged the store's change bus.** The worker keeps one change callback and
one sync-status callback, each registration replacing the last (`db.worker.ts`), and
`db/client.ts` forwarded each subscription straight through. `history.ts#ensureWired` subscribed
its own copy of the invalidation counters the first time Trash or History rendered, so every
store-backed view stopped refreshing for the rest of the session. e2e before the fix: open a page,
open Trash, Back, append a block over the API → the outline still read "first" after 15 s. The
opposite order (History first) did *not* reproduce: the shell wires a store resource before History
mounts, so History owned the slot either way; that test is kept as a guard.

**F2 — errored resources read directly.** Solid's `read()` throws when `error !== undefined` and no
fetch is pending, and so does `.latest`. With no `ErrorBoundary`, the throw inside the render pass
discards that pass, so the error branch each view already had was never written. e2e before the
fix: aborted `page.history` / `trash.list` → no `.history-error`/`.trash-error` in 10 s.

**F3 — Alt+Enter on an asset link.** e2e before the fix: the popup opened
`http://127.0.0.1:6473/page/assets/rv-sec-spec.pdf`.

**F4 — `javascript:` hrefs.** e2e before the fix: `<a class="vr-link"
href="javascript:alert(document.domain)">`; Alt+Enter on it opened an `about:blank` popup. The
reviewer's engine probe, re-run as `tools/probes/javascript-href-sinks.mjs`: with
`target=_blank rel=noopener` nothing leaks in Chromium or WebKit; without `target`, both leak
the device token from the app origin; `window.open(…,"noopener")` leaks nothing. So the attribute
was the only barrier — hardening, not an exploit in today's sinks.

**F5 — fence info string into `class`.** e2e before the fix: `["language-js", "cmd-overlay",
"vr-row", "hljs"]`. The sceptic's narrowing holds: in the outline `.vr-row`'s
`content-visibility: auto` contains a fixed descendant to its row; the Shelf has no containment.

**F6 — KaTeX without `maxSize`.** e2e before the fix: the row holding
`$\rule{99999em}{99999em}$` was 1,574,998 px tall. `tools/probes/katex-output-attributes.cjs`
also confirms the rest of the reviewer's KaTeX audit: with `trust: false`, none of `\href`, `\url`,
`\htmlClass`, `\htmlStyle`, `\htmlData`, `\includegraphics` or hostile colour arguments produce
`on*`, `href`, `src` or `url()` in the output.

**F7 — raw NUL byte.** `git grep cacheKey` answered "Binary file matches". The guard test found the
same defect in `packages/core/src/query.test.ts:307` and `packages/server/src/verify.ts:88`.

**F8 — half-finished `callOp` consolidation.** A unit test with a rejecting `fetch` got a bare
`TypeError: Failed to fetch` from `apiClient.search`/`pageBacklinks`/`graphLinks`; a component test
showed Find & Replace dropping `graph.replace`'s hint. `batch.undo` had three wrappers.

**F9 — page URLs built in eight places.** A component test rendered `[[Projects/Aurora Launch]]`,
`#[[…]]`, `[label]([[…]])` and a query result heading with `href="/page/Projects%2FAurora%20Launch"`.
No functional breakage (the route decodes the splat), as the sceptic said.

**F10 — stale comments.** Each claim checked: no CSP on the SPA shell
(`packages/server/src/http/web-client.ts` sends `content-type` and `cache-control` only; `index.html`
has no meta CSP; Tauri `csp: null`); highlight.js wired by default; `resolveBlockRef` passed by
`BlockRowView.tsx:200` and `Shelf.tsx:103`; `AppShell.tsx` imports `data/appearance.ts` directly.
The embed placeholder, `.vr-ref-new` and `list:: number` gaps listed next to them are still real
and were kept.

**Found in passing — B-139.** While changing `followLink` for F3: its block case asked
`pageNameForId` (wired by B-82's fix to a page-table lookup) about a block id. Logged first,
reproduced in a browser (Alt+Enter on `((id))` stayed on the source page), then fixed.

## What changed

Commits on `m8/rv-web-security`, oldest first. Every one: `biome check` clean on its files,
`pnpm -r typecheck` clean, the touched packages' unit suites green, and the e2e specs named.

1. `018ae34` docs(progress): the plan.
2. `5eee913` **F1 / B-135.** `db/client.ts` registers with the worker once and fans out to a
   subscriber set (unsubscribe returned; one throwing listener cannot starve the rest).
   `history.ts` stamps through store's new `serverStampedFor` instead of keeping counters. The
   push-drained bump (B-83) moved from `useSyncStatus` into store's wiring, so it no longer depends
   on the sync indicator being mounted; `useSyncStatus` unsubscribes on cleanup. Tests:
   `apps/web/src/db/client.test.ts`, `e2e/tests/change-bus.spec.ts`.
3. `2fd98ad` **F2 / B-136.** Guarded reads: `usePageHistory().page`, `TrashView`'s `list()`,
   `QueryFenceView`'s `latest()` (which also stops saying "Running query…" once evaluation has
   failed); a failed "Older changes" now shows an error instead of an unhandled rejection. Tests:
   `apps/web/src/views/load-errors.test.tsx`, `e2e/tests/load-errors.spec.ts`.
4. `b66077a` **F3 / B-137.** `followLink` opens `assetUrl(href)`. Tests: `app/hosts.test.ts`,
   `e2e/tests/untrusted-content.spec.ts`. Also logs B-139 (then open).
5. `48e0a9a` **F4 / B-138.** `editor/render/asset-url.ts#safeHref`: the scheme is read with the
   WHATWG URL parser (so `java<TAB>script:` or a leading control character resolves as a browser
   would), and only http, https, mailto, tel and relative hrefs pass. Used by the rendered link and
   by `followLink`. The allowlist is exactly what the real graph uses:
   `tools/probes/link-schemes-in-graph.ts` counted 2,298 markdown links — https 1,810, http 337,
   relative 134, mailto 12, tel 5 — so no existing link lost its target. Tests:
   `editor/render/untrusted-content.test.tsx`, `app/hosts.test.ts`, the e2e spec.
6. `ba414a9` **F7.** Raw NULs → the escape in three files (same strings at runtime; `nooklet verify`
   on the real-graph copy OK, 20,411 ops). Guard: `apps/web/src/source-text.test.ts` fails on any
   tracked text file with a C0 control character other than tab/LF/CR. Taken before F5 because F5
   edits `highlight.ts`, whose diffs were unreadable while git thought it binary.
7. `cb30d19` **F5 / B-138.** `highlight.ts#languageClass`: the info string's first word (the rule
   `resolveLanguage` already used), reduced to `[\w+-]`, for both `CodeFence` branches; `data-lang`
   keeps the raw string. In the real graph every fence info string but one is a single word; the
   exception is a pasted log line, which now yields `language-Wed`.
8. `ef5fab9` **F6 / B-138.** `maxSize: 20` in `renderTexSync`. Tests: `editor/render/math.test.ts`
   (real KaTeX), the e2e spec (also checks a `\kern99999em` block does not widen the page).
   Probe: `tools/probes/inline-block-clip-baseline.mjs`.
9. `5d12eaa` **F8.** `apiClient` calls `callOp` (`post`, `createApiClient` and its options removed);
   `refactor-api.ts#undoBatch` is the single `batch.undo` wrapper (History and References import
   it); Find & Replace renders with `describeError`; both file headers rewritten. Tests:
   `data/api-client.test.ts`, `views/FindReplaceView.test.tsx`.
10. `24ee675` **F9.** `apps/web/src/routes/page-path.ts` (no imports, so the renderer does not pull
    in the data layer) holds `pageNameToPath`, `pathToPageName`, `pageRoutePath`,
    `pageZoomRoutePath`, `historyRoutePath`; `navigateTarget.ts` keeps only `goToTarget`;
    `hosts.ts#pagePath` deleted; every inline builder replaced. Test:
    `editor/render/page-hrefs.test.tsx`.
11. `44ebb6e` **F10.** The four comments rewritten (history.ts's was rewritten with F1).
12. `f5c8b69` **B-139.** `followLink`'s block case resolves the page by block id. Tests:
    `e2e/tests/follow-link.spec.ts`, `app/hosts.test.ts`.
13. This document, the progress file, and two probes re-homed from the review
    (`tools/probes/javascript-href-sinks.mjs`, `tools/probes/katex-output-attributes.cjs`).

## Verification

- `pnpm -r test` at `f5c8b69`: core 332/332, plugin-api 17/17, server 521/521, web 739/739.
- `pnpm -r typecheck`: clean at every commit.
- e2e (`NOOKLET_E2E_PORT=6473`, private `--output`), final combined run at `f5c8b69` over every
  spec this branch added or could affect — change-bus, load-errors, untrusted-content,
  follow-link, trash, history, query, pages, references, diagnostics, connectivity, views, replace,
  graph, link-unlinked, navigation, shelf, rendering, render, assets, refactor, settings:
  **126/126 passed**.
- Before any fix, the new specs failed 7 of 8 against `61279a2`, each for its finding's reason
  (log kept in the session scratchpad); B-139's spec failed on the pre-fix build too.
- `pnpm nooklet verify --data <copy of the real graph>` after touching `verify.ts`: OK, 20,411 ops.

Two red runs along the way, recorded rather than smoothed over:

- `views.spec.ts:461` "opening the palette while editing and closing it hands focus back to the
  editor" failed three runs in a row during F8 — including once with the worktree switched to
  `61279a2`, so not caused by this branch — and then passed in the final run. Treat it as flaky
  under load (load average 11–43 while it failed), not fixed. It needs a bug number if it recurs.
- `apps/web/src/data/page-title.test.ts` "renders a journal by its day…" timed out at 5 s twice in
  the full web suite (its dynamic import under load); unchanged by this branch, 9/9 alone, green
  in the final run.

## Not done, and why

- **CSS clipping on `.vr-math-rendered` (F6's second half).** The review suggested
  `display: inline-block; max-width: 100%; overflow: hidden`. `tools/probes/inline-block-clip-baseline.mjs`
  shows that lifts every formula 11 px off the text baseline in both Chromium and WebKit;
  `overflow: clip` does the same in WebKit (the Tauri host). Clipping would also not stop a tall
  box inflating its row — the cap does that. `contain: paint` on an inline-block is the one variant
  that clips without moving the baseline, but it would also clip KaTeX's legitimate ink overflow
  (italic overhang) and change how long inline formulas wrap; not worth it for what is left.
- **`\kern` is uncapped.** KaTeX's `maxSize` does not apply to it. A huge kern shifts content
  sideways; the outline row's containment and the Shelf/References scroll containers bound it, and
  the e2e test checks the page does not widen. A `\kern-30em\rule{20em}{20em}` can still paint a
  20em box beside its formula inside its own row or panel.
- **A Content-Security-Policy for the SPA shell (F10's alternative).** Adding one would back up
  F4, but the shell injects `window.__NOOKLET__` as an inline script, Solid and KaTeX emit inline
  `style` attributes, and the PWA and the Tauri host would each need checking — a design change
  with its own test surface, not a comment fix. `safeHref` removes the one sink F4 found.
- **App URL schemes in links.** `zotero://`, `obsidian://` and similar now render as a label with
  no `href`. None occur in the owner's graph; add one to `SAFE_PROTOCOLS` when it does.
- **`SearchView.tsx#errorText`** duplicates the formatter F8 removed from Find & Replace. It was not
  in the finding, it maps the network case to the same words the B-80 test expects, and search has
  no server hint to lose; left.
- **`web-client.ts` still injects the token into `index.html`** (noted in the 2026-09-12 review);
  unchanged here.

## Still unverified

- Firefox and the Tauri WKWebView were not tested for the `javascript:` sinks (F4) or for the
  fence-class overlay (F5); only Playwright's Chromium and WebKit.
- The F5 overlay was reproduced as a class on the element, not as a visible scrim in the Shelf; the
  sceptic's containment analysis (row contains it, Shelf does not) was read from the CSS, not
  observed.
- "The Shelf and References panels are scroll containers, so a huge `\kern` cannot widen the page"
  is from their CSS (`overflow-y: auto` makes `overflow-x` auto too); the e2e check covers the
  outline only.
- Whether any KaTeX formula in real notes relied on a size above 20em: the owner's graph was not
  searched for `$…$` sizes.
- A cause noticed while working, not a finding: twice in this session the file-writing tool turned
  a typed escape sequence (NUL, 0x01) into the raw byte — very likely how F7's bytes got into the
  repo. `source-text.test.ts` now catches it; the tool behaviour itself was not investigated.
