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

**Fixed 2026-09-13** by ADR 024 (`docs/adr/024-pages-exist-once-referenced.md`): the server mints
`page.create` for every newly dangling reference key and its namespace ancestors inside
`serverApplyOps` (`packages/server/src/ref-pages.ts`), removes the ones it made when their last
reference goes and nobody claimed them, and a gated startup migration
(`packages/server/src/ref-pages-migration.ts`) creates the missing pages of an existing graph. On the
graph copy (`tools/probes/ref-pages-migration-real-graph.ts`): 259 pages created (248 keys + 11
ancestors) in 464 ms, 17 keys left dangling — all journal days, by design — second run a no-op,
`pnpm nooklet verify` OK over 20,705 ops.

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
