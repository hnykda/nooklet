# SQL schema

Status: normative. This is the schema every other part of the system reads: `applyOps`, the
importer/mirror, search, the Tasks view, the HTTP API/MCP layer, and the embeddings worker all
build on the tables and queries defined here. It refines the sketch in
`research/03-sync.md` §6 and `research/06-embeddings.md` §2–4 and MUST NOT contradict
`PLAN.md` or the ADRs; deviations are called out under Open issues.

All DDL was checked against Node 26.8.1's built-in `node:sqlite` (bundled SQLite 3.53.4) on this
machine: `unicode61 remove_diacritics 2`, the `trigram` tokenizer, `PRAGMA user_version`,
`WITHOUT ROWID` tables, partial and expression (`GENERATED ALWAYS AS ... STORED`) indexes, and
the recursive-CTE cycle check all work as written (scratchpad scripts `check_sqlite.mjs`,
`check_gen.mjs`, `check_cycle.mjs`). `sqlite-vec` is not installed in this repo yet
(`npm ls sqlite-vec` → empty; latest stable per `npm view sqlite-vec version` is `0.1.9`,
matching `research/06-embeddings.md`); its DDL and driver gotchas below are taken verbatim from
that report's own verified findings on this machine, not re-derived.

## Purpose

Define, normatively, every table in a nooklet graph's SQLite database: full DDL, which tables
exist on the server only, the client only, or both; every index the plan's query paths need;
the exact effect of `applyOps` on this schema for each op kind in `packages/core/src/ops.ts`;
the `rebuild()` contract; migration convention; a worked example; and sizing/PRAGMA guidance.

## Definitions

- **State table**: holds current entity data, mutated only by `applyOps`, and is a pure function
  of the `op` log (§ Normative rule 12, "rebuild"). `page`, `block`, `block_prop`, `page_prop`,
  `setting`, `keybinding`, `plugin`.
- **Derived table**: computed from state tables and block/page content, never synced, rebuildable
  at any time without data loss. `ref`, `path_ref`, `page_alias`, `block_fts`/`block_tri`,
  `page_fts`/`page_tri`, `embedding`, `embedding_vec_<n>`.
- **Bookkeeping table**: server-side operational data that is neither state nor derived from
  content: `device`, `token`, `changes`, `mirror_file`, `embed_dirty`, `embedding_model`, `asset`.
- **Client-only table**: exists only in the browser/Capacitor replica: `pending_op`, `sync_state`.
- **Row HLC**: a column ending `_hlc` holding the HLC (`hlc.ts` format) of the last write accepted
  for that field, per ADR 003. SQL comparison is plain `TEXT` comparison (`op.hlc > row.foo_hlc`);
  HLC strings are constructed to sort correctly this way (`hlc.ts` `compareHlc`).
- **Reserved property key**: a property key stored in a dedicated typed column instead of the
  generic `block_prop`/`page_prop` table. v1 set: `marker`, `priority`, `collapsed`, `id`
  (ADR 004/`ops.ts`) plus `scheduled`, `deadline`, `repeat`, `done` (ADR 011). See rule 3.
- **Unit** (embeddings): as in `00-conventions.md` — a block-with-context or a page, one row in
  `embedding` per `(model, unit)`.

## Normative rules

### Scope, divergence, and graph scoping

1. The DDL in the Interfaces section MUST be identical on server (`node:sqlite`) and client
   (SQLite WASM) for every table not explicitly marked server-only or client-only below.
   Server-only: `device`, `token`, `changes`, `mirror_file`, `embed_dirty`, `embedding`,
   `embedding_model`, `embedding_vec_<n>`, `asset`. Client-only: `pending_op`, `sync_state`.
   Everything else — `page`, `block`, `block_prop`, `page_prop`, `op`, `setting`, `keybinding`,
   `plugin`, `ref`, `path_ref`, `page_alias`, `block_fts`/`block_tri`, `page_fts`/`page_tri`,
   `schema_migration` — exists on both, with identical schema. Embeddings never sync (ADR 010);
   this is why they are server-only even though the client otherwise holds a full replica.
2. Every top-level writable table (state and bookkeeping, not derived tables) MUST carry
   `graph_id TEXT NOT NULL DEFAULT 'default'` per `00-conventions.md` ("one graph per server in
   v1... every table still carries `graph_id`"). Derived tables (`ref`, `path_ref`, `page_alias`,
   the FTS/trigram tables, `embed_dirty`) and the two client-only tables do NOT carry `graph_id`:
   they are always scoped transitively through the `page`/`block` row they derive from or through
   the one open connection, and adding an unindexed column to an FTS5/vec0 virtual table buys
   nothing today. If multi-graph-per-file is ever built, these tables are rebuilt anyway.
3. Namespaces are NOT stored. `page.name` holds the full `"A/B/C"` string; `namespaceParts`,
   `namespaceParent`, and `namespaceAncestors` (`packages/core/src/page-name.ts`) compute the
   hierarchy from it at read time, confirming ADR 004's "ancestors are implied, never stored."
   The namespace hierarchy view for `A/B` is `SELECT * FROM page WHERE deleted_at IS NULL AND
   (key = :ns OR key GLOB :ns || '/*')` — `GLOB` (byte-comparison, case-sensitive) on the
   already-lowercased `key` column uses the `page_key` index range-scan; a page count in the
   low thousands makes this trivial either way.

### Property storage: dedicated columns for reserved keys, a generic table for everything else

4. **Decision: both, split by whether the key is closed and query-critical or open-ended.**
   Reserved keys (rule above) get dedicated typed columns with their own `_hlc` on `block`
   (never `page`, since marker/priority/scheduled/etc. are block-only per the model). All other
   keys — user-defined properties, tag-page `props::` fields, `alias::`, `tags::` — live in a
   generic per-key `block_prop`/`page_prop` table: `(entity_id, key, value, hlc)`,
   `PRIMARY KEY (entity_id, key)`, one row per key.

   Justification against the plan's needs:
   - Property keys are open-ended by design (a property definition is just a page named
     `property/<key>`; PLAN.md §8). A fixed column set cannot represent "any page named
     `property/*`". A generic EAV-shaped table is required for these, indexed as
     `(key, value)` so `find_pages_by_property`-style lookups ("pages where `area = "nooklet"`")
     are one index range scan, not a JSON scan.
   - `marker`/`priority`/`collapsed` are already promoted out of `Block.properties` in
     `packages/core/src/model.ts` (they are top-level `Block` fields, not entries in the
     `properties` bag) and are wire-compatible `block.prop` ops only by convention
     (`RESERVED_BLOCK_PROPS` in `ops.ts`). Scheduled/deadline/repeat/done MUST join them per
     ADR 011's explicit consequence ("join the reserved-key list"), for the same reason: the
     Tasks view and the journal's "Scheduled and deadline" section need `scheduled <= today`
     range filters and a multi-key sort (`ORDER BY COALESCE(scheduled, deadline)`) that are a
     single indexed query as native `INTEGER` columns with a `GENERATED ALWAYS AS ... STORED`
     column (verified working, see rule 9) and a full table scan + JSON/EAV join otherwise.
   - A single whole-row JSON `properties` column (the `research/03-sync.md` sketch's
     `props TEXT DEFAULT '{}'`) is rejected: per ADR 003 every field is independently
     mergeable and LWW by its own HLC, so a whole-JSON column would need whole-blob LWW,
     making two concurrent edits to two different properties silently drop one of them.
     Per-key rows give per-key HLC for free.

5. Reserved-key values on the wire are unchanged: a `block.prop` op with `key` in
   `{marker, priority, collapsed, scheduled, deadline, repeat, done}` is applied by writing the
   corresponding dedicated column + its own `_hlc` column, and MUST NOT also create a
   `block_prop` row for that key (no duplication of source of truth). `key = "id"` never appears
   in a `block.prop` op; it is consumed by the outline parser at import time to select the
   block's own id before an op is even constructed.
6. `alias::` and `tags::` values stay in the generic `page_prop`/`block_prop` table (they are
   not reserved) because `packages/core/src/refs.ts`'s `extractRefs` already special-cases these
   two keys generically from the `properties` bag; promoting them to columns would require core
   to special-case them twice. Changing a page's `alias::` value MUST refresh `page_alias`
   (rule 17) and trigger a `path_ref` refresh for exactly the blocks whose `ref.dst_page_key`
   equals an added or removed alias key (rule 18) — not a whole-graph rescan.
