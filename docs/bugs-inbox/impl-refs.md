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
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, exposure audit
(`docs/review/2026-09-12-exposure-audit.md`, defect D10) · **Test:** (pending)

The client replica has no `page_alias` table (sql-schema.md rule 1: derived tables are
server-only), contrary to the BUGS.md entry's "the table exists in the replica"; the fallback has to
read `page_prop` `alias` rows and parse them the way `packages/server/src/page-aliases.ts` does.

---

### B-111 (existing) · ADR 017's `tagged_pages` group was never built
**Status:** in progress · **Severity:** low · **Found:** 2026-09-12, wiki workstream (doc-vs-code
drift) · **Test:** (pending)

---
