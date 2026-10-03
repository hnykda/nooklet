# 003 — Two devices that each started their own graph, and now want to sync

Proposal, 2026-09-14, against the tree this session left (`docs/BUGS.md` B-563/B-566/B-569, the
Capacitor iOS work). Status: **decided, 2026-09-15 — see ADR 025.** The specific question this
proposal asked (merging two *already independently populated* graphs) is still rejected, for the
reason Option B below gives. What's decided is the surrounding shape: ADR 025 makes "a device can
hold more than one graph, and a server can host more than one graph" real, which turns this
proposal's actual scenario (B-563 making "just this device" a normal first choice, then wanting to
add a server later) into two of ADR 025's ordinary, non-destructive moves — "promote a local-only
graph to a new (empty) remote graph," or "add an existing remote graph as a new list entry" — rather
than something that has to overwrite what a device already had. Kept below as the record of why the
general merge case (Option B) stays out of scope.

The scenario the owner named directly: start using the desktop app standalone (it spawns its own
`nooklet serve`, is its own canonical graph, per `docs/progress/desktop-remote-mode.md`). Separately,
start using the iOS app in "Just this device" mode (B-563) — also its own, entirely independent
local replica, never connected to anything. Now point one at the other, or both at a shared home
server. **One of the two graphs' content has no path into the result.**

---

## 1. Why this isn't a bug to fix, it's the confirmed v1 design meeting a new use case

`docs/PLAN.md` §17 point 7: *"Multi-graph: one graph per server in v1. Confirmed."* The whole sync
model (ADR 003) is one canonical op log per server, N client replicas of *that* log. There is no
server-to-server merge, and there was never meant to be one — every device was assumed to be a
*client* of one already-existing canonical graph from the start.

What changed this session: B-563 made "don't connect to any server" a first-class, encouraged choice
on literally the first screen a new device shows, and the desktop app already defaulted to
"standalone, own graph" from the start. Both are now normal, expected starting points — not edge
cases — so "I started two of these independently and want them to become one" is now a mainline
scenario, not a misuse.

## 2. What actually happens today if you try

Point device B at device A's server (or a shared home server that only has A's data): B's `Connect
this device` flow (`ConnectView.tsx`) only ever *joins* an existing graph as a replica. There is no
step that offers "bring what's already on this device along." B's local content — everything typed
before connecting — sits in that origin's own OPFS storage, orphaned; the app now shows A's graph.
Nothing is silently deleted (different storage origin, per B-563's own design note), but there is no
UI path to recover or merge it either. This is the "overwritten" the owner described: not data loss
at the byte level, but functional loss — no way back in through the app.

## 3. Option shapes (not a decision)

### A. One-time import via the existing markdown mirror

The server already writes a lossless, greppable markdown mirror (ADR 002) and `nooklet import`
already reads a Logseq-shaped file tree. B's standalone graph, before joining A, could export its
own mirror and `nooklet import` it into A's data dir (or a fresh graph — see D) as a second pass,
same mechanism already trusted for bringing in a whole Logseq vault. Cheapest to build (arguably
close to "already exists," just needs a client-side "export this device's mirror" step and a
documented manual step, or a wizard around the same two CLI-shaped operations) but manual, one-time,
and duplicative if run twice — no ongoing merge semantics, and page-id collisions between the two
independently-generated graphs (two different journals both claiming `2026-09-14`, unrelated pages
that happen to share a name) need a real answer, likely "import renames on collision, user
reconciles by hand," which is honest but not seamless.

### B. True op-log merge of two independently-started histories

Treat B's local op log as a second history to splice into A's, the way two devices that were always
part of the same graph already reconcile (HLC ordering, last-writer-wins fields, fractional-index
siblings). Rejected as a default answer, not attempted: two graphs that never shared a common
ancestor will collide on identity, not just content — the same journal date, the same page name, the
same short id space, minted independently on each side with no coordination. ADR 004's short ids are
time-ordered but not globally coordinated across two graphs that never talked; a genuine merge needs
an identity-reconciliation pass first (which ids/pages "are the same thing" on both sides is a
judgment call, not always inferable), which is a materially harder problem than the multi-device sync
this app already does well. Worth real design time only if this scenario turns out to be common
enough to deserve first-class support, not a first cut.

### C. Prevent it, don't solve it: make the choice screen honest about the cost

Cheapest option of all: change B-563's copy (`ConnectView.tsx`'s choice screen) to say plainly that
choosing "Just this device" now and connecting to a server later does not bring this device's notes
along — so the decision is informed, not solved. Punts the actual problem; reasonable as a stopgap
if A/B are not both implemented soon, since it at least stops the surprise. Does not help someone who
already has two independently-started graphs today (which, per the owner's message, may already be
true here).

### D. Real multi-graph hosting

The actual generalization: a server can host more than one graph, and "sync this device in as a
new graph" (rather than forcing it to join the one existing graph) becomes a real, first-class
operation. This is the biggest option — it reopens PLAN.md §17.7's confirmed decision, not just a
client-side feature — but it's also what makes option A's "which graph does the import even target"
question disappear (answer: a new one, cleanly), and it's the only option that doesn't ask the user
to accept some form of manual reconciliation or data loss. Out of scope for a quick fix; flagged here
because A and C's costs are easier to weigh against this as the "do it properly" alternative once
someone decides how much this scenario actually matters.

**Decided, 2026-09-15: this is the one.** See ADR 025 — a server hosts N graphs routed by
`/g/:graphId/`, one SQLite file per graph (not one shared file filtered by `graph_id`, despite the
column already existing on state tables for it — the ADR explains why that path was rejected: the
unique indexes and the op/token tables were never actually scoped for it). A client holds a list of
graphs instead of one slot.

## 4. Related

- `docs/BUGS.md` B-573 (this session): local-only storage has no eviction backstop — the same root
  cause (local-only was added as a UX choice without revisiting durability/architecture assumptions
  built for "there's always exactly one canonical graph and everyone is already a client of it").
- ADR 002 (markdown mirror), ADR 003 (sync), ADR 004 (ids), PLAN.md §17.7 (multi-graph, confirmed
  out of v1 scope) are the decisions any of A/B/D would need to revisit or build on top of.