7. `block_prop.value`/`page_prop.value` MAY be `NULL`, meaning "key removed". The row is kept
   (not deleted) so a later, older-HLC `block.prop` op does not resurrect a removed key — this
   mirrors the `deleted_at`/`deleted_hlc` tombstone pattern used for whole entities. An operator
   MAY prune rows with `value IS NULL` and `hlc` older than the graph's oplog GC floor (rule 20);
   this is safe because `rebuild()` (rule 11) can always reconstruct them from the op log.
8. **Required core change**: `RESERVED_BLOCK_PROPS` in `packages/core/src/ops.ts` currently is
   `Set(["marker", "priority", "collapsed", "id"])`. It MUST become
   `Set(["marker", "priority", "collapsed", "id", "scheduled", "deadline", "repeat", "done"])`
   to match ADR 011 and this schema. This is additive and does not change any existing type.
   `packages/core/src/model.ts`'s `Block` interface and `OutlineNode` do NOT need to change:
   scheduled/deadline/repeat/done are written today via ordinary `key:: value` lines
   (`outline.ts`'s `finalizeNode` already routes any non-`id`/`collapsed` `key::` line into the
   generic `properties` bag), so they round-trip through core's existing `Properties` bag
   unchanged; only the *storage* layer (this spec, implemented in `packages/server`, not core)
   promotes them to dedicated columns when `applyOps` writes them. Core's pure `Block`/`Page`
   types also do not gain `deletedAt`: they represent the live view; the SQL row shape (this
   spec) is a superset that additionally carries `deleted_at`/`deleted_hlc` and all `_hlc`
   columns, materialized by the server's own row type, not by `packages/core`.

### `block` reserved columns and the Tasks-view query

9. `block` MUST have a `due_day` column defined as
   `GENERATED ALWAYS AS (coalesce(scheduled_day, deadline_day)) STORED`, indexed
   `(due_day, id) WHERE deleted_at IS NULL AND marker IN ('TODO','DOING','LATER','NOW','WAITING')`.
   The Tasks view ("open tasks sorted by scheduled/deadline across the whole graph") is then:
   ```sql
   SELECT id, page_id, content, marker, priority, scheduled_day, scheduled_time,
          deadline_day, deadline_time, due_day
   FROM block
   WHERE deleted_at IS NULL
     AND marker IN ('TODO','DOING','LATER','NOW','WAITING')
   ORDER BY due_day IS NULL, due_day, id;
   ```
   verified (`check_gen.mjs`) to use `USE INDEX block_open_tasks` via
   `EXPLAIN QUERY PLAN` (SQLite still adds a temp B-tree for the final `ORDER BY` tie-break on
   `id`, which is expected and cheap since the index already narrows the row set to open tasks
   with the marker/deleted filters applied — this remains a single indexed access path, not a
   full table scan). Additional filters (tag, page/namespace, scheduled/deadline window) are
   plain `AND` predicates layered on top (tag via `path_ref`/`ref` join, namespace via
   `page.key GLOB`, window via `due_day BETWEEN`), all still resolved through this same index
   or through their own indexes (rule 15's `path_ref` index, rule 3's `page_key` index).
10. `scheduled`/`deadline` values (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, ADR 011) parse into
    `scheduled_day`/`deadline_day` (`INTEGER YYYYMMDD`, same representation as
    `journal.ts`'s `JournalDay`) and `scheduled_time`/`deadline_time` (`TEXT 'HH:MM'`,
    nullable). `done` parses into `done_at` (`INTEGER` epoch ms, matching the storage
    convention for timestamps) from an ISO 8601 UTC string
    (`YYYY-MM-DDTHH:MM:SSZ`) on the wire — ADR 011 does not pin an exact string format for
    `done::`'s value; this spec fixes it to full ISO 8601 with seconds. This is a cross-spec
    assumption (flagged under Open issues) that the markdown-grammar and scheduling specs MUST
    honor. `repeat` is stored as opaque `TEXT` (`1w`, `1w from done`, ...); its exact grammar
    is owned by a future scheduling spec, not this one — this schema only requires it round-trip
    as a string. A `block.prop` op for `scheduled`/`deadline` whose value does not match
    `^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$` MUST be rejected (`status = 'rejected'`), not silently
    dropped into `block_prop`, since by the time such an op reaches `applyOps` it should already
    have been normalized by the editor or the importer (which maps org syntax into this grammar
    per ADR 011).

### References and path references (linked/unlinked references)

11. `ref` is one row per direct reference found by `extractRefs` (`packages/core/src/refs.ts`)
    in a block's own content or property values. It is rebuilt wholesale for a block whenever
    that block's `content` or any of its `block_prop` rows change (a single `DELETE FROM ref
    WHERE src_block_id = ?` followed by re-inserting the current extraction — `extractRefs`
    already de-duplicates via `Set`, so no extra dedup logic is needed at the SQL layer).
    `dst_page_key` is always the **normalized** name text as written (`normalizePageName`),
    resolved via the namespace shortest-unambiguous-suffix rule (owned by a references/markdown
    spec, not re-derived here) at extraction time; `dst_page_id` is a denormalized, nullable
    convenience column populated when a `page` row with that key currently exists — a page is
    **not required to exist** for a `ref` row pointing at it to exist (referencing an
    as-yet-uncreated page is valid; the ref just carries `dst_page_id = NULL` until such a page
    is created, at which point rule 18 must refresh it). For `kind IN ('block','embed')`,
    `dst_block_id` is the resolved target block id (post Logseq-UUID mapping, ADR 004), and
    `dst_page_key`/`dst_page_id` are ALSO populated — resolved to the target block's own page —
    so that "linked references of page P" uniformly includes blocks that embed or `((block-ref))`
    a block that lives on P, without a separate code path for that case. Moving a block to a
    different page (rule 24) MUST refresh `dst_page_key`/`dst_page_id` on every `ref` row with
    `dst_block_id` equal to the moved block, since those rows would otherwise point at the block's
    old page.
12. `path_ref` is the precomputed transitive closure PLAN.md calls "path refs": for block `B`,
    `path_ref(B, key)` holds one row per distinct page key in
    `{B's own page key} ∪ selfRefKeys(B) ∪ selfRefKeys(parent(B)) ∪ selfRefKeys(grandparent(B)) ∪ …`
    where `selfRefKeys(X) = DISTINCT dst_page_key FROM ref WHERE src_block_id = X`. It exists
    so that "linked references of a page" is one indexed lookup at read time instead of a
    recursive ancestor walk per query. It MUST be recomputed for a block and its **entire
    descendant subtree** whenever: (a) the block's own `ref` rows change (rule 11 — because
    every descendant inherits this block's ref set), or (b) the block's ancestor chain changes,
    i.e. a `block.place` move (rule 24 — because every descendant now inherits a different
    chain). Recomputation for one block is
    `DELETE FROM path_ref WHERE block_id = :id` then insert the closure computed by walking
    `parent_id` up to the root and unioning each ancestor's `selfRefKeys` (a small, bounded walk
    — real outlines are rarely more than ~20 levels deep; a depth guard of 1000 is a pure
    defense against already-corrupt data, not a real limit).
13. **Linked references of page P** (id `:pid`, normalized key `:pkey`, alias keys `:akeys` from
    `page_alias`) MUST be computed as:
    ```sql
    SELECT b.page_id AS src_page_id, b.id AS block_id, b.content, b.order_key,
           p2.updated_at AS src_page_updated_at
    FROM path_ref pr
    JOIN block b  ON b.id = pr.block_id AND b.deleted_at IS NULL
    JOIN page  p2 ON p2.id = b.page_id  AND p2.deleted_at IS NULL
    WHERE pr.page_key IN (:pkey, :akeys...)
      AND b.page_id != :pid
    ORDER BY p2.updated_at DESC, b.page_id, b.order_key;
    ```
    This is exactly "blocks whose refs OR ancestors' refs include P or its aliases, excluding
    P's own blocks" — the `path_ref` closure already folds in "own refs plus ancestors' refs",
    and `b.page_id != :pid` is the exclusion. "Grouped by page, most recent page first" is the
    `ORDER BY p2.updated_at DESC, b.page_id` — the API layer groups the already-page-major-sorted
    rows by `src_page_id` in application code (a single pass over already-ordered rows, not a
    second query). Indexed via `path_ref(page_key)` (rule 15) then `block`'s primary key.
