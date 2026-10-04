---
title: How it works
description: SQLite on every device, an append-only op log with hybrid logical clocks, last-writer-wins fields, fractional ordering, and a markdown mirror.
order: 3
---

# How it works

nooklet has three parts: a server written in TypeScript on Node, a client that runs in a browser
(and inside the desktop and iOS apps), and a shared core library both of them use. The design
decisions, with the alternatives they beat, are in [docs/adr](../adr/).

## SQLite everywhere

The server keeps each graph in one SQLite file (`graphs/<id>/graph.sqlite`). Every client keeps its
own SQLite copy of the graph: the browser runs SQLite compiled to WebAssembly inside a worker and
stores the file in the origin-private file system (OPFS).

Both sides use the same schema and the same `applyOps` function from `packages/core`. When you
type, the client writes to its local database first. The screen never waits for the network.

The server also holds things clients do not: tokens, the audit log, embeddings, assets and the
markdown mirror.

## Every write is an op

Every change, whether it comes from the editor, an agent over MCP, the HTTP API or an import,
becomes a list of small **ops**: `page.create`, `page.rename`, `page.prop`, `page.delete`,
`block.create`, `block.place`, `block.text`, `block.prop`, `block.delete`. Each op targets one
entity and one field.

The server appends every op it accepts to a log, numbered by `seq`. The tables you read from
(`page`, `block`, their properties) are a pure function of that log. `nooklet verify` proves it on
your data: it replays the whole log into a scratch database and diffs the result against live
state, row by row.

## Hybrid logical clocks

Each op carries a **hybrid logical clock** (HLC) stamp: wall-clock milliseconds, a counter for
events in the same millisecond, and the device id. HLC stamps sort in a total order that respects
cause and effect, even when device clocks disagree by a little.

The server refuses a push from a device whose clock runs more than 60 seconds ahead of its own. A
clock that far ahead would win every conflict for as long as it stayed ahead. The device shows an
error until you fix its clock.

## Last-writer-wins, per field

Each field of each block is its own register. When two devices change the same field, the op with
the later HLC wins on every device. Different fields never conflict: you can retitle a block on
your phone while your laptop moves it, and both changes survive.

A block's position (page, parent, order) is one field, so a move happens in one piece.

Text gets one extra step. If a device pulls a text change for a block it has also edited and not
yet pushed, it runs a three-way merge against the text both edits started from. Edits to different
parts of the block combine. If the edits overlap, the later one wins and the device keeps the other
text in a `conflict_copy` property on the block, so nothing disappears. (That presentation is
being replaced with something easier to read.)

```animation-spec
title: Two devices edit offline and converge
actors:
  - Laptop (left), showing a block "Buy milk"
  - Server (centre), showing its op log as a vertical list
  - Phone (right), showing the same block "Buy milk"
steps:
  1. Both devices show a "wifi off" badge. The connection lines to the server fade out.
  2. On the laptop the text changes to "Buy oat milk". An op card "block.text, HLC 10:00:05" appears in the laptop's outbox.
  3. On the phone the block gets a property "scheduled:: 2026-10-05". An op card "block.prop, HLC 10:00:09" appears in the phone's outbox.
  4. The laptop reconnects. Its op card flies to the server and lands in the log as seq 41. The server sends a small "poke" pulse to the phone, which is still offline, and the pulse stops at the gap.
  5. The phone reconnects. Its op card flies to the server and lands as seq 42. The phone then pulls seq 41 and the laptop pulls seq 42 (two cards fly outward).
  6. Both devices now show "Buy oat milk" with "scheduled:: 2026-10-05". The two changes touched different fields, so both survive.
end_state: Laptop, server and phone show the same block with both edits. Server log holds seq 41 and 42.
```

## Sibling order: fractional indexing

Order among siblings is a short string key, not a linked list. To put a block between keys `a0`
and `a1`, a device mints a key that sorts between them, such as `a0V`. Moving a block changes only
that block's key, so two devices reordering different blocks never collide. Equal keys tie-break
on block id.

## The server checks structure

Some combinations of valid ops make an invalid tree. Two devices, offline, can move block A under
B and block B under A. Each move is fine alone; together they make a cycle.

The server applies pushed ops in arrival order and rejects any move that would create a cycle in
its own state. When it rejects one, it emits a **corrective op** with a fresh HLC that puts the
block somewhere valid, and every device applies it on the next pull. While the correction is in
flight, a device may show the block under an "Unplaced" heading for one round trip.

The same applies to names: if a device creates a page under a name another device took first, the
server decides, and the losing device learns the outcome from its next pull.

## Devices apply the server's log in `seq` order

Devices sort their own fresh ops by HLC. Ops that come **out of the server's log** they apply in
the server's `seq` order, the same order the server applied them in ([ADR 026](../adr/026-server-log-applied-in-seq-order.md)).

