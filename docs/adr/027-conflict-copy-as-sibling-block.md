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
  other device's arrives (see `docs/progress/b642.md`, "Found in passing"). **Superseded by the
  amendment below (B-652):** that dependence silently lost text, and detection no longer has it.

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

## Amendment 1 (2026-10-04, B-652): detection no longer depends on which response lands first

### Context

Detection ran only in `SyncClient.pull()`, and only against this device's `block.text` rows still
in `pending_op`. A push response deletes them. `worker-core.ts` starts push and pull together on
`online`/`resume`/`visible` (and `connectLive`'s `onOpen` does too), so whenever the push response
was applied first, the other device's edit, pulled a moment later, met nothing: plain LWW, one text
gone, no copy, no trace outside the op log. Proven, not suspected: `apps/web/src/sync/e2e.test.ts`
"… whichever response a reconnecting device gets first (B-652)" holds each response until the test
releases it. On `59aa77b`, 11 of 15 scenarios lost a text — every push-response-first case,
whichever device's text won LWW and whichever device came back first, three devices, and two
devices that were both *online* and each pushed before pulling (no reconnect needed).

The server sees both ops but cannot tell them apart from sequential edits: a `block.text` payload
is `{ content }` only, and `serverApplyOps` → core `applyOps` is per-field LWW — the second op
either overwrites (`applied`) or loses (`noop`), silently either way.

### Decision

The client keeps what detection needs until its own pull has gone past it.

1. `applyPushResponse` moves each accepted `block.text` (with a base) from `pending_op` to a new
   client-only table `sent_text`, with the `seq` the server gave it — unless a pull already passed
   that `seq`. A pull drops a row when the op comes back, or once `server_cursor >= seq` (a `noop`
   never comes back). Created `IF NOT EXISTS` on every open; no migration.
2. Detection walks a pulled batch in the server's `seq` order. A foreign `block.text` meets this
   device's "unseen" text: `pending_op` and `sent_text` rows newer than the newest op of ours seen
   so far in the batch. An op of ours appearing in the batch means everything after it was written
   by a device that may have seen it (and everything of ours older than it was pushed earlier, HLC
   order) — so exactly one device detects a given conflict: the one whose op is later in the log.
3. Merge base = the base of the OLDEST unseen row (the text before this device diverged), not the
   newest row's. The newest row's base is an earlier local edit the other device never saw; merging
   against it quietly reverted that earlier edit wherever the other device touched nearby (found in
   passing, reproduced: "two local edits of one block before the other device's edit arrives").
4. A merge op keeps that base in `pending_op` (it was NULL, which made the block look base-less, so
   the next foreign edit won by LWW over the merge); a clean merge is this device's text for the
   rest of the batch, so a third device's edit merges into it.
5. When the base fails to merge, `mergeBase` tries an ancestor the incoming edit certainly or
   verifiably descends from: its author's previous text, or a text it contains (a third device's
   or an older one of ours, from the batch or this replica's op log) — and only if `mine` already
   contains everything that ancestor's author has written. Otherwise a merge op carrying a stale
   word (another device's first edit, since changed again) read as a conflict: 477 of 2000 random
   merge-mode schedules made a spurious copy before this, 0 after. A third device's *newer* text
   is not a safe ancestor — the merge is clean and silently reverts that device's word
   (`tools/probes/b652-merge-base.ts`); the containment check excludes it.

ADR 027's server side is unchanged: clients still report `conflict_copy`, the server mints the
block. Since only one device now detects a given conflict, the derived-id dedup matters mainly for
clients built before this change.

### Alternatives

- **Server-side detection** (the server sees every op). Without a base it can catch only half: an
  incoming `block.text` that *loses* LWW was certainly concurrent (its author's clock would be past
  the winner had it seen it), but one that *wins* looks exactly like an edit made after seeing the
  current text. Catching that needs the edit's parent (e.g. the `content_hlc` it was written on) in
  the push — a wire change old clients never send, so "works for old clients" holds for half the
  cases. It would also make two detectors (old clients still merge on pull) racing to mint merge
  ops, and a server-side merge needs base *text* from an op log that GC trims. Rejected for now;
  the client fix covers both halves for every updated client. Worth revisiting only if a client we
  cannot update keeps losing text.
- **Pull before push on reconnect.** Fixes reconnect only: two online devices that each push before
  pulling still lose a text (the "both online" test), and every reconnect would wait a round trip
  longer to push.
- **Keep acknowledged rows in `pending_op` with an `acked_seq` flag.** Same mechanism, but every
  reader of the outbox (`flush`, the pending count the indicator shows, refused-page cleanup) would
  have to learn to skip them; a separate table keeps `pending_op` meaning "not yet pushed".

### Costs

- One small row per pushed `block.text` until the next pull passes it (normally milliseconds).
- A pull with a candidate conflict reads up to 20 recent `block.text`s of that block from the local
  op log and runs a few extra word-diff3s. Only when this device has unseen text on that block.
- Still a heuristic for clean merges: a merge three or more devices deep can, in shapes the tests
  did not generate, fall back to a conflict copy (fail closed — no text lost).

### Verification

- `apps/web/src/sync/e2e.test.ts` "… whichever response a reconnecting device gets first (B-652)":
  15 fixed scenarios (2 response orders × 2 server orders × who wins LWW; both offline either order;
  both online; three devices in four orders) + three-device clean merges + two local edits; and
  seeded random schedules (2–3 devices, random clock offsets, 1–2 edits each, random flush / pull /
  reconnect with random request and response order) in a conflict mode (every device's last text
  on the page) and a merge mode (one text with every device's last word, no copy). 120 seeds per
  mode by default; 5000 per mode passed. 20 of these fail on `59aa77b`.
- `apps/web/src/sync/sync-client.test.ts`: `sent_text` kept on push, merged against, dropped when
  pulled back / when the cursor passes a noop / never written when a pull already passed it.
