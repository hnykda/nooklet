# Bugs inbox — impl-refs (m8)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. Existing bugs are marked
"(existing)"; new ones use B-200..B-209.

---

### B-89 (existing) · `marker`/`priority`/`collapsed` in a `block.create` properties bag are silently dropped
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, seeding a server test for ADR 019 ·
**Tests:** `packages/core/src/sync/apply-ops.test.ts` "marker/priority/collapsed in the properties
bag land in their columns (B-89)", "a set top-level field wins over the bag; an unset one takes the
bag's value (B-89)", "an invalid reserved value in the bag is dropped, the block is still created
(B-89)"; `packages/server/src/block-create-bag.test.ts` "writes marker, priority and collapsed, and
the block becomes a Task"

Reproduced as described in BUGS.md before fixing: the first core test and the server test both
failed against `da85cfb`'s reducer (`expected null to be 'TODO'`). The owner's op log (a copy taken
2026-09-13, 20,411 ops) has no `block.create` carrying a reserved key in its bag — 870 creates carry
a bag, 0 of them `marker`/`priority`/`collapsed` — so changing what such an op replays to changes
nothing `nooklet verify` compares on that graph.

**Fixed 2026-09-13.** `packages/core/src/sync/apply-ops.ts#applyBlockCreate` folds bag
`marker`/`priority`/`collapsed` into the row INSERT and skips those three keys in the bag loop. A
set top-level field wins; an unset one (`null`, or `collapsed: false` — the model cannot tell false
from unset, and core producers such as `templates.ts` always send both defaults next to a bag) takes
the bag's value; an invalid bag value is dropped without failing the create, like any other invalid
inline property (a top-level invalid marker/priority still rejects). `docs/spec/sql-schema.md` rule
24's `block.create` paragraph says so. The server test checks the derived `#Task` ref too, since a
dropped marker also meant the block was not a task. `pnpm nooklet verify` on the real-graph copy
afterwards: 20,411 ops replayed, OK.

---

### B-104 (existing) · `/page/<alias>` says the page does not exist
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D10) · **Tests:** `e2e/tests/page-identity.spec.ts`
(all five: "/page/<alias> opens the page and replaces the URL with its own name", "a [[wrapped]]
alias with a comma resolves, and a zoomed block stays zoomed", "following [[alias]] lands on the
page, and links onward from it do not bounce back", "an alias added while its URL is open turns
'does not exist' into the page", "a page renamed over the API still opens from its old URL");
`apps/web/src/data/page-alias.test.ts`; `apps/web/src/views/canonicalPageRoute.test.ts`;
`packages/core/src/page-alias.test.ts`

The client replica has no `page_alias` table (sql-schema.md rule 1: derived tables are
server-only), contrary to the BUGS.md entry's "the table exists in the replica"; the fallback has to
read `page_prop` `alias` rows and parse them the way `packages/server/src/page-aliases.ts` does.
It also bit every page renamed through `page.update` (which keeps the old name as an alias): its
old URL and bookmarks said the page did not exist.

**Fixed 2026-09-13.** Three parts. (1) The `alias::` parser (`aliasKeysOf`, with `[[…]]`/`#`
unwrapping and journal-date canonicalisation) moved from `server/src/page-aliases.ts` to
`packages/core/src/page-alias.ts`, so the client reads a value exactly as the server's index does;
the server module re-exports it. (2) `apps/web/src/data/page-alias.ts#findPageByAlias` scans live
pages' `alias` rows in the replica; `store.ts#usePageByName` tries it last (after the key and the
journal day, so an alias never shadows a real name) and is now also stamped on `page_prop`, so an
alias added while its URL is open resolves without a reload. (3) `views/canonicalPageRoute.ts`
(one hook call in `PageView`) replaces an alias URL with the page's own name, keeping `?block=`.
Journal days are not redirected (they have always been addressable by any title format). The
redirect waits for the resource to finish loading: while a new route loads, a Solid resource still
returns the previous page, and comparing that with the new name bounced every link-follow back —
the "links onward" e2e test fails with the guard removed (checked). All five e2e tests fail against
`da85cfb`'s `store.ts`/`PageView.tsx` (checked). Known limit, unchanged: when two pages claim the
same alias the client picks the older page, the server (`resolvePageIdForKey`) whichever row SQLite
returns first.

---

### B-111 (existing) · ADR 017's `tagged_pages` group was never built
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, wiki workstream (doc-vs-code
drift) · **Tests:** `e2e/tests/tagged-pages.spec.ts` "a tag's page lists the pages tagged with it,
above linked references (B-111)", "a page with tagged pages but no linked references still shows
the panel (B-111)", "a page tagged later, by a property update, appears on the tag's page (B-111)";
`packages/server/src/ops/page-backlinks-tagged.http.test.ts` (6: property tags by name, `Journal`
intrinsic newest-first after named pages, alias-written tags and self-exclusion, shared
limit/cursor, tag removal and block targets, MCP description + `tools/call`);
`apps/web/src/views/TaggedPages.test.tsx`

**Fixed 2026-09-13.** Server: `page-tags.ts#pagesTaggedWith` reads `page_tag` for the target's own
key plus alias keys (the set linked references already match), one row per page (`intrinsic` wins),
never the target itself, named pages by key then journal days newest first. `page.backlinks` returns
`tagged_pages: [{id, page, source}]` and `tagged_total`; `limit`/`cursor` window `linked` and
`tagged_pages` together (the cursor stays while either has more). A target with no page of its own
(`Journal` on most graphs) still answers from the index. The MCP description names the group, the
render line adds "N page(s) tagged X", `docs/spec/mcp-tools.md` §4.3.6 has the schema and example,
ADR 017's "not built" note and the three wiki pages that said so are updated. Client:
`views/TaggedPages.tsx` (own CSS file) renders "Pages tagged X" with the total as its count, a
wrapped list of page names, collapsible, and "Showing N of M." when the panel's 200-row request
returned fewer than exist; hooked into `ReferencesPanel` above linked references, which now also
shows when tagged pages are all there is. All three e2e tests fail against `da85cfb`'s
`ReferencesPanel.tsx`/`page-backlinks.ts` (checked). Not built: ADR 017's "a `property` tag is
removable, an `intrinsic` one is not" control — the list marks `data-source` but offers no remove.

---

### B-200 · A page that does not exist yet shows none of its references
**Status:** open · **Severity:** low · **Found:** 2026-09-13, building B-111 · **Test:** none

Open `/page/book` on a graph where pages carry `tags:: book` (the owner's has one) or where blocks
say `[[book]]`, but no `book` page was ever created: the view says "This page doesn't exist yet"
and a Create button, and nothing else. `page.backlinks {target: "book"}` answers with the linked
references and, since B-111, the tagged pages — the server deliberately handles a not-yet-created
target (see the comment in `ops/page-backlinks.ts`) — but `PageView.tsx` only mounts
`ReferencesPanel` inside the `page()` branch. In a wiki a referenced-but-uncreated page is a normal
thing to open, and its references are the reason to open it. Likely fix: mount
`<ReferencesPanel target={props.name()} …>` under the missing-page message too. Not done here:
it changes the missing-page view another branch (`m8/qafix-render-sync`) is editing, and whether an
uncreated page should show references is a product call.

---
