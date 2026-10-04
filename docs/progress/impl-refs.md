# impl-refs — progress

Branch `m8/impl-refs`, worktree `<repo>/.claude/worktrees/wf_69b4f9a8-ee2-25`, e2e
port 6406, new bug numbers B-200..B-209. Bugs go to `docs/bugs-inbox/impl-refs.md`, never
`docs/BUGS.md`.

## Brief

1. **B-89** — reserved keys (`marker`/`priority`/`collapsed`) in a `block.create` `properties` bag
   are dropped. Fix at the op layer (`packages/core/src/sync/apply-ops.ts#applyBlockCreate`), test
   in `packages/core/src/sync/apply-ops.test.ts`.
2. **B-104** — `/page/<alias>` 404s in the UI. Resolve aliases in `usePageByName` (client replica:
   `page_prop` alias rows, parsed with the server's rule, shared through core) and redirect the
   route to the canonical name.
3. **B-111** — ADR 017's `tagged_pages`: `page.backlinks` returns pages carrying the tag (from
   `page_tag`), MCP description says so, References panel shows "Pages tagged X" above linked
   references.

## Note on the starting commit

The worktree was created at `f7c9644` (an old commit), not `61279a2`. The branch was created there
and immediately `git reset --hard 61279a2` before any work (no commits lost; nothing else touched).

## Done

- B-89 fixed in core (`applyBlockCreate` folds the three bag keys into the INSERT); core tests +
  `packages/server/src/block-create-bag.test.ts`; sql-schema.md rule 24 updated. Core 335/335,
  server 522/522, typecheck clean, verify OK on the real-graph copy (20,411 ops).

- B-89 commit `54e92ba`.
- B-104 fixed: core `page-alias.ts` (parser moved from server), client `data/page-alias.ts` +
  `usePageByName` fallback (stamped on `page_prop`), `views/canonicalPageRoute.ts` redirect hooked
  into `PageView` (2 lines). e2e `page-identity.spec.ts` 5/5; all 5 fail on 61279a2's client; the
  "no bounce" test fails with the loading guard removed. Neighbour specs (pages, navigation,
  journals, references, refactor, shelf, history, page-icons + identity): 53 passed. Web unit
  692/692.

- B-104 commit `be6c119`.
- B-111 fixed: `page-tags.ts#pagesTaggedWith`, `page.backlinks` `tagged_pages`/`tagged_total` +
  description + render; spec §4.3.6, ADR 017 note, 3 wiki pages; client `api-client.ts` types,
  `views/TaggedPages.tsx` + `tagged-pages.css`, hookup in `ReferencesPanel.tsx`. Server 528/528,
  web 695/695 (one earlier full run had 1 failure in `page-title.test.ts`, passed alone and on the
  full rerun — load), e2e tagged-pages 3/3 (all fail on 61279a2), neighbours 53 passed. Logged
  B-200 (uncreated page shows no references) — open, not fixed.

- B-111 commit `201bd70`.
- Real-graph probe `tools/probes/refs-real-graph.mjs` on a copy served at 6406: alias routes
  (daně → Taxes, zahrada → Garden, bracketed alias with commas) redirect in ~250 ms; `journal` page
  shows "Pages tagged journal" 825 (200 shown, note present) above linked refs; API journal 825 in
  8–14 ms; `book` tagged page listed. Verify on the copy afterwards: OK, 20,411 ops.

