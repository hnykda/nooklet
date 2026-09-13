# Bugs inbox — ref-pages (M11)

Entries in `docs/BUGS.md` format, to be folded in by the coordinator. Numbers B-440..B-449.

---

### B-441 · A page that is only referenced does not exist: `/page/Sprouts/Growing/Sixth Try` says "doesn't exist yet", and the graph, All pages, search and `page_list` do not show it
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, owner ("…does not exist, even though
I did reference it already. We need to create pages on references, otherwise it's also not showing
in graph and stuff, right? This is how Logseq works.") · **Tests:**
`packages/server/src/ref-pages.test.ts` (17), `packages/server/src/ops/ref-pages.http.test.ts` (6,
incl. "an agent's block.update adding [[Agent Made Page]] makes page.list, page.read and search see
it"), `packages/server/src/ref-pages-migration.test.ts` (3)

A reference to a page nobody created stayed a dangling key in `ref` (`dst_page_id` NULL). A copy of
the owner's graph (taken 2026-09-13 17:34) had 265 such keys and 1,355 such rows — `task` (the
derived Task tag, 686), `quick capture` 89, `@eva svobodová` 17, `home automation`, `idea`… Of the
265, 17 are journal days.

Also tested: `e2e/tests/ref-pages.spec.ts` (5, Chromium), `packages/server/src/mcp/server.test.ts`
"a page an agent's block_update links is in page_list and readable with page_read",
`packages/server/src/mirror/live.test.ts` "writes no file for a page only a reference made…".

**Fixed 2026-09-13** by ADR 024 (`docs/adr/024-pages-exist-once-referenced.md`): the server mints
`page.create` for every newly dangling reference key and its namespace ancestors inside
`serverApplyOps` (`packages/server/src/ref-pages.ts`), removes the ones it made when their last
reference goes and nobody claimed them, and a gated startup migration
(`packages/server/src/ref-pages-migration.ts`) creates the missing pages of an existing graph. On the
graph copy (`tools/probes/ref-pages-migration-real-graph.ts`): 259 pages created (248 keys + 11
ancestors) in 464 ms, 17 keys left dangling — all journal days, by design — second run a no-op,
`pnpm nooklet verify` OK over 20,705 ops.

`nooklet serve` on a fresh copy (port 6410): startup logged "created 259 pages the graph references
(ADR 024) in 312 ms", dev verify OK; `page.read Sprouts/Growing/Sixth Try` → 0 blocks, 1 linked
backlink; five `block.update`s walking a link through `[[ZZ probe A]]`→`Ab`→`Abc`→`#zzprobetag`→
plain took 8–12 ms each and left no page and no trash entry; `verify` after stopping: OK, 20,730 ops.
The first mirror sweep also dropped 37 `mirror_file` rows: pages that already existed with no blocks
and no properties (`Alex`, `Someday`, `2022-12-28`, … — imported empty) lose their mirror files under
the new mirror rule. Their pages stay.

---

### B-442 · A page created on one device under a name the server already has never syncs, and nothing written on it reaches the server
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, ref-pages (designing ADR 024's
two-device case) · **Test:** `apps/web/src/sync/e2e.test.ts` "a page created offline under a name
the server already made from a reference converges, push first" and "…, pull first" (both fail
without the fix: checked by running them against the previous `sync-client.ts`)

Device A, offline, creates "X" and types blocks into it; meanwhile the server gets a page "X" from
another device (before ADR 024 only by an explicit create on both sides; with it, by any `[[X]]`).
On sync the server rejects A's `page.create` (`page-key-collision`) and every block on it
(`no-such-page`); the client dropped the rejected ops from its outbox and kept its own page, and
when the server's "X" arrived by pull it was rejected locally for the same collision. A kept a page
nobody else had, its text existed on A only, and the replicas never converged. (B-410 was the
journal-day face of this, fixed then by not offering a draft before the first sync.)