14. **Unlinked references of page P** (display name `:name`, alias display names `:anames`) MUST
    be computed as an FTS hit on the name(s) that is not already a linked reference:
    ```sql
    SELECT b.page_id, b.id AS block_id, b.content,
           snippet(block_fts, 0, '[', ']', '…', 8) AS snip
    FROM block_fts
    JOIN block b ON b.rowid = block_fts.rowid
    WHERE block_fts MATCH :phrase_query   -- '"name" OR "alias one" OR "alias two"'
      AND b.deleted_at IS NULL
      AND b.page_id != :pid
      AND NOT EXISTS (
        SELECT 1 FROM path_ref pr WHERE pr.block_id = b.id AND pr.page_key IN (:pkey, :akeys...)
      );
    ```
    `:phrase_query` quotes each name as an FTS phrase (`"name one"`) and joins with `OR`; page
    and alias names containing FTS special characters are escaped by doubling `"`. This reuses
    full-text search exactly as PLAN.md §9 specifies ("Unlinked reference suggestions reuse
    full-text search").
15. Required indexes for the above:
    `CREATE INDEX ref_src ON ref(src_block_id);`
    `CREATE INDEX ref_dst_page_key ON ref(dst_page_key) WHERE dst_page_key IS NOT NULL;`
    `CREATE INDEX ref_dst_block ON ref(dst_block_id) WHERE dst_block_id IS NOT NULL;`
    `CREATE INDEX path_ref_page_key ON path_ref(page_key);` (the primary key
    `(block_id, page_key)` already covers the `block_id` direction, e.g. "what pages does this
    block reference, directly or via ancestors").

### Full-text search

16. `block_fts`/`block_tri` and `page_fts`/`page_tri` are FTS5 external-content tables over
    `block.content` and `page.name` respectively (`content_rowid='rowid'`, kept in sync by
    `AFTER INSERT/UPDATE OF content/DELETE` triggers, per the standard FTS5 external-content
    pattern — verified working, `check_cycle.mjs`). `block_fts`/`page_fts` use
    `tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"` (verified: `café` matches query
    `cafe`) per the plan's Czech/English accent-insensitivity requirement; `block_tri`/`page_tri`
    use `tokenize='trigram'` for substring/CJK matching (verified). Soft-deleted rows are
    intentionally left in the FTS shadow tables (the `AFTER UPDATE` trigger only fires `OF
    content`, and a soft delete does not touch `content`); every read of these tables MUST join
    back to `block`/`page` and filter `deleted_at IS NULL`, which is cheap (rowid join) and
    correct. A hard delete (GC/purge) does fire the `AFTER DELETE` trigger and removes the FTS
    row for real.

### Embeddings: multi-model coexistence

17. **Design**: one `vec0` virtual table per (provider, model) — `embedding_vec_<embedding_model.id>`
    — because `vec0` bakes the vector dimension into the column type at `CREATE VIRTUAL TABLE`
    time and different models have different dimensions (bge-m3 1024, qwen3-embedding:8b 4096,
    per `research/06-embeddings.md` §1.1); a single table cannot hold both. `embedding_model` is
    the registry: `(id, provider, model, dims, table_name, active, created_at, ready_at)` with a
    partial unique index enforcing exactly one `active = 1` row. `embedding` is the per-unit,
    per-model bookkeeping row the task list names explicitly: `(id, model_id, unit_kind, block_id,
    page_id, text_hash, embedded_hash, status, error, updated_at)`; `id` doubles as the row's
    `rowid` in that model's `embedding_vec_<n>` table (both are `INTEGER`, and nothing else
    shares that id space). `text_hash` (`sha256` of the cleaned, model-independent unit text) is
    computed once per content change and compared against `embedded_hash` to decide if a
    (re-)embed is needed — the debounced worker pattern from `research/06` §4.4, unchanged.
18. **Dimension handling**: `embedding_model.dims` is discovered once via Ollama `/api/show`
    (or a probe embed call) when a model is first selected, per `research/06` §1.1. The
    `CREATE VIRTUAL TABLE embedding_vec_<id> USING vec0(id INTEGER PRIMARY KEY, kind TEXT,
    page_key TEXT, embedding FLOAT[<dims>] distance_metric=cosine)` statement is generated in
    code (the dimension is interpolated as a literal integer from a value the server itself
    read from Ollama, never from user input) — this is the one place in this schema where DDL is
    not static, and is called out here explicitly as an exception to "full DDL for every table".
    `kind` and `page_key` are `vec0` metadata columns (≤16 allowed, per `research/06` §2.2),
    letting `related_pages`/`related_blocks`/"within this page" KNN queries filter without a
    join. Per the measured gotcha in `research/06` §2.3/ADR 010 consequences: bind the
    `page_key`... — wait, `page_key` here is `TEXT` not a partition key, so the integer-binding
    gotcha does not apply to it; it applies to any `INTEGER` metadata/partition column (none is
    used here — ADR 010 explicitly warns never to partition by page, so `page_key` is a plain
    filterable metadata column, not a partition key) — and bind `Float32Array.buffer` (not the
    typed array itself) for the `embedding` column on `node:sqlite`.
19. **Switch-over**: changing the `embedding.model` setting (rule 21) inserts a new,
    `active = 0` `embedding_model` row, creates its `embedding_vec_<id>` table, and enqueues
    every current unit as a `pending` `embedding` row for the new `model_id` (derived from a
    scan of `block`/`page`, not from the old model's rows, so it is correct even if the unit set
    changed). The worker drains it exactly as for the first index. When
    `SELECT count(*) FROM embedding WHERE model_id = :new AND status = 'pending'` is `0`, flip
    atomically in one transaction: `UPDATE embedding_model SET active = 0 WHERE active = 1;`
    then `UPDATE embedding_model SET active = 1, ready_at = :now WHERE id = :new;` — safe because
    SQLite checks a `UNIQUE`/partial-unique index per statement, and after the first statement no
    row has `active = 1`, so the second never collides. The old model's `embedding_vec_<n>` table
    and its `embedding` rows SHOULD be dropped immediately after the flip to reclaim disk (a
    100k×1024 float table is 415 MB, `research/06` §2.4); an operator setting MAY keep the
    previous index for a rollback window instead. All KNN/hybrid queries resolve the active
    table name from `embedding_model` first, then build the query string with that name
    interpolated (never as a bind parameter — SQLite cannot bind identifiers) since the value
    always comes from the trusted registry, never from user input.
20. `embed_dirty(unit_kind, unit_id, enqueued_at)` is the cheap, synchronous-write-time signal
    (`applyOps` inserts into it in the same transaction as a `block.text`/`block.delete`/
    `block.create` write); the worker is what turns a dirty signal into `embedding` rows across
    every currently-tracked model. This two-stage split exists because `embed_dirty` writes are
    free (no network call), while computing `text_hash`/deciding staleness per model is not
    (it needs the cleaned unit text, which needs the block's ancestors and descendants).

### Audit, mirror, tokens, devices — bookkeeping tables

21. `changes` (ADR 008: "seq, origin, actor, batchId, entity, before/after") has its **own**
    monotonic `seq` (`INTEGER PRIMARY KEY AUTOINCREMENT`), independent of `op.seq`: one HTTP/MCP
    call or one sync push can touch several entities in one batch, and `changes` is one row per
    **entity** touched (sharing a `batch_id`), not one row per **op** (an entity's `content` and
    `marker` changing in the same call are still one `op` each but one `changes` row, since the
    `changes` row's `before_json`/`after_json` are entity-level summaries, not per-field). Its
    `op_ids_json` links back to the `op.id` (HLC) values it covers, EXCEPT for `asset` changes,
    which never produce `op` rows at all (ADR 003: "Assets are not in the op log") — this is the
    one documented case where `op_ids_json` is `'[]'`. `changes_since(cursor)` is
    `SELECT * FROM changes WHERE seq > :cursor ORDER BY seq LIMIT :limit`, indexed by the primary
    key alone.
22. `device`, `token` are server-only (a client does not need to know about other devices' rows,
    and never sees other tokens' hashes). `token.token_hash` is the only stored form of a bearer
    token (`sha256` hex); `token.scope` is `read|write|admin` and `token.can_sync` is the
    orthogonal "device token" capability from `00-conventions.md` ("device tokens carry `sync`
    in addition to `write`"). `device.acked_seq` is the high-water mark of `op.seq` that device
    has pulled, used both for the poke/pull protocol and as the GC floor mentioned in
    `research/03-sync.md` §6.5 ("delete ops with `server_seq < min(device.acked_seq)`").
23. `mirror_file(path, page_id, content_hash, written_at)` is the ADR 002 echo-suppression table:
    the mirror exporter records the hash of what it just wrote; the file watcher compares an
    incoming file's hash against this row and skips re-importing its own write.

### `applyOps` semantics

24. For each op `kind` in `packages/core/src/ops.ts`, `applyOps` (identical code on server and
    client, server additionally validating structure per ADR 003) has exactly this SQL-level
    effect. All comparisons are `op.hlc > row.<field>_hlc` (or "row/field does not exist yet");
    on false, the op is recorded in `op` with `status = 'noop'` and no state changes.

    - **`page.create`** `{name, journalDay, properties?, createdAt}` — computes
      `key = normalizePageName(name)`. **ADR 018:** when `journalDay` is a valid day, `name` is
      DERIVED from it (`isoJournalName`, `2026-09-07`) and the payload's own `name` is ignored for
      state purposes — the log keeps what the op carried, live state has one answer. The
      derivation is pure, so a `rebuild()` replay reaches the same names and `verify` stays clean. If a non-deleted page with that `key` already exists
      under a **different** id (two devices created the same page name offline), the op is
      `status = 'rejected'` and no row is inserted — `page.key` MUST be enforced unique
      (partial unique index, `WHERE deleted_at IS NULL`) at the DB level as the backstop.
      Otherwise: `INSERT OR IGNORE INTO page(id, name, key, journal_day, created_at, updated_at,
      name_hlc) VALUES (entity, name, key, journalDay, createdAt, createdAt, op.hlc)`; for each
      `properties` entry, upsert `page_prop(page_id, key, value, hlc=op.hlc)` (reserved keys do
      not apply to `page`, so no dedicated-column routing here). Reconciling a client whose own
      `page.create` was rejected this way (re-parenting any blocks it already placed under the
      losing id) is a sync-protocol concern for a future sync spec, not this schema — this
      schema only guarantees `page.key` is never duplicated (see Open issues).
    - **`page.rename`** `{name}` — LWW on `(name, key)` as one field via `name_hlc`. Carries the
      same journal-day derivation as `page.create`, so a rename of a journal page lands on the ISO
      name rather than being refused — which is what lets a migration rename through ordinary ops.
      Same
      same-key-different-id check as `page.create` (reject if colliding with another live page).
      `applyOps` does **not** rewrite other blocks' `[[Old Name]]` text: that propagation, if
      wanted, is the caller's job — plan it as an explicit batch of `block.text` ops (discovered
      via `ref`/`path_ref`) submitted alongside the `page.rename` op, not an implicit
      schema-level side effect (keeps `applyOps` a small, mechanical, per-field LWW function per
      ADR 003).
    - **`page.prop`** `{key, value | null}` — generic LWW upsert into `page_prop` keyed by
      `(page_id, key)`. If `key = 'alias'`: after the upsert, recompute `page_alias` rows for
      this page (`DELETE ... WHERE page_id = :id` then re-insert one row per `splitList(value)`
      entry, normalized), and recompute `path_ref` for every block whose `ref.dst_page_key`
      equals a key that was added or removed from the alias set (a targeted, indexed
      `ref_dst_page_key` lookup, not a graph-wide rescan).
    - **`page.delete`** `{deletedAt | null}` — LWW on `deleted_at`/`deleted_hlc`. Does **not**
      cascade a tombstone write to the page's blocks: every block-listing query already joins to
      `page` and filters `page.deleted_at IS NULL`, so hiding the page hides its blocks for free,
      and restoring the page (`deletedAt: null`) restores all of them for free too — the same
      "ancestor deleted, descendants untouched" rule ADR 003 states for blocks, applied one level
      up.
    - **`block.create`** `{place, content, marker?, priority?, collapsed?, properties?,
      createdAt}` — placement validation (shared with `block.place` below): if `place.parentId`
      does not resolve to a live block, treat it as `null` (top level of `place.pageId`) and
      record the op with the corrected `place`, since a genuinely new id cannot create a cycle.
      `INSERT OR IGNORE INTO block(id, page_id, parent_id, order_key, content, marker, priority,
      collapsed, created_at, updated_at, place_hlc, content_hlc, marker_hlc, priority_hlc,
      collapsed_hlc) VALUES (entity, ..., op.hlc, op.hlc, op.hlc, op.hlc, op.hlc)`. For each
      `properties` entry: reserved keys (`scheduled`/`deadline`/`repeat`/`done`) parse into their
      dedicated columns with `hlc = op.hlc` (rule 10); everything else upserts into `block_prop`
      with `hlc = op.hlc`. Then (same transaction): extract refs from `content` + the resulting
      non-reserved properties bag, insert `ref` rows; compute and insert this block's `path_ref`
      closure (its own page plus, since it is new, no children yet); insert into `embed_dirty`
      for `(block, entity)`, `(page, place.pageId)`, and every ancestor block id (their
      "flattened descendants" embedding text now includes this block).
    - **`block.place`** `{place}` — LWW on `(page_id, parent_id, order_key)` as one field via
      `place_hlc`. Same missing/invalid-parent fallback as `block.create`, with one exception
      (B-120): a tombstoned parent on `place.pageId` is kept when it is the parent the block
      already has — a tombstone hides a subtree, it does not dissolve it, so carrying a deleted
      subtree to another page, or reordering under a parent deleted meanwhile, keeps the block
      attached. A move under a *different* tombstoned parent still falls back to `null`. **Server-only** cycle
      check via the recursive CTE (verified, `check_cycle.mjs`):
      ```sql
      WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_id FROM block WHERE id = :newParentId
        UNION ALL
        SELECT b.id, b.parent_id FROM block b JOIN ancestors a ON b.id = a.parent_id
      )
      SELECT 1 FROM ancestors WHERE id = :movedBlockId LIMIT 1;
      ```
      A row found means `newParentId` is `movedBlockId` itself or one of its descendants — the
      move is `status = 'rejected'` and the server emits a **corrective op**: a new
      `block.place` op with `entity = movedBlockId`, `payload.place` = the block's current
      (unchanged) place, `hlc = serverHlc.next()` (strictly greater than the rejected op's HLC,
      since the server's clock already absorbed it via `Hlc.receive()`), `device` = the server's
      own reserved device id, applied and logged with `origin = 'system'`. Clients never
      rebase; they just apply this corrective op like any other and the renderer's transient
      "Unplaced" pseudo-node (a client-side rendering concern, not a schema one) resolves within
      one round trip. **Server-only subtree repair (B-120):** after the batch (and any cycle
      correction) applies, every descendant of a block placed in the batch that sits on a
      different page than its parent gets a server-authored `block.place` keeping its
      `parentId`/`order` and taking the parent's `pageId`, minted parent-first with
      `serverHlc.next()`, applied in the same transaction and returned with the corrections —
      the reducer itself stays one-op-one-row, so a move that wins LWW over a server-planned
      subtree move (or arrives by sync at all) cannot strand the children on the old page. On
      acceptance: update the four place columns + `place_hlc`; recompute
      `path_ref` for the moved block and its **entire subtree** (rule 12b); refresh
      `dst_page_key`/`dst_page_id` on every `ref` row with `dst_block_id = movedBlockId`
      (rule 11); if `page_id` changed, enqueue `embed_dirty` for the page unit of both the old
      and new page.
    - **`block.text`** `{content}` — LWW on `content_hlc`. On acceptance: update `content`,
      `content_hlc`, `updated_at`; re-run `extractRefs` and rebuild this block's `ref` rows;
      recompute `path_ref` for this block and its subtree (rule 12a); enqueue `embed_dirty` for
      `(block, entity)`, every ancestor, and `(page, page_id)`. `block_fts`/`block_tri` update
      automatically via the `AFTER UPDATE OF content` trigger (rule 16).
    - **`block.prop`** `{key, value | null}` — reserved keys route to their dedicated column +
      that column's own `_hlc`, compared and applied independently of every other field (a
      concurrent `marker` write and `priority` write never conflict with each other, per ADR 003)
      — see rule 10 for parsing/validation. Non-reserved keys upsert `block_prop` keyed by
      `(block_id, key)` against that row's own `hlc`. Either way, since the properties bag (for
      ref-extraction purposes) or the marker/priority (for task-query purposes) changed:
      if the key is `tags` or `alias`, or in all cases defensively cheap enough to always do,
      re-run `extractRefs(content, currentNonReservedProperties)` and rebuild `ref`/`path_ref`
      for this block and its subtree exactly as for `block.text` (content did not change, but
      the properties half of `extractRefs`'s input did).
    - **`block.delete`** `{deletedAt | null}` — LWW on `deleted_at`/`deleted_hlc`. No cascade to
      children (ADR 003: "descendants stay attached and hidden; restoring the ancestor restores
      them") — the same page-join filtering pattern as `page.delete` applies one level down:
      every read filters `deleted_at IS NULL` up the ancestor chain implicitly by simply not
      rendering hidden subtrees, not by writing a tombstone to every descendant. `embed_dirty` is
      enqueued for the block (worker deletes its `embedding`/vector rows) and its old ancestors
      (their flattened-descendants text shrinks).

25. `setting`, `keybinding`, and `plugin` writes MUST flow through the same `applyOps` path as
    page/block writes, per ADR 003's principle "every write anywhere is an op" — **this requires
    new op kinds not yet in `packages/core/src/ops.ts`'s `OpPayload` union**: `setting.set
    {key, value}`, `keybinding.set {id, key, command, when}` / `keybinding.delete {deletedAt}`,
    `plugin.install {id, version}` / `plugin.enable {enabled}` / `plugin.configure {settings}`.
    This spec defines the tables these ops write into (Interfaces section) but not the exact
    payload shapes beyond what is needed for the columns to make sense — the payload contract is
    owned by whichever spec covers commands/settings/plugins (not yet written). Flagged under
    Open issues as a required core addition and a cross-spec dependency.

### `rebuild()`

26. `rebuild()` MUST reproduce the state tables from the `op` log alone, replaying in `seq`
    order into empty state tables (`page`, `block`, `block_prop`, `page_prop`, `setting`,
    `keybinding`, `plugin`) via the same `applyOps` function used for live writes. It runs in
    two phases: **(1) replay** — apply every op in `seq` order (MAY skip the synchronous
    ref/`path_ref`/FTS maintenance during replay for speed, since phase 2 recomputes them
    wholesale anyway); **(2) reindex** — recompute `ref` and `path_ref` for every non-deleted
    block from scratch, recompute `page_alias` from `page_prop`, rebuild `block_fts`/`block_tri`/
    `page_fts`/`page_tri` via `INSERT INTO block_fts(block_fts) VALUES('rebuild')` (verified,
    `check_cycle.mjs`) and its three siblings, and enqueue every unit into `embed_dirty`. Phase 2
    is identical to the "startup reconciliation" pass `research/06-embeddings.md` §4.4 already
    specifies, reused rather than duplicated. A dev-mode server SHOULD run `rebuild()` into a
    scratch database on every start and diff it against the live state tables (row-for-row,
    excluding purely-timestamp bookkeeping columns that legitimately differ) as the parity check
    ADR 003 requires ("`rebuild()` ... must reproduce the state").

### Migration strategy

27. Schema version is tracked with **both** `PRAGMA user_version` (fast, authoritative, checked
    on every connection open — verified working) **and** a `schema_migration(version INTEGER
    PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT NOT NULL)` audit table (a version
    row is inserted in the same transaction as the `PRAGMA user_version = N` that closes out
    migration `N`), so a support session can `SELECT * FROM schema_migration ORDER BY version`
    without recomputing anything. Since there is no production data pre-v1, migration `1` IS
    this document's DDL in full — there is nothing to migrate *to* it, only *from* it going
    forward. Convention for every future migration: **additive only** (new tables, new nullable
    columns, new indexes — never `DROP`/rename a column or tighten a `CHECK` in a way existing
    rows could violate); **forward-only** (no down-migrations; a bad migration is fixed by a new
    forward migration); **replay-safe** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
    EXISTS`; a migration script MUST be safe to run twice, since `rebuild()`/reconciliation and a
    crashed-mid-migration restart both need this). A migration that changes what a derived table
    means (e.g. a new FTS tokenizer) ships as: create the new table under a new name, backfill,
    swap, drop the old one under its old name in a **later** migration — the same pattern as the
    embedding model switch-over (rule 19), applied to schema changes generally.

### Sizing and PRAGMAs

28. Estimated row counts and file size for a graph like the user's (18.4k blocks, 1.2k pages,
    per PLAN.md §2's DB-mirror figures), one active embedding model (bge-m3, 1024-d):

    | Table(s) | Rows (est.) | Size (est.) | Basis |
    |---|---|---|---|
    | `page` | ~1,300 | <1 MB | direct count |
    | `block` | ~18,400 | ~10–15 MB | direct count, `content` averaging a few hundred bytes |
    | `block_prop`/`page_prop` | ~5,000–9,000 | <2 MB | ~0.3–0.5 non-reserved properties/block, sparse |
    | `ref` | ~3,000–5,000 | <1 MB | PLAN.md: "links 2,200 lines", tags, rare block refs |
    | `path_ref` | ~30,000–50,000 | ~2–4 MB | closure over ancestor chains, largest ancillary table but still small rows |
    | `op` | ~50,000–150,000 | 20–40 MB | `research/03-sync.md` §6.5: "100k ops ≈ 20–40 MB", scaled to years of daily journaling |
    | `embedding` (bookkeeping) | ~19,700 (18.4k block + 1.3k page units) | <5 MB | one row/unit/active model |
    | `embedding_vec_1` (bge-m3, float32) | ~19,700 | **~85 MB** | `research/06-embeddings.md` §2.4: "At 20k blocks ... vec table 85 MB" (measured, this exact scale) |
    | `block_fts`+`block_tri`+`page_fts`+`page_tri` | — | ~10–14 MB | scaled down from `research/06` §4.3's measured 100k-block figures (7.9 MB + 51 MB) by ~1/5 |
    | everything else (`device`,`token`,`changes`,`mirror_file`,`asset`,`plugin`,`setting`,`keybinding`,`schema_migration`) | small | <1 MB | operational tables, not content-scaled |
    | **Total (server .sqlite file)** | | **~130–170 MB** | dominated by the op log and the vector table |
    | **Total (client replica)** | | **~15–25 MB** | no `embedding*`, no `changes`/`device`/`token`/`asset`/`mirror_file`; `op`/`pending_op` retained only briefly (rule 1, rule 20-equivalent GC) |

29. Required `PRAGMA`s, server (one writer connection, separate read connections for search and
    the embeddings worker per `00-conventions.md`):
    ```sql
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;         -- node:sqlite: pass { timeout: 5000 } to DatabaseSync instead
    PRAGMA cache_size = -64000;         -- ~64 MB page cache, comfortable for a ~150 MB file
    PRAGMA mmap_size = 268435456;       -- 256 MB, lets the hot working set (state + FTS) live memory-mapped
    PRAGMA temp_store = MEMORY;
    ```
    Client (SQLite WASM/OPFS, single connection per tab via the leader-election pattern in
    `research/03-sync.md` §4/§6.9), scaled down for a ~15–25 MB file and mobile memory limits:
    ```sql
    PRAGMA journal_mode = WAL;          -- or the VFS's cooperative equivalent
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA cache_size = -8000;          -- ~8 MB
    PRAGMA mmap_size = 67108864;        -- 64 MB
    ```

## Interfaces

### Consolidated DDL

Dependency order (a table only references tables above it). `graph_id` per rule 2 is included on
every top-level writable table for readability; a real migration script SHOULD write it once as
a shared macro/snippet rather than repeat it by hand.

```sql
-- ============================== schema bookkeeping ==============================
PRAGMA user_version = 1;

CREATE TABLE schema_migration (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  description TEXT NOT NULL
);

-- ============================== state: page / block ==============================

CREATE TABLE page (
  id           TEXT PRIMARY KEY,                 -- 14-char id, ids.ts
  graph_id     TEXT NOT NULL DEFAULT 'default',
  name         TEXT NOT NULL,                    -- display name, "/"-separated namespaces
  key          TEXT NOT NULL,                    -- normalizePageName(name); unique among live pages
  journal_day  INTEGER,                          -- YYYYMMDD; NULL for non-journal pages
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  name_hlc     TEXT NOT NULL,
  deleted_hlc  TEXT,
  CHECK (journal_day IS NULL OR journal_day BETWEEN 10000101 AND 99991231)
);
CREATE UNIQUE INDEX page_key         ON page(key)         WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX page_journal_day ON page(journal_day) WHERE journal_day IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX page_updated_at ON page(updated_at);

CREATE TABLE block (
  id             TEXT PRIMARY KEY,                -- 14-char id, ids.ts
  graph_id       TEXT NOT NULL DEFAULT 'default',
  page_id        TEXT NOT NULL REFERENCES page(id),
  parent_id      TEXT REFERENCES block(id),        -- NULL = top-level
  order_key      TEXT NOT NULL,                    -- fractional index among siblings
  content        TEXT NOT NULL DEFAULT '',
  marker         TEXT CHECK (marker IS NULL OR marker IN ('TODO','DOING','LATER','NOW','WAITING','DONE','CANCELED')),
  priority       TEXT CHECK (priority IS NULL OR priority IN ('A','B','C')),
  collapsed      INTEGER NOT NULL DEFAULT 0,
  scheduled_day  INTEGER,
  scheduled_time TEXT,                             -- 'HH:MM', nullable
  deadline_day   INTEGER,
  deadline_time  TEXT,
  repeat         TEXT,                             -- opaque, e.g. '1w' / '1w from done'
  done_at        INTEGER,                          -- epoch ms
  due_day        INTEGER GENERATED ALWAYS AS (coalesce(scheduled_day, deadline_day)) STORED,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  place_hlc      TEXT NOT NULL,                    -- covers (page_id, parent_id, order_key) atomically
  content_hlc    TEXT NOT NULL,
  marker_hlc     TEXT,
  priority_hlc   TEXT,
  collapsed_hlc  TEXT,
  scheduled_hlc  TEXT,
  deadline_hlc   TEXT,
  repeat_hlc     TEXT,
  done_hlc       TEXT,
  deleted_hlc    TEXT,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX block_children     ON block(parent_id, order_key) WHERE deleted_at IS NULL;
CREATE INDEX block_page         ON block(page_id)               WHERE deleted_at IS NULL;
CREATE INDEX block_open_tasks   ON block(due_day, id)
  WHERE deleted_at IS NULL AND marker IN ('TODO','DOING','LATER','NOW','WAITING');
CREATE INDEX block_marker       ON block(marker) WHERE deleted_at IS NULL AND marker IS NOT NULL;

CREATE TABLE block_prop (
  block_id TEXT NOT NULL REFERENCES block(id),
  key      TEXT NOT NULL,
  value    TEXT,                -- NULL = removed (tombstone row, kept for HLC)
  hlc      TEXT NOT NULL,
  PRIMARY KEY (block_id, key)
) WITHOUT ROWID;
CREATE INDEX block_prop_key_value ON block_prop(key, value);

CREATE TABLE page_prop (
  page_id TEXT NOT NULL REFERENCES page(id),
  key     TEXT NOT NULL,
  value   TEXT,
  hlc     TEXT NOT NULL,
  PRIMARY KEY (page_id, key)
) WITHOUT ROWID;
CREATE INDEX page_prop_key_value ON page_prop(key, value);

-- ============================== state: settings / keybindings / plugins ==============================

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,     -- dotted.lower.case, e.g. 'embedding.model', 'mirror.enabled'
  graph_id   TEXT NOT NULL DEFAULT 'default',
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  hlc        TEXT NOT NULL
);

CREATE TABLE keybinding (
  id         TEXT PRIMARY KEY,     -- 14-char id, one row per override
  graph_id   TEXT NOT NULL DEFAULT 'default',
  key        TEXT NOT NULL,        -- key chord, e.g. 'Mod-k'
  command    TEXT NOT NULL,        -- command id, e.g. 'nav.journals'
  when_expr  TEXT,                 -- context expression; NULL = global
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  hlc        TEXT NOT NULL,
  deleted_hlc TEXT
);
CREATE INDEX keybinding_command ON keybinding(command) WHERE deleted_at IS NULL;
CREATE INDEX keybinding_key     ON keybinding(key)     WHERE deleted_at IS NULL;

CREATE TABLE plugin (
  id            TEXT PRIMARY KEY,   -- manifest id, e.g. 'nooklet.mermaid'
  graph_id      TEXT NOT NULL DEFAULT 'default',
  version       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  settings_json TEXT NOT NULL DEFAULT '{}',
  installed_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  hlc           TEXT NOT NULL       -- covers (enabled, settings_json) as one field
);

-- ============================== op log (shared schema; retention differs) ==============================

CREATE TABLE op (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,  -- server: assigned on accept; client: mirrors server's seq
  id           TEXT NOT NULL UNIQUE,               -- == hlc
  hlc          TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  kind         TEXT NOT NULL,                      -- 'page.create' | ... | 'block.delete' | ...
  entity       TEXT NOT NULL,                      -- page id or block id (polymorphic; no FK)
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','noop','rejected'))
);
CREATE INDEX op_hlc    ON op(hlc);
CREATE INDEX op_entity ON op(entity, seq);

-- ============================== derived: refs ==============================

CREATE TABLE ref (
  id           INTEGER PRIMARY KEY,
  src_block_id TEXT NOT NULL REFERENCES block(id),
  src_page_id  TEXT NOT NULL REFERENCES page(id),
  kind         TEXT NOT NULL CHECK (kind IN ('page','tag','block','embed')),
  dst_page_key TEXT,             -- normalized key; set for every kind (see rule 11)
  dst_page_id  TEXT,             -- resolved page id if it currently exists
  dst_block_id TEXT              -- resolved block id; set for kind IN ('block','embed')
);
CREATE INDEX ref_src           ON ref(src_block_id);
CREATE INDEX ref_dst_page_key  ON ref(dst_page_key) WHERE dst_page_key IS NOT NULL;
CREATE INDEX ref_dst_block     ON ref(dst_block_id) WHERE dst_block_id IS NOT NULL;

CREATE TABLE path_ref (
  block_id TEXT NOT NULL REFERENCES block(id),
  page_key TEXT NOT NULL,
  page_id  TEXT,
  PRIMARY KEY (block_id, page_key)
) WITHOUT ROWID;
CREATE INDEX path_ref_page_key ON path_ref(page_key);

CREATE TABLE page_alias (
  page_id   TEXT NOT NULL REFERENCES page(id),
  alias_key TEXT NOT NULL,
  PRIMARY KEY (page_id, alias_key)
) WITHOUT ROWID;
CREATE INDEX page_alias_key ON page_alias(alias_key);

-- ============================== derived: full-text search ==============================

CREATE VIRTUAL TABLE block_fts USING fts5(
  content, content='block', content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
);
CREATE VIRTUAL TABLE block_tri USING fts5(
  content, content='block', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER block_fts_ai AFTER INSERT ON block BEGIN
  INSERT INTO block_fts(rowid, content) VALUES (new.rowid, new.content);
  INSERT INTO block_tri(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER block_fts_ad AFTER DELETE ON block BEGIN
  INSERT INTO block_fts(block_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO block_tri(block_tri, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER block_fts_au AFTER UPDATE OF content ON block BEGIN
  INSERT INTO block_fts(block_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO block_fts(rowid, content) VALUES (new.rowid, new.content);
  INSERT INTO block_tri(block_tri, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO block_tri(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE VIRTUAL TABLE page_fts USING fts5(
  name, content='page', content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
);
CREATE VIRTUAL TABLE page_tri USING fts5(
  name, content='page', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER page_fts_ai AFTER INSERT ON page BEGIN
  INSERT INTO page_fts(rowid, name) VALUES (new.rowid, new.name);
  INSERT INTO page_tri(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER page_fts_ad AFTER DELETE ON page BEGIN
  INSERT INTO page_fts(page_fts, rowid, name) VALUES('delete', old.rowid, old.name);
  INSERT INTO page_tri(page_tri, rowid, name) VALUES('delete', old.rowid, old.name);
END;
CREATE TRIGGER page_fts_au AFTER UPDATE OF name ON page BEGIN
  INSERT INTO page_fts(page_fts, rowid, name) VALUES('delete', old.rowid, old.name);
  INSERT INTO page_fts(rowid, name) VALUES (new.rowid, new.name);
  INSERT INTO page_tri(page_tri, rowid, name) VALUES('delete', old.rowid, old.name);
  INSERT INTO page_tri(rowid, name) VALUES (new.rowid, new.name);
END;

-- ============================== server-only: audit, mirror, tokens, devices ==============================

CREATE TABLE changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id    TEXT NOT NULL DEFAULT 'default',
  batch_id    TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('user','api','mcp','sync','plugin','import','mirror','system')),
  actor       TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('page','block','setting','keybinding','plugin','asset')),
  entity_id   TEXT NOT NULL,
  op_ids_json TEXT NOT NULL DEFAULT '[]',   -- '[]' only for entity_type='asset' (never in the op log)
  before_json TEXT,
  after_json  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX changes_batch  ON changes(batch_id);
CREATE INDEX changes_entity ON changes(entity_type, entity_id, seq);

-- mcp-tools.md §3.6: a write's stored response, replayed for a retry carrying the same
-- idempotency_key. Per token; rows older than 24 h are ignored on read and purged on write.
CREATE TABLE idempotency (
  token_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,     -- sha256 of the parsed input, keys sorted
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (token_id, key)
) WITHOUT ROWID;

CREATE TABLE token (
  id           TEXT PRIMARY KEY,
  graph_id     TEXT NOT NULL DEFAULT 'default',
  label        TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('read','write','admin')),
  can_sync     INTEGER NOT NULL DEFAULT 0,
  ui_control   INTEGER NOT NULL DEFAULT 0,   -- ADR 015 §7: the ui:control capability, never implied by scope
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE device (
  id           TEXT PRIMARY KEY,     -- 8 lowercase hex, hlc.ts
  graph_id     TEXT NOT NULL DEFAULT 'default',
  name         TEXT NOT NULL,
  token_id     TEXT REFERENCES token(id),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  acked_seq    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE mirror_file (
  path         TEXT PRIMARY KEY,      -- relative to $NOOKLET_DATA
  graph_id     TEXT NOT NULL DEFAULT 'default',
  page_id      TEXT NOT NULL REFERENCES page(id),
  content_hash TEXT NOT NULL,
  written_at   INTEGER NOT NULL
);
CREATE INDEX mirror_file_page ON mirror_file(page_id);

-- ADR 017: page-level tags, derived from the page's `tags::` property plus the intrinsic
-- `Journal` tag on every journal day. Rebuilt on every page write, like `ref`.
CREATE TABLE page_tag (
  page_id     TEXT NOT NULL REFERENCES page(id),
  tag_key     TEXT NOT NULL,
  tag_page_id TEXT,
  source      TEXT NOT NULL CHECK (source IN ('property','intrinsic')),
  PRIMARY KEY (page_id, tag_key)
) WITHOUT ROWID;
CREATE INDEX page_tag_key ON page_tag(tag_key);

-- api-and-plugin-types.md §4: `ctx.kv`, one namespace per plugin.
CREATE TABLE plugin_kv (
  plugin_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
) WITHOUT ROWID;

CREATE TABLE asset (
  id         TEXT PRIMARY KEY,
  graph_id   TEXT NOT NULL DEFAULT 'default',
  file_name  TEXT NOT NULL,
  ext        TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX asset_sha256 ON asset(sha256) WHERE deleted_at IS NULL;

-- ============================== server-only: embeddings ==============================

CREATE TABLE embedding_model (
  id         INTEGER PRIMARY KEY,
  graph_id   TEXT NOT NULL DEFAULT 'default',
  provider   TEXT NOT NULL,             -- 'ollama' | 'openai-compat'
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  table_name TEXT NOT NULL UNIQUE,      -- 'embedding_vec_<id>'
  active     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  ready_at   INTEGER
);
CREATE UNIQUE INDEX embedding_model_active ON embedding_model(active) WHERE active = 1;

CREATE TABLE embedding (
  id            INTEGER PRIMARY KEY,     -- also this row's rowid in embedding_vec_<model_id>
  model_id      INTEGER NOT NULL REFERENCES embedding_model(id),
  unit_kind     TEXT NOT NULL CHECK (unit_kind IN ('block','page')),
  block_id      TEXT REFERENCES block(id),
  page_id       TEXT NOT NULL REFERENCES page(id),
  text_hash     TEXT NOT NULL,
  embedded_hash TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
  error         TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX embedding_model_block ON embedding(model_id, block_id) WHERE block_id IS NOT NULL;
CREATE UNIQUE INDEX embedding_model_page  ON embedding(model_id, page_id)  WHERE unit_kind = 'page';
CREATE INDEX embedding_pending ON embedding(model_id) WHERE status <> 'done';

CREATE TABLE embed_dirty (
  unit_kind   TEXT NOT NULL CHECK (unit_kind IN ('block','page')),
  unit_id     TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (unit_kind, unit_id)
) WITHOUT ROWID;

-- Created dynamically per model (rule 18); dims is a literal read from the model, never user input:
-- CREATE VIRTUAL TABLE embedding_vec_<id> USING vec0(
--   id        INTEGER PRIMARY KEY,
--   kind      TEXT,
--   page_key  TEXT,
--   embedding FLOAT[<dims>] distance_metric=cosine
-- );

-- ============================== client-only ==============================

CREATE TABLE pending_op (
  id      TEXT PRIMARY KEY,   -- == hlc
  hlc     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  entity  TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,     -- 'server_cursor' | 'device_id' | 'hlc_last'
  value TEXT NOT NULL
);
```

### Row types (server storage layer, `packages/server`)

These extend, but do not replace, `packages/core/src/model.ts`'s `Page`/`Block` (the live-view
domain types): a `Row` type is what the storage layer reads/writes; the domain type is what the
rest of the app (editor, API, MCP) sees, produced by dropping the `_hlc`/`deleted_*` columns
after filtering `deleted_at IS NULL`.

```ts
import type { Block, Page, Priority, TaskMarker } from "@nooklet/core";

export interface PageRow extends Page {
  graphId: string;
  deletedAt: number | null;
  nameHlc: string;
  deletedHlc: string | null;
}

export interface BlockRow extends Block {
  graphId: string;
  scheduledDay: number | null;
  scheduledTime: string | null;   // 'HH:MM'
  deadlineDay: number | null;
  deadlineTime: string | null;
  repeat: string | null;
  doneAt: number | null;          // epoch ms
  dueDay: number | null;          // generated column, read-only
  deletedAt: number | null;
  placeHlc: string;
  contentHlc: string;
  markerHlc: string | null;
  priorityHlc: string | null;
  collapsedHlc: string | null;
  scheduledHlc: string | null;
  deadlineHlc: string | null;
  repeatHlc: string | null;
  doneHlc: string | null;
  deletedHlc: string | null;
}
```

### Worked-example op (JSON, matches `packages/core/src/ops.ts`'s `Op` type)

```json
{
  "id": "2026-09-10T14:22:03.501Z-0000-a1b2c3d4",
  "hlc": "2026-09-10T14:22:03.501Z-0000-a1b2c3d4",
  "device": "a1b2c3d4",
  "entity": "1k7f3q9xz2hb01",
  "payload": {
    "kind": "block.create",
    "place": { "pageId": "1k7f3q9xz2hava", "parentId": null, "order": "a0" },
    "content": "Ship the [[SQL schema]] spec",
    "marker": "TODO",
    "properties": { "scheduled": "2026-09-12", "area": "writing" },
    "createdAt": 1789050123501
  }
}
```

## Examples

Worked scenario: page **"Projects/Nooklet"** with three blocks — a top-level task block with a
page ref and a `scheduled::` date, its one child, and a second top-level block. Ids are
illustrative (valid Crockford-base32 14-char strings, not generated by `newId()`).

Tree:
```
Projects/Nooklet
- TODO Ship the [[SQL schema]] spec
  scheduled:: 2026-09-12
  area:: writing                         ^1k7f3q9xz2hb01
  - Cover linked references              ^1k7f3q9xz2hb02
- Follow-up: embeddings design           ^1k7f3q9xz2hb03
```

`page`:

| id | name | key | journal_day | name_hlc |
|---|---|---|---|---|
| `1k7f3q9xz2hava` | Projects/Nooklet | projects/nooklet | NULL | `2026-09-10T14:20:00.000Z-0000-a1b2c3d4` |

`block` (only the columns relevant to this example shown):

| id | page_id | parent_id | order_key | content | marker | scheduled_day | due_day |
|---|---|---|---|---|---|---|---|
| `1k7f3q9xz2hb01` | `1k7f3q9xz2hava` | NULL | `a0` | `Ship the [[SQL schema]] spec` | TODO | 20260912 | 20260912 |
| `1k7f3q9xz2hb02` | `1k7f3q9xz2hava` | `1k7f3q9xz2hb01` | `a0` | `Cover linked references` | NULL | NULL | NULL |
| `1k7f3q9xz2hb03` | `1k7f3q9xz2hava` | NULL | `a1` | `Follow-up: embeddings design` | NULL | NULL | NULL |

`block_prop`:

| block_id | key | value | hlc |
|---|---|---|---|
| `1k7f3q9xz2hb01` | area | writing | `2026-09-10T14:22:03.501Z-0000-a1b2c3d4` |

`ref` (the `[[SQL schema]]` page does not exist yet, so `dst_page_id` is `NULL`):

| id | src_block_id | src_page_id | kind | dst_page_key | dst_page_id |
|---|---|---|---|---|---|
| 1 | `1k7f3q9xz2hb01` | `1k7f3q9xz2hava` | page | sql schema | NULL |

`path_ref` (block 1's own ref is inherited by its child, block 2; block 3 has no refs of its
own and no ancestors, so it only carries its own page):

| block_id | page_key | page_id |
|---|---|---|
| `1k7f3q9xz2hb01` | projects/nooklet | `1k7f3q9xz2hava` |
| `1k7f3q9xz2hb01` | sql schema | NULL |
| `1k7f3q9xz2hb02` | projects/nooklet | `1k7f3q9xz2hava` |
| `1k7f3q9xz2hb02` | sql schema | NULL |
| `1k7f3q9xz2hb03` | projects/nooklet | `1k7f3q9xz2hava` |

`op` produced by creating block 1 (the JSON op is in the Interfaces section above):

| seq | id | hlc | device_id | kind | entity | status |
|---|---|---|---|---|---|---|
| 501 | `2026-09-10T14:22:03.501Z-0000-a1b2c3d4` | (same) | a1b2c3d4 | block.create | `1k7f3q9xz2hb01` | applied |

`embed_dirty` rows inserted by that same `block.create` (block unit for the new block, and the
page unit — no ancestors yet since it is top-level):

| unit_kind | unit_id |
|---|---|
| block | `1k7f3q9xz2hb01` |
| page | `1k7f3q9xz2hava` |

## Test cases

1. **Property LWW, stale op is a no-op.** Given `block.marker_hlc = 'T2'` and an incoming
   `block.prop {key:'marker', value:'DONE'}` op with `hlc = 'T1' < 'T2'` (string-compared) →
   expected: no column change, `op.status = 'noop'`.
2. **`block.place` cycle rejection.** Given the tree `root → a → b → c` and an incoming
   `block.place` moving `a` under `c` → expected: recursive-CTE check finds `a` in `c`'s
   ancestor chain (verified in `check_cycle.mjs`: `move a under c` → `found: 1`), op recorded
   `status = 'rejected'`, and a new corrective `block.place` op is appended to `op` with
   `entity = 'a'`, the unchanged place, `device` = the server's reserved id, and an `hlc`
   strictly greater than the rejected op's.
3. **Linked references, worked example.** Given the scenario above and a query for page
   `"SQL schema"` (not yet created, so `:pid` is unset / the query runs by key only) → the
   linked-references query (rule 13) run with `path_ref.page_key = 'sql schema'` returns exactly
   `{page_id: projects/nooklet, block_id: 1k7f3q9xz2hb01}` and
   `{page_id: projects/nooklet, block_id: 1k7f3q9xz2hb02}` (block 3 is excluded — it has no
   `sql schema` entry in `path_ref`), grouped under one source page.
4. **Unlinked references exclude an already-linked block.** Given a fourth block whose text is
   the literal string `"SQL schema notes"` (an FTS hit, no `[[...]]` syntax) and block 1 from the
   worked example (a real `[[SQL schema]]` ref) → the unlinked-references query (rule 14) for
   `"SQL schema"` returns only the fourth block; block 1 is excluded by the `NOT EXISTS` against
   `path_ref`.
5. **Tasks view is index-driven.** `EXPLAIN QUERY PLAN` for the rule 9 query against a `block`
   table with the `block_open_tasks` partial index present MUST report
   `SEARCH block USING INDEX block_open_tasks` (or equivalent `SCAN ... USING INDEX`), never
   `SCAN block` without an index — verified pattern in `check_gen.mjs` against a 3-row table;
   the same index is used regardless of table size since it is a B-tree, not a heuristic.
6. **`rebuild()` parity.** Given any sequence of ops applied live to produce state `S`, running
   `rebuild()` (replay into empty state tables, then reindex per rule 26) MUST produce state
   tables byte-identical to `S` for every column except purely-derived bookkeeping that is
   allowed to legitimately differ in wall-clock value only if recomputed at a different instant
   (there is none in this schema — every `updated_at` is sourced from an HLC's wall component,
   which is itself part of the replayed op, so even `updated_at` MUST match exactly).
7. **Embedding model switch leaves search working throughout.** Given `embedding_model` row 1
   (bge-m3, active) and a switch to model 2 (qwen3-embedding:8b) → until
   `SELECT count(*) FROM embedding WHERE model_id = 2 AND status <> 'done'` reaches `0`, KNN/
   hybrid queries MUST keep resolving `table_name` from the row with `active = 1` (still row 1);
   the flip (rule 19) only ever changes which row has `active = 1`, and does so inside a single
   transaction so no query ever observes zero or two active rows.

## Open issues

1. **Required core additions.** `packages/core/src/ops.ts`'s `RESERVED_BLOCK_PROPS` must gain
   `scheduled, deadline, repeat, done` (rule 8) — small, additive, non-breaking. Separately,
   `OpPayload` has no op kinds for `setting`/`keybinding`/`plugin` writes (rule 25); this schema
   defines their tables but not their op payload shapes, which belong to a future
   commands/settings/plugins spec. Until that lands, `setting`/`keybinding`/`plugin` writes are a
   documented gap in "every write is an op" (ADR 003 principle 1) — implementers MUST NOT invent
   a second, non-op write path for them as a stopgap, since that would need to be unwound later.
2. **Page-name-collision reconciliation is out of scope here.** Rule 24's `page.create` handling
   guarantees `page.key` uniqueness at the DB level but does not specify how a client whose own
   `page.create` was rejected re-parents blocks it already placed under the losing id. This is a
   sync-protocol concern for a (not yet written) sync spec, not a storage-schema concern; flagged
   so it is not silently forgotten.
3. **`done::` timestamp format is this spec's assumption, not ADR 011's.** ADR 011 says
   completing a task "stamps `done:: <timestamp>`" without fixing the exact string grammar. This
   spec fixes it to full ISO 8601 UTC with seconds (`YYYY-MM-DDTHH:MM:SSZ`) so `done_at` has an
   unambiguous parse. The markdown-grammar spec and any future scheduling spec MUST use this same
   format, or explicitly supersede it here.
4. **`repeat::`'s exact grammar is deferred.** This schema stores it as opaque `TEXT` and only
   requires ADR 011's two literal examples (`1w`, `1w from done`) to round-trip; the full
   repeater grammar (units beyond weeks, validation) is owned by whichever spec implements the
   scheduling feature's repeat-advance logic.
5. **Namespace shortest-unambiguous-suffix resolution** (PLAN.md §4) is referenced by rule 11 but
   its exact algorithm is not re-derived in this document — it belongs to a references/
   markdown-grammar spec. This schema only commits to the *shape* of the result (`ref.dst_page_key`
   is always a normalized key string, resolved once at extraction time) and to a namespace
   hierarchy query (rule 3) that any resolution algorithm can call.
6. **Property-key naming is a cross-spec contract.** Every other spec that reads or writes
   properties (markdown grammar, MCP tool schemas, the Tasks view, plugins declaring
   `props::` templates) MUST treat these key names as reserved and pre-parsed by `applyOps`,
   never as ordinary `block_prop` rows: `marker`, `priority`, `collapsed`, `id`, `scheduled`,
   `deadline`, `repeat`, `done`. All other keys are lowercase with `-` (not `_`) per
   `00-conventions.md` and land in `block_prop`/`page_prop` verbatim, including `tags` and
   `alias`, which are generic but semantically special to `refs.ts` and `page_alias` (rule 6).
7. **`asset` is the one entity type with no `op` row.** `changes.op_ids_json = '[]'` is allowed
   only for `entity_type = 'asset'` (rule 21); every other `changes` row MUST reference at least
   one real `op.id`. A future spec adding content-addressed asset dedup across graphs would need
   to revisit whether this exception still holds.
8. **`block_prop`/`page_prop` do not currently enforce typed values.** PLAN.md §8 describes typed
   properties (text, number, date, checkbox, page, url, list) validated against a
   `property/<key>` definition page. This schema stores every value as `TEXT` on the wire
   (per `packages/core/src/model.ts`'s `Properties = Record<string, string>`) and leaves type
   *validation* to the editor/property-definition layer, not the database — a deliberate scope
   cut consistent with `00-conventions.md` ("values stay strings on the wire so sync stays
   trivial"), noted here so a future properties spec does not assume DB-level type enforcement
   exists.