- B-201 (found reviewing B-104: a half-typed page title reverted whenever any other page changed;
  predates the branch, B-104's `page_prop` stamp widened it) fixed in `store.ts#usePageByName` by
  reusing the previous row object when unchanged; e2e `page-title-draft.spec.ts` (fails with the
  reuse disabled). Broad e2e set (13 specs) 90 passed / 1 failed (`references.spec.ts` "no
  references means no panel at all", 12 s timeout) — passed alone and in the same file order (83
  passed): load.

- Probe commit `a774a97`; B-201 commit `cb2b6e3`. Final unit: core 338/338, server 528/528, web
  695/695; `pnpm -r typecheck` clean.

## In flight

Nothing. B-89, B-104, B-111, B-201 fixed and committed; B-200 logged open.

## Merge notes for the coordinator

- `m8/rv-web-security` moves `pageRoutePath`/`pageZoomRoutePath` to `routes/page-path.ts` and
  rewrites `api-client.ts#pageBacklinks` around `callOp`. After merging both: point
  `views/canonicalPageRoute.ts`'s import at `../routes/page-path.js`, and re-add the two
  `taggedPages`/`taggedTotal` lines to the rewritten `pageBacklinks` mapping (plus the wire type).
- `m8/qafix-render-sync` edits `PageView.tsx` near the title effect; this branch adds only an import
  and one `useCanonicalPageRoute(...)` line there.

## Next steps, in order

1. (Coordinator) fold `docs/bugs-inbox/impl-refs.md` into BUGS.md: B-89, B-104, B-111 fixed; B-200
   open (an uncreated page shows no references — touches `PageView.tsx`, a product call).
2. Not built from ADR 017: a remove control for `property` tags vs none for `intrinsic`.

## Decisions

- B-89: a set top-level `marker`/`priority`/`collapsed` wins over the bag; `null`/`false` counts as
  unset (core producers always send those defaults next to a bag).
- B-104: parser shared through core (`page-alias.ts`), not duplicated in the client; redirect only
  for non-journal pages; waits for the resource to finish loading (else links bounce back).
- B-111: `tagged_pages` windowed by the same `limit`/`cursor` as `linked`, plus `tagged_total`;
  target's alias keys count; the target never lists itself; named pages before journal days.

## How to resume

`git log --oneline 61279a2..m8/impl-refs`, then this file, then `docs/bugs-inbox/impl-refs.md`.
Real-graph copy: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-refs/graph`
(re-create with `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<dir>/graph.sqlite'"` if gone).

## Verification pass (2026-09-13, adversarial review of this branch)

Re-ran, same worktree: unit core 338/338, server 529/529 (one test added), web 695/695;
`pnpm -r typecheck` clean. E2E on 6406: the branch's three specs 9/9; neighbours (references,
references-filters, pages, navigation, journals, refactor, shelf, history, page-icons,
link-unlinked, popups, trash, focus) 134 passed, 0 failed; page-identity with two added tests 7/7.

Real-graph copy (fresh `.backup`, served on 6406, probes kept in the verifier's scratch): alias
redirect + Back/Forward, following `[[daně]]`/`#zahrada` from a block, UI title rename on a page
reached through an alias, renaming a page to its own alias, `page.create` of an alias name (server
returns the aliased page), two pages aliasing each other, NFD route, names with `%`, `#`, `?` and
`/`, a namespaced alias, tag add/remove through the properties panel then following the link, an
alias-written tag, a self-tag: all behaved, 0 console errors. `nooklet verify` on the copy after
the probes: OK, 20,439 ops. Page keys on the copy: 0 of 952 differ from `normalizePageName(name)`,
so the redirect cannot ping-pong on inconsistent keys there.

Added tests: `e2e/tests/page-identity.spec.ts` "renaming a page from its title after an alias
redirect…" and "an alias two pages claim moves to the survivor…" (the second fails with
`findPageByAlias`'s `deleted_at` filter removed — checked); `page-backlinks-tagged.http.test.ts`
"follows the tagged page through delete and undo, and answers the same for an alias target".
Wiki "References and tags" no longer implies a `Journal` page exists on every graph (B-200).

Observed, not changed (design calls, not defects): on the owner's `journal` page the tagged list is
200 pills (~40 rows) above the linked references, open by default.

Found and fixed in the pass: **B-202** — an open tag page did not follow another device's `tags::`
change (a pulled `page.prop` bumps only `page_prop`; the backlinks resource was not stamped on it).
One-line stamp in `data/store.ts#useLinkedReferences`; e2e `tagged-pages.spec.ts` "an open tag page
follows another device untagging and re-tagging a page (B-202)" fails without it.

Logged, not investigated: **B-203** (Alt+Enter follow-link did nothing under Playwright on macOS;
pre-existing, unrelated to aliases, unconfirmed). Final numbers after the pass: core 338/338,
server 529/529, web 695/695, typecheck clean; e2e page-identity 7/7, tagged-pages 4/4,
page-title-draft 1/1.

