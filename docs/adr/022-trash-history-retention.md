# ADR 022: The trash never expires; history is the audit log; "restore this version" is a walk of undos

Date: 2026-09-12. Status: accepted. Implements research/13 §4.2 item 8 (and the retention half of
item 10a's asset GC).

## Context

Every write is already an op in the log, every deletion is already a tombstone (`deleted_at`,
ADR 003), and every write already records a full before/after image per entity in `changes`
(ADR 013). So "trash" and "page history" were, in the data, already there — what was missing was
a way to read them and a way to act on them, and an honest statement of what they promise.

Three of the v1 tool descriptions promised deletions were "restorable for 30 days". Nothing
implemented that: `nooklet gc` (M6) trims the `op` table and never touches a `page`/`block` row,
so tombstones were kept forever and nothing listed them. The review of 2026-09-12 struck the
wording (B-56). This ADR decides what the promise actually is.

## Decisions

### 1. Retention: none. The trash is kept indefinitely.

`page`/`block` rows with a tombstone are never hard-deleted. `trash.list` shows all of them;
`trash.restore` brings any of them back. The asset GC (below) treats a reference from a
tombstoned block as a live reference for the same reason.

**Rejected: purge tombstones after N days.** It costs more than it saves, in four places:

- `nooklet verify` replays the op log and diffs it against live state (ADR 003's core guarantee).
  A purged row reappears on replay, so every purge is a permanent, growing "expected divergence"
  — unless the purge is gated behind the op-log GC floor, at which point it is a second GC with
  its own floor logic for a table that is a rounding error in size (tens of KB of tombstones next
  to an 85 MB vector table, sql-schema.md rule 28).
- A device that was offline through the purge can still push a `block.text` for the purged block.
  Core's `applyOps` treats a missing row as "no such block" (noop), so the edit is silently lost,
  and a `block.place` of a live child under a purged parent is a rejected move. Both are new
  failure modes for a feature whose whole point is trust.
- `((block-ref))` targets, `changes.entity_id`, `path_ref` and the FTS shadow tables all key on
  the id. A purge is a cascade, and each table has its own trigger semantics.
- The saving is disk that nobody will miss.

**Not done, recorded:** a "purge now" button on the trash view, gated behind the GC floor, is the
shape a future purge would take if someone actually wants one. Nothing in this design prevents it.

### 2. What one trash entry is, and what a restore brings back

The grouping key is the **tombstone instant**. Every deleter stamps one `now` across the whole
action — the editor's `deleteSelectedBlocks`, the API's `block.delete` (the subtree) and
`page.delete` (the page and its blocks). So:

- A **page** entry is a tombstoned page. Restoring it un-deletes the page and every block on it
  whose `deleted_at` equals the page's; blocks that were never tombstoned (hidden only because
  the page was) simply reappear. A block deleted separately, earlier, keeps its own tombstone —
  it is not offered while its page is in the trash (it could not be restored on its own), and it
  becomes its own entry once the page is back.
- A **block** entry is a tombstoned block on a live page whose parent is live or was tombstoned
  at a different instant — the root of a delete action. Restoring it un-deletes the descendants
  that share its instant, plus any tombstoned ancestor, so the block is actually visible rather
  than live-but-hidden. Only the ancestor chain is revived, not the ancestors' other deleted
  children; those stay as their own entries.
- A page whose name has since been taken by a live page is refused with `conflict` unless
  `new_name` is given. Core's `applyPageDelete(null)` does not re-check the live-name unique
  index (B-90), so without the guard the write would fail on a SQL constraint mid-transaction.

**Known limitation:** two separate delete actions in the same millisecond share an instant and
merge into one entry; restoring one restores both. Real actions are never that close; in-process
tests space theirs out.

**Rejected: the deleting batch as the grouping key.** More precise on paper, but a sync push is
one batch per HTTP request (200 ops), so a large subtree delete from a device spans batches and
would split into several entries; the timestamp does not.

**Rejected: a raw `UPDATE … SET deleted_at = NULL`.** It would be one line and wrong twice, for
the reasons ADR 018 gives for its migration: other devices never hear of it, and `verify` flags
it. The restore mints `page.delete`/`block.delete {deletedAt: null}` ops through
`serverApplyOps`, exactly as `batch.undo` does — so it replicates, it is audited, and it is
itself a batch that `batch.undo` can reverse.

### 3. History is the audit log, grouped by batch

`page.history` reads the `changes` rows for the page entity and for every block currently on the
page, grouped by `batch_id` (one batch = one write call, one sync push, one undo), newest first,
each with a summary in words and the per-entity before/after images the client diffs. A batch
whose ops were all LWW-stale or identical re-sends changed nothing visible and is hidden.

"This page's" rows are attributed by the block's *current* page: a block moved here brings its
earlier history along, one moved away takes it. Same choice as `changes.since`'s `page` filter;
the alternative (parsing every row's `place.pageId`) is a full scan for a distinction nobody
asked for.

### 4. "Restore this version" is `batch.undo` of every newer batch, newest first — from the client

The op log has no page snapshots to jump to. What it has is each batch's before-image, and
`batch.undo` already turns one batch into a complete, audited, LWW-winning compensating write.
Restoring the page as it was after batch K is therefore: undo every batch newer than K on this
page, newest first. The History view does exactly that after a confirm that says how many.

What this honestly is and is not:

- **Not atomic across batches.** If step 3 of 5 fails, the page is left after step 2, and the
  view says so. Each step is atomic on its own.
- **Not page-scoped.** A batch that also touched another page (a cross-page move, a `batch` op,
  a graph-wide replace) is undone there too. The confirm says so.
- **Recorded.** Each undo is its own batch, so the walk shows up in the timeline and can be
  undone in turn — there is no separate redo.

**Rejected: a server-side `page.restore_version` op.** It would call `batch.undo`'s logic in a
loop inside one savepoint, which buys all-or-nothing across the walk — but the cross-page
semantics are identical, the audit trail is identical (still one batch per undo), and it means
either re-implementing or re-exporting `batch.undo`'s compensation. Worth doing when someone
actually hits the partial-failure case; recorded here so the shape is known.

**Rejected: page snapshots.** A per-write full-page image would make "jump to version K" one
op, at the cost of storing every page's whole text on every keystroke batch. The per-entity
images already stored are the right granularity for a tool whose unit of change is the block.

### 5. Asset orphans and the trash

An asset is an orphan only when no block text or property value — **live or tombstoned** —
mentions `assets/<id>.<ext>`, and the upload is older than a grace period (7 days by default,
`--asset-grace`). The trash-only rule follows from decision 1: a page restored from the trash
must not come back with broken images. The grace period exists because the one legitimate
unreferenced window is between an upload and the block write that embeds it, which can sit in an
offline device's push queue for as long as a laptop stays closed; a week covers a holiday, and a
monthly `nooklet gc` still collects. A `changes` row for the asset newer than the cutoff extends
the grace, so a future "touched on deduplicated re-upload" audit row (B-91) needs no GC change.

## Consequences

- `docs/spec/mcp-tools.md` gains `trash.list`, `trash.restore`, `page.history` (rows 25–27); the
  earlier note that `trash.*` would be HTTP-only is superseded — an agent that deletes the wrong
  thing needs the trash as much as a person does.
- Tool descriptions say "the trash has no expiry", never a number of days.
- `/trash` and `/history/<name>` are routes; the history route is not nested under `/page/…`
  because that route is a splat and would read `/history` as part of the page name.
- The web client's `data/history.ts` carries its own copy of `store.ts`'s `stamped` invalidation
  idiom; `store.ts` keeps its signals private and is owned by another workstream this milestone.
- Open follow-ups, logged: B-90 (core should reject a colliding un-delete the way it rejects a
  colliding rename), B-91 (record a deduplicated re-upload so the asset GC sees it as recent).
