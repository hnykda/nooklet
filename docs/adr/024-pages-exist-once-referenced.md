# ADR 024: Pages exist once referenced

Date: 2026-09-13. Status: accepted (coordinator's decision, implemented on `m11/ref-pages`).

Numbering: the brief named this file `023-…`; `023-client-plugin-host.md` already holds that
number, so this is 024.

## Context

The owner, 2026-09-13: "http://127.0.0.1:6100/page/Sprouts/Growing/Sixth%20Try does not exist,
even though I did reference it already. We need to create pages on references, otherwise it's
also not showing in graph and stuff, right? This is how Logseq works."

A reference was a key in the derived `ref` table and nothing more: `dst_page_id` stayed NULL until
someone created the page by hand. A `.backup` of the owner's graph (taken 2026-09-13 17:34) had
**265 such keys and 1,355 such rows**: `task` (the derived Task tag, 686 rows), `quick capture` 89,
`acmecorp` 24, `call` 21, `idea` 21, `@eva svobodová` 17, `home automation` 8, … 17 of the 265
are journal days. None of them were in the graph view, All pages, search or `page_list`, and their
page view said "This page doesn't exist yet". In Logseq every one of them is a page.

## Decision

### 1. Every page reference makes the page exist

`[[X]]`, `[[X|label]]`, `#X`, `#[[X]]`, references in property values (`tags::` items; `[[…]]` and
`#…` in any other value), a page's own `tags::`, and the derived `Task` tag of a block with a task
marker. **Not** `alias::` items: they name the page they sit on. References in tombstoned blocks or
on deleted pages do not count (the `ref` index keeps their rows, so every query joins on liveness).

A namespaced name makes each ancestor exist (`Sprouts/Growing/Sixth Try` → `Sprouts`,
`Sprouts/Growing`), as Logseq does — and so does any live namespaced page, however it was made.

The page is named with the casing of the first referencing text: within one write, the first
occurrence; in the migration, the earliest block (`created_at`, then id).

**Journal days are not created from references.** Measured, not assumed:
`tools/probes/ref-link-typing.spec.ts` case 5 gave a day (today − 3) a page, deleted its only
block, and read the journal stream — `["Sep 13th, 2026 · Today","Sep 10th, 2026"]`, with an empty
"Start typing…" row for the 10th. `worker-core.ts#getJournalStream` lists every journal page in the
window and every future one. So `[[2026-12-24]]` or `SCHEDULED`-style date links would put empty
days into the stream. A date link already opens the day as a virtual page (`PageView.tsx`'s
journal-day branch), with its agenda. A slash-written date (`2026/09/10`) is a journal day too, so
it makes neither `2026` nor `2026/09`.

### 2. The server is the only authority

After a `serverApplyOps` batch applies, `packages/server/src/ref-pages.ts#planReferencedPages`
mints, in the same transaction, `page.create` for every key the batch left dangling (plus
ancestors) — always a new page. (A first version brought an unclaimed tombstone of the same name
back instead, to save rows; it was dropped because a replica can lack that tombstone, B-443, and an
un-delete would then reach every device but that one.) The ops are ordinary logged ops returned as the batch's
`corrections`: the pushing device applies them from the push response, every other device learns
of them by pull, and `nooklet verify` replays them like any other write. Clients never create pages
implicitly.

"Created from a reference" is recorded in the op log itself: these ops carry the reserved device id
`refpages` (`REFERENCE_DEVICE_ID`; real device ids are hex, so no device can produce it). Nothing
UI-visible, nothing a replay could reconstruct differently.

**Rejected: client-side creation.** Two devices race to create one name, and every
`page-key-collision` rejection would have to be reconciled on every client — the server-side rule
has to exist anyway for agents, the API and the importer, and a second implementation in the client
would disagree with it at the edges (aliases, journal days, the junk rule below).

**Rejected: virtual pages in the UI only.** The graph, search, `page_list`/`page_read` over MCP and
the markdown mirror are server-side; an agent would still not see the page, and every view would
need its own "is this name referenced?" special case.

### 3. Junk while typing, and pages that lose their last reference

Measured first (`tools/probes/ref-link-typing.spec.ts`, Chromium, port 6410, recording every
`/sync/push` body):

- `[[` does **not** auto-insert `]]`. After typing `[[` the buffer is `start see [[`; a name typed
  inside is not a reference until the popup's selection or a typed `]]` closes it.
- A new link typed at 80 ms/char: one push, with the finished link. At 700 ms/char (longer than the
  editor's 500 ms flush): 32 pushes, all `[[P`, `[[Pr`, … without `]]` — no reference — then the
  finished link. **1 distinct link.**
- An existing `[[Probe Foo]]` edited to `[[Probe Foobar baz]]` at 700 ms/char: 7 pushes, **7
  distinct complete links** (`Probe Foob`, `Probe Fooba`, …).
- `#probetag` typed at 700 ms/char: **8 distinct tags** (`#p` … `#probetag`).

So junk comes from editing inside an existing link and from tags, not from typing a new `[[link]]`.

Rule: a page is **unclaimed** while it was minted by `refpages`, no other device has an applied op
on it other than `page.delete`, it has never had a block row (tombstones included — a page whose
blocks sit in the trash is not junk) and it has no properties. When a write removes the last
reference to an unclaimed page (and no live page is namespaced under it), the server deletes it in
the same call, cascading to ancestors kept only by it. Unclaimed pages never show in the trash
(`HIDDEN_FROM_TRASH_SQL`: deleted by `refpages`, or created by it and never claimed — the second
covers `batch.undo` of the write that linked a page).

Writing that arrives after the deletion claims it too (B-445): a device offline when the link
went can have typed into the page, and core accepts a block on a tombstone. The next batch that
lands a block, a property or a rename on a page the rule deleted brings it back (evicting a newer
unclaimed page of the name first); if a claimed page holds the name by then it stays deleted and
is listed in the trash, which hides a page only while it holds nothing.

Deleting does not claim: deleting a still-referenced page cannot make it go away (the name keeps a
page, and this mechanism brings it straight back), and counting `batch.undo`'s server-device delete
as a claim put empty pages in the trash.

What claims a page: typing into it (a block row), a property, a rename by anyone else, and
`page.create` over the API (below).

### 4. Where an unclaimed page gives way

- **`page.create`** (API/MCP) for its name takes it over — same id, `page.rename` to the requested
  spelling (which claims it), properties as `page.prop`, markdown as blocks — and answers
  `existed: false`. An agent that links a page and then creates it gets the page it asked for, not
  "already existed" with its properties dropped.
- **`trash.restore`** of a page whose name an unclaimed page now holds deletes the unclaimed page
  first, in the same batch, instead of refusing. So do **`batch.undo`** of a page delete or rename,
  and **`page.update`** renaming a page to that name (the links then resolve to the renamed page).
  A page someone wrote in still refuses all three.
- **`ctx.data.pages.create`** (plugins) claims it like the op does.
- **An imported file** of that name: the importer deletes the unclaimed page before minting the
  file's `page.create` (both with server-clock HLCs, so the log's order holds on replay).
- **An `alias::`** that names it: the unclaimed page is deleted, because own key outranks alias in
  resolution and would otherwise keep `[[Nick]]` on the empty page.

And the other way: a page renamed away or deleted while its old name (or an alias it dropped) is
still referenced gets an empty page under that name again.

### 5. One-time migration for existing graphs

`packages/server/src/ref-pages-migration.ts#migrateReferencedPages`, in the shape of
`journal-names.ts`: gated by the `refs.pages_exist` setting, run from `cli.ts#open` by the writer
commands (`serve`, `import`, `mcp`) after the journal-name and pipe-alias migrations (their keys
must be right first). It uses the same `WantedPages` rules as the per-write planner and mints real
ops in chunks of 500.

On the graph copy (`tools/probes/ref-pages-migration-real-graph.ts`): **259 pages created** (248
keys + 11 ancestors) in **464 ms**; afterwards 17 keys still dangle — all 17 journal days, by
design; a second run is a no-op; `pnpm nooklet verify` OK over 20,705 ops.

The first measurement was 13,946 ms: every page write ran `reindexPageIdentity`, which scanned
`path_ref` (32,674 rows) by page id with no index — ~50 ms per page op on this graph, for every
rename or property toggle too. Schema v7 adds three partial indexes (B-440); 0.2–1.7 ms per
`page.create` after.

Each page the sweep creates is dated by its earliest reference (the referencing block's
`created_at`), not by the sweep: `page.updated_at` never changes after a create, and All pages'
default "Recently edited", `graph_overview`'s recent pages and the plugin page source sort by it —
stamped "now", all 259 sat above every page the owner wrote (B-446).

The importer writes with minting off (`referencedPages: "skip"`) — otherwise page A's `[[B]]` would
mint B before B's own file arrives and B's `page.create` would collide — and runs
`mintDanglingReferencedPages` (the ungated migration) once all files are in. `ImportStats` reports
`referencedPagesCreated`.

### 6. The markdown mirror

A page with no live blocks and no properties gets no file (Logseq writes none either), and a
page's file and `mirror_file` row are removed when its last block goes
(`mirror/export.ts#exportPage`). Without this the migration alone would add 259 empty files to
`pages/`.

### 7. The two-device race

Device A, offline, clicks Create on "X" and types, while device B's `[[X]]` makes the server create
"X". This existed before (two explicit creates) but this ADR makes it ordinary. The server refuses
A's `page.create` (`page-key-collision`) and every block on it (`no-such-page`); the server's page
was then refused in A's replica for the same collision, and nothing A typed ever synced (B-442).

**Rejected: the server rewrites A's late ops onto its page.** A's ops carry HLCs from before it
went offline — older than the server's `page.create` for X. `verify` (and any `rebuild`) replays in
HLC order, meets A's blocks before their page, and rejects them: replay parity breaks.

Instead: the push response names the page holding the name (`refused_pages`, a snapshot row), and a
pull that brings a `page.create`/`page.rename` for a name a local page holds is recognised too — but
only when that local page's `page.create` is still unconfirmed and the pulled page keeps the name to
the end of the batch; otherwise a device pulling an older, since-deleted page of its page's name
would move its content onto the tombstone.
Either way the client (`apps/web/src/sync/refused-page.ts`) removes its refused page and what was on
it, takes the server's page, and re-sends the blocks' current state onto it as fresh ops — fresh
HLCs, so the log's order is causal. Tested both orders against the real server in-process
(`apps/web/src/sync/e2e.test.ts`) and in Chromium (`e2e/tests/ref-pages.spec.ts`).

Known gap: a block that already existed on the server, moved onto the refused page and deleted
there, keeps its old place on the server.

### 8. The web client

No view needed a change: an existing page with no blocks already opens as a normal page — editable
title, a "Start typing…" row that mints the first block (B-410), references below — and
"doesn't exist yet / Create" remains only for a name nothing references (or one this device has not
heard about yet). All pages and the `[[`/`#` popup read the replica, so they include the pages once
synced; the graph, search and `page_list` read the server.

## Costs

- Every write that touches blocks does one extra indexed `ref` lookup per touched block (the fast
  path: "does any of this block's references dangle?"), and parses the block again only when one
  does.
- A link edited slowly creates and deletes a page per flush: two logged ops and a tombstone row
  each. They are hidden from the trash, but they are in the op log, in `changes` and in `page`.
- A replica that holds a page of a name can lack the tombstone of an older page of that name
  (B-443, open, older than this ADR but made common by it). Nothing live differs.
- `Task` is a page now, and so is every one-off `#tag` people wrote. That is Logseq's behaviour and
  the owner's request; All pages gets longer (953 → 1,212 live pages on the graph copy).
- A name referenced only from an offline device's unsynced edits does not exist on other devices
  until that device syncs — correct, but it means "doesn't exist yet / Create" can still appear.

## Tests

- `packages/server/src/ref-pages.test.ts` (21): every reference kind, ancestors, casing, no journal
  days, alias rules, junk from a character-by-character edit and a slow `#tag`, removal cascades,
  no tombstone revival, deleted-page names, claims, writing that arrives after the junk deletion
  (B-445, 4); `verifyRebuildParity` in each.
- `packages/server/src/ops/ref-pages.http.test.ts` (10): `block.update` adding `[[Agent Made Page]]`
  shows in `page.list`/`page.read`/`search`; `page.create` claims; trash stays empty; `batch.undo`;
  `trash.restore`, `page.update` rename and `batch.undo` of a delete push an unclaimed page aside.
- `packages/server/src/mcp/server.test.ts`: `block_update` link → `page_list`/`page_read`;
  `packages/server/src/data-api.test.ts`: `ctx.data.pages.create` claims.
- `packages/server/src/ref-pages-migration.test.ts` (4): migration, dating by earliest reference
  (B-446), import order, import into a graph that already references the file's page.
- `packages/server/src/mirror/live.test.ts`: no file for an empty page; removed with its last block.
- `apps/web/src/sync/e2e.test.ts` (5): the race, push-first and pull-first; and its false positive —
  a device's accepted page of a name whose older page the server deleted stays put, both orders;
  and B-445 — an offline device's writing on a page whose link another device removed keeps the
  page on every replica.
- `e2e/tests/ref-pages.spec.ts` (7): the owner's scenario in a journal block; All pages, graph,
  search, `[[` popup; no junk from a slow link edit; removal vs a page typed into; the two-device
  race in two browser contexts; typing that carries on while that race is repaired; an offline
  device's writing on a page whose link another device removed (B-445).
