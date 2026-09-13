# ADR 017: Page-level tags, and how a journal becomes `#Journal`

Date: 2026-09-11. Status: accepted.

## Context

A block becomes a task by carrying a marker, and ADR-less precedent (see `apply-ops.ts`'s
`rebuildRefRows`) now has every marked block emit a derived `tag` ref to the `Task` page. That
works because refs are **per block**: `ref.src_block_id` is `NOT NULL` and every consumer joins
through `block`.

Journals are different. "This page is a journal" is a fact about the **page**, and there is
nowhere to put it. The same is true of any page-level tag a person might want — Logseq's
`tags::` page property, which is how you say "this page is a Person / a Project / a Book".

Three things want this at once:

1. `#Journal` on daily pages, so journals are reachable through the same machinery as anything
   else rather than only through the journal stream's bespoke `journal_day` query.
2. User-set page tags (`tags:: person, czech`), which the importer already reads from Logseq
   graphs and which currently only survive as an inert `page_prop` row.
3. A place for "pages tagged X" to come from, so a tag page can list them the way a page lists its
   backlinks.

## Decision

**A derived `page_tag` index, maintained on write, alongside `ref` rather than inside it.**

```sql
CREATE TABLE page_tag (
  page_id     TEXT NOT NULL REFERENCES page(id),
  tag_key     TEXT NOT NULL,            -- normalizePageName of the tag
  tag_page_id TEXT,                     -- the tag's own page, when one exists
  source      TEXT NOT NULL CHECK (source IN ('property','intrinsic')),
  PRIMARY KEY (page_id, tag_key)
) WITHOUT ROWID;
CREATE INDEX page_tag_key ON page_tag(tag_key);
```

Two sources feed it, and the distinction is the point:

- **`property`** — from the page's `tags` property, split on commas with `[[…]]` unwrapped, the
  same shape `extractRefs` already applies to a block's `tags`. User-settable and user-removable.
- **`intrinsic`** — derived from a fact the page already carries. Today exactly one rule:
  `journal_day IS NOT NULL` ⇒ `Journal`. Not removable, because removing it would not mean
  anything: the page either has a journal day or it does not.

`page.backlinks` gains a `tagged_pages` group, so asking about `Journal` or `Person` returns the
pages carrying that tag next to the blocks that link to it. *(Built 2026-09-13, B-111:
`page.backlinks` returns `tagged_pages` + `tagged_total`, windowed by the same `limit`/`cursor` as
`linked`, and the References panel shows "Pages tagged X" above linked references. The
remove-control distinction in Consequences is still not built — the panel lists both sources
alike.)*

## Why not the alternatives

**Relax `ref.src_block_id` to nullable and put page refs there.** One table, uniform "what points
at X". Rejected: every existing query joins `ref` to `block` and would silently drop or
mis-handle page-sourced rows, and the ones that do not would need auditing for a constraint that
exists precisely to keep them honest. Weakening a `NOT NULL` that six queries depend on, to add a
different kind of row, buys uniformity at the cost of making the existing rows less trustworthy.

**Store nothing; special-case `Journal` at read time.** Cheapest, and it is what a bolted-on
version would have looked like. Rejected because it answers exactly one question and generalises
to nothing: user-set page tags would still be inert, and every future tag query would be another
special case in `page.backlinks`.

**Write `tags:: Journal` into each journal page's properties on creation.** This is closest to
what Logseq does. Rejected for the same reason the `Task` tag is not written into block text: it
puts one fact in two places that can disagree. Delete the property and you have a page with a
`journal_day` that is not a Journal; import a graph whose journals lack the property and they are
not Journals either. Deriving it means the question "is this a journal?" has one answer.

## Consequences

- A schema migration (version 3 → 4) adding the table and backfilling it. The table is derived, so
  the backfill is a rebuild, not a data conversion, and `nooklet verify` keeps working unchanged
  because it compares live state rebuilt from the op log — derived indexes are not part of that
  comparison.
- `page_tag` must be rebuilt whenever a page's `tags` property or `journal_day` changes, which
  means the page-write path gains a hook exactly like `rebuildRefRows`.
- The client has no `page_tag` table (sql-schema.md rule 1: derived tables are server-only), so
  "pages tagged X" is an API call, like search and backlinks already are.
- UI can distinguish the two sources: a `property` tag is removable, an `intrinsic` one is shown
  but not offered a remove control. This is what makes Logseq's little `×` on a tag chip honest —
  there is nothing sensible for it to do on `Journal`.
- The obvious next users of this table are a tag page listing its members, and filtering the
  all-pages view by tag. Neither is required by this decision.

## Not included

Page icons/emoji (`page_prop.icon`) are a separate, simpler thing: a single displayed property,
no index needed. Mentioned only because it arrived in the same conversation.