**Fixed 2026-09-13:** `POST /sync/push` names the live page for each refused `page.create`
(`refused_pages`, a snapshot row); a pull that brings a `page.create`/`page.rename` for a name a
local page holds is detected too (`apps/web/src/sync/refused-page.ts#pagesDisplacedByPull`). Either
way the client removes its refused page and what was on it, takes the server's page, and re-sends
the blocks' current state onto it as fresh ops. The server does not rewrite the late ops itself:
their HLCs are older than the page's `page.create`, and `verify`'s HLC-ordered replay would reject
them (the test asserts `verifyRebuildParity` stays empty). Not covered: a block the server already
had, moved onto the refused page and deleted there, keeps its old place.

The pull-time detection first fired too eagerly: a device whose page the server had ACCEPTED, pulling
an older page of the same name that the server created and deleted meanwhile (a link's short-lived
page), moved its own content onto that tombstone. It now fires only for a local page whose
`page.create` is still in `pending_op`, and only when the pulled page still holds the name at the end
of the batch. Tests: `apps/web/src/sync/e2e.test.ts` "a page of a name whose earlier page the server
deleted stays this device's page, push first" and "…, pull first" (both fail without that
condition). The push response now names the live page for any rejected `page.create`, so a retried
push (`already-recorded`) gets the same answer.

---

### B-443 · A replica that holds a page of a name refuses the server's older, already-deleted page of that name, and lacks its tombstone row
**Status:** open · **Severity:** low · **Found:** 2026-09-13, ref-pages (the tests above) · **Test:**
none asserts the gap; `apps/web/src/sync/e2e.test.ts` "a page of a name whose earlier page the server
deleted stays this device's page" compares live rows only, with a comment naming this entry

Device A creates page "X" (accepted or still pending). The server meanwhile has a page "X" that was
created and deleted (with ADR 024, any short-lived page a link made). When A pulls that page's
`page.create`, A's own live "X" holds the key, so A's replica rejects the create; the following
`page.delete` is a noop on a row that does not exist. A ends without the tombstone row every other
replica has. Nothing live differs, and nothing reads that tombstone on the client — provided nothing
revives it: an un-delete of it would land everywhere but on A. That is why the server never brings an
unclaimed tombstone back (`ref-pages.ts#referencePageOps` always mints a new page; it did reuse them
before this entry). `trash.restore`/`batch.undo` of such a page are server-side and refuse or evict
before anything reaches A, so no known path revives one today.

Root cause is older than ADR 024: a pulled `page.create` meeting a live local page of the same key is
rejected locally with no reconciliation unless the local page is still unconfirmed (B-442). A fix
would apply a pulled create+delete pair as a tombstone insert, or apply pulled ops in server order
with collisions resolved in the server's favour.

---

### B-440 · Every page write scanned `path_ref`: ~50 ms per page op on the owner's graph
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, ref-pages (the ADR 024 migration
took 13.9 s for 259 page creates) · **Test:** `packages/server/src/db.test.ts` (schema version and
migration order cover v7); measured with the scratch timing script described below

`page-aliases.ts#reindexPageIdentity` runs on every page op and asks `ref`, `path_ref` and `page_tag`
which keys currently point at the page (`WHERE dst_page_id = ?` / `page_id = ?` / `tag_page_id = ?`).
Only the `*_key` columns were indexed, so each call scanned `path_ref` (32,674 rows on the copy):
`--cpu-prof` of 80 `page.create`s put 4.1 s of 4.45 s in that one `driver.all`. Measured 50–67 ms
per `page.create` through `serverApplyOps` before, 0.2–1.7 ms after. Every rename, property toggle
and page create on a real graph paid it — and ADR 024 adds page writes to link edits.

**Fixed 2026-09-13:** schema v7 adds partial indexes `ref_dst_page_id`, `path_ref_page_id`,
`page_tag_page`. The migration of B-441 went from 13,946 ms to 464 ms on the same copy. No test
asserts the plan; the `EXPLAIN QUERY PLAN` after the change reads `SEARCH … USING [COVERING] INDEX`
for all three.
