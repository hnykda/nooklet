# ADR 027: The losing text of a same-block conflict becomes a sibling block, minted by the server

Date: 2026-10-04. Status: accepted. Amends ADR 003's Consequences (the v1.1 text merge) and
research/03-sync.md §6.4's "add a `props.conflict_copy` with the loser".

## Context

B-642, the owner's first real-device test: one block rewritten on the Mac and on the iPhone (one
offline). Both sides replaced the whole text, so the 3-way merge rightly failed, and the losing
text ended as a `conflict_copy:: There is this` property chip under the winner ("Nothing"). The
owner: "shouldn't it be smarter than that, and e.g. added that as extra line or something".

How conflicts worked until now (read from code, `c3302f6`):

- The merge runs only on a client, in `SyncClient.pull()` → `resolveTextConflicts` →
  `@nooklet/core`'s `resolvePendingTextConflict`. Trigger: a pulled `block.text` for a block that
  still has this device's own `block.text` in `pending_op`.
- Base: `pending_op.base`, the block's content just before the local edit (captured in
  `applyLocal`). `merge3` is a word-token diff3: disjoint hunks merge into a new `block.text` with a
  newer HLC; overlapping hunks fail closed.
- On failure LWW keeps the newer text and the client writes `block.prop conflict_copy = <loser>`.
- Both devices can take that branch for the same conflict (each has the other's op arrive while its
  own is still pending — e.g. a push whose response was lost). For a keyed property that was
  harmless: same key, same value.

## Decision

1. Clients are unchanged: on a failed merge they still push `conflict_copy = <loser text>`. It is
   now a *report*.
2. `serverApplyOps` (`packages/server/src/conflict-copy.ts#planConflictCopies`), for a `sync`
   push only, turns every non-rejected `block.prop conflict_copy` into server-authored ops in the
   same transaction:
   - `block.create` of a block holding the loser text, in the winner's parent, ordered directly
     after the winner and before every sibling that follows it, with the property
     `sync-conflict:: true`;
   - `block.prop conflict_copy = null` on the winner.
   They are corrections like the cycle and subtree repairs: logged (so `verify` replays them),
   recorded in `changes`, returned to the pusher, pulled by everyone else in `seq` order (ADR 026).
3. The new block's id is derived: 70 bits of sha256(winner id, NUL, loser text), in ADR 004's
   14-character alphabet. If that block already exists — live or deleted — no create is minted.
   That is what makes the second device's report of the same conflict a no-op, and keeps a copy
   the person already deleted from coming back.
4. Texts materialised per named block: each report's own value even when the report lost LWW
   (`noop`: an earlier report's clear is newer — its text exists nowhere else), plus the property's
   value before the batch and after it, so neither the report's overwrite nor the clear discards
   text. A text equal to the winner's current text is skipped.
5. The client renders `sync-conflict` as a small warm "sync conflict" badge
   (`BlockProperties.tsx`), with a tooltip saying what happened and what to do. It is an ordinary
   property: the badge goes when the line is deleted in the editor.
6. **No migration.** Existing `conflict_copy::` properties stay exactly as they are: they are
   already visible as a chip, the person may have acted on them, and rewriting user data on
   upgrade without being asked is the wrong default. A block that conflicts again carries its old
   value along (point 4). Anyone who wants the old ones as blocks can find them with
   the query `prop:conflict_copy` and move the text by hand.

## Alternatives

- **(b) Append the loser to the winner as an extra line.** Rejected: it silently changes the
  winner's text — the one thing every other device just agreed on — mixes two versions into one
  block where neither can be deleted alone, and a third device's next edit then merges against a
  text nobody wrote. It also breaks the "a block is one thought" shape of an outline: a task
  marker, a heading or a property line in the first line of the winner now governs both.
- **Client mints the sibling block with a derived id.** Rejected: both devices can detect the
  same conflict, and core's `block.create` is `INSERT OR IGNORE`. Each device computes the order
  key from its own replica and stamps `content_hlc` with its own HLC; a replica keeps whichever
  create it saw first (its own), the server keeps the earlier `seq`. Same id, different place and
  clock — the replicas would diverge, and nothing would ever repair it.
- **Client mints it with a random id.** Two copies whenever both devices notice.
- **A new op kind (`block.conflict`) instead of reusing the property.** Cleaner on the wire, but
  every client built before this change — including the owner's iPhone build — would keep writing
  `conflict_copy` and never benefit, and it adds a kind to the `defineOp`/OpenAPI/MCP surface for a
  server-internal concern. Reusing the property upgrades every client at once.
- **Obsidian Sync's conflict file** (since 1.9.7, optional: "creates a separate conflict file
  instead of merging automatically", named `original-note-name (Conflicted copy device-name
  YYYYMMDDHHMM).md`; markdown otherwise merges with diff-match-patch —
  https://obsidian.md/help/sync/troubleshoot, fetched 2026-10-04). Same idea one level up: keep the
  winner untouched, put the other version next to it, let the person reconcile. A block is
  nooklet's unit as a file is Obsidian's, so (a) is the analogue. Device name and time in the
  marker were considered; the server does not know the losing device (the report is minted by
  whichever device noticed), and a date in the value would make the badge noisier for little gain.

## Costs

- `conflict_copy` is now a reserved-in-practice key for sync writes: a person typing
  `conflict_copy:: x` into a block in the editor gets a new block with `x` instead of the property.
  API and MCP writes (origin other than `sync`) keep the plain property.
- The pushing device shows the `conflict_copy` chip for one push round trip (≈300 ms debounce +
  request) before the correction arrives. Not hidden client-side: that would be a second rule for
  the same property.
- A block id is no longer always time-prefixed. Nothing reads time out of ids (`idTime` has no
  caller outside its tests); ordering ties on id remain deterministic.
- If the person deletes the copy and *later* the same block conflicts again with the identical
  losing text, no copy is made — the derived id is taken. The text is still in the op log.
- A report naming a deleted winner still makes a copy beside the tombstone, where it is as hidden
  as the winner. Rare (the merge ran against a live block moments earlier), accepted.
- Conflict *detection* is unchanged and still needs the device's own edit to be pending when the
  other device's arrives (see `docs/progress/b642.md`, "Found in passing").

## Verification

- `packages/server/src/conflict-copy.test.ts`: placement, nesting, duplicate report, deleted copy
  not resurrected, stale report kept, pre-existing value carried, API write untouched; each checks
  a fresh replica reading the log in `seq` order equals the server and `verify` is clean.
- `packages/server/src/sync/convergence.property.test.ts`: a `conflictReport` action in the
  random interleavings; replicas converge and no `conflict_copy` survives.
- `apps/web/src/sync/e2e.test.ts` "B-642": real `SyncClient`s and server; one device offline; and
  both devices reporting the same conflict → one copy.
- `e2e/tests/sync-conflict.spec.ts`: two browser contexts, one offline, both show the winner, the
  copy with the badge, and no `conflict_copy` chip.