This matters for the checks that depend on order, such as a page name that was freed and then
reused. Suppose device A's clock runs a few seconds behind, and A creates a page "Ideas" right
after the server deleted an older "Ideas". Sorted by HLC, A's create would come before the delete
and collide with the old page. Applied in `seq` order, every device meets the same state the
server met, and they all end with A's page. A property test with three devices, lagging clocks and
replicas pulling in random page sizes checks this.

```animation-spec
title: One op travels from device to server to another device
actors:
  - Phone (left) with a local SQLite cylinder and an "outbox" tray
  - Server (centre) with a SQLite cylinder and an op log list
  - Laptop (right) with a local SQLite cylinder
steps:
  1. A finger types "Call the plumber" into a new block on the phone. The block appears on the phone screen at once.
  2. An op card "block.create, HLC 14:02:11.120-0000-phone" drops into the phone's SQLite cylinder and a copy into the outbox tray, in one motion (one transaction).
  3. After a short pause (300 ms label) the outbox card flies along the line to the server labelled "POST /sync/push".
  4. The server checks the card (a small tick: "tree valid"), writes it into its SQLite cylinder, and appends it to the op log as "seq 128".
  5. The server sends back an acknowledgement to the phone; the phone's outbox tray empties.
  6. The server sends a small "poke" pulse over the laptop's WebSocket line.
  7. The laptop answers with "GET /sync/pull?since=127". The seq 128 card flies to the laptop and drops into its SQLite cylinder.
  8. "Call the plumber" appears on the laptop screen.
end_state: All three cylinders hold the op. The server log ends at seq 128; both devices' cursors read 128.
```

## The sync protocol

- `POST /sync/push`: a device sends its queued ops. The server validates, applies, logs, and returns
  any corrections.
- `GET /sync/pull?since=<seq>`: a device fetches ops after its cursor, in `seq` order.
- `GET /sync/snapshot`: a new device downloads the current state instead of the whole history.
- `/sync/live`: a WebSocket that only carries "something changed" pokes. Data still moves through
  push and pull, so a dropped socket costs latency, not correctness.

A device writes an edit and its outbox entry in the same SQLite transaction. A crash between typing
and syncing loses nothing.

Every graph lives under its own prefix, `/g/<graph-id>/`, so the paths above are
`/g/<graph-id>/sync/push` and so on. One server process hosts many graphs, each with its own file,
log and tokens.

## The markdown mirror

The server writes each page to `graphs/<id>/pages/<Page name>.md` and each journal day to
`graphs/<id>/journals/`, a moment after it changes. The format is an outline Logseq and Obsidian can
read:

```markdown
type:: project

- TODO Read the ADR on sync ^1m433dkhgaxame
  - started on the HLC part ^1m433dkhgaxamf
```

The ` ^id` suffix is the block's stable id, in Obsidian's block-id syntax. Agents see the same
format when they read a page.

The mirror is one-way: nooklet writes the files and does not watch them. Edit through the app or
the API; an edit made in the file will be overwritten the next time that page changes. Delete
`pages/` and `journals/` and the server rewrites them. Turn the mirror off with
`nooklet serve --no-mirror`.

```animation-spec
title: The database is the truth; the files are a copy
actors:
  - Server SQLite cylinder (centre)
  - A folder icon "pages/" (right) holding "Reading list.md"
  - A grep magnifying glass and a git branch icon (far right)
steps:
  1. An op card "block.text" lands in the SQLite cylinder.
  2. After a short delay, a page icon slides out of the cylinder into the folder and replaces "Reading list.md". The file's text updates; each line ends with a grey "^id" tag.
  3. The magnifying glass passes over the folder and highlights a line. The git icon draws a commit dot.
  4. A pencil edits the file directly. A faint arrow tries to go from the file back to the cylinder and stops with a "not watched" label.
  5. Another op card lands in the cylinder; the file is rewritten from the database and the pencil's edit disappears.
end_state: The folder mirrors the database. Arrows only point from the cylinder to the folder.
```

## Search and embeddings

Every replica has a full-text index, so search works on the device. The server keeps a second index
with a trigram twin for substring matches, and optionally block embeddings in `sqlite-vec`. A block
is embedded with its breadcrumb (page and ancestors) and a little of its children, so a short
bullet like "call him back" still carries its context.

Hybrid search fuses keyword and vector results by reciprocal rank fusion in one SQL statement.
Embeddings never sync to devices; devices ask the server.

## Where to read more

- [ADR 002](../adr/002-storage-sqlite-truth-markdown-mirror.md): SQLite is the truth, markdown is a mirror
- [ADR 003](../adr/003-sync-oplog-hlc-lww.md): op log, HLC, last-writer-wins, server validation
- [ADR 004](../adr/004-ids-and-ordering.md): short ids and fractional ordering
- [ADR 025](../adr/025-multi-graph-hosting.md): one server, many graphs
- [ADR 026](../adr/026-server-log-applied-in-seq-order.md): applying the log in `seq` order
- [docs/spec/sql-schema.md](../spec/sql-schema.md): the schema
