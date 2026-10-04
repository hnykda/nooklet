# ADR 026: Ops read out of the server's log are applied in `seq` order, not re-sorted by HLC

Date: 2026-10-03. Status: accepted. Narrows ADR 003's "HLC order is the canonical order" to the
case with no arbiter; implements what `docs/spec/sql-schema.md` rule 26 already said for
`rebuild()` ("replaying in `seq` order").

## Context

B-587. `apps/web/src/sync/e2e.test.ts` failed 3 runs in 8: `verifyRebuildParity` reported device
A's page and block `missing-in-rebuild`. The op log showed the server's `refpages` `page.delete`
of "Ghost Name" at seq 5 with HLC `…:09.838Z-0002-00000000`, and A's own `page.create` of "Ghost
Name" at seq 6 with HLC `…:09.838Z-0000-562db010` — minted in the same millisecond, before A had
heard of seq 5. The server applied them in `seq` order: the name was free, A's page landed. Core
`applyOps` sorts every batch by HLC, so a replay applies A's create while the old page is still
live and rejects it (`page-key-collision`).

The open question was whether only `verify` was wrong or a replica too. Settled by a deterministic
test (the same test file, "… converges on every replica (B-587)"): A's clock 5 s behind (ADR 003
rejects only clocks running *ahead*, so this is a legal device), real server, real `SyncClient`s.
On `f55e3b0`:

- **C** (bootstrapped before the delete, then one incremental pull carrying the delete and A's
  ops) **diverged**: A's page and block missing, no live "Ghost Name" at all — for good, nothing
  ever re-sends them.
- **D** (one pull of the whole log) **diverged** more mildly: with a 5 s lag A's create sorts
  before even the old page's create, so D holds A's page and block but not the old page's
  tombstone (that create met A's live page and was refused). With the same-millisecond shape of
  the original failure — A's HLC between the old page's create and delete — a full pull loses A's
  page the way C does (`tools/probes/b587-hlc-order-name-collision.ts`).
- A, B (live: learns each op from its own push response or a pull of one push) and E (snapshot
  afterwards) matched the server.

So a device that comes back from being offline, or a fresh install that pulls instead of
bootstrapping, silently loses another device's page. This is exactly the shape of a
three-device setup (Mac, own server, iPhone) where one device lags or is offline while the other
two exchange a link.

## Decision

`applyOps(driver, ops, { order: "seq" })` applies a batch as given; the caller promises it is the
server's `seq` order. Every batch that comes out of the server's op log uses it:

- `SyncClient.pull()` (`/sync/pull` already serves `ORDER BY seq`; the client's text-merge ops are
  newest and appended last, as before);
- `SyncClient.applyPushResponse()` — a push response's corrections, in the order the server
  applied them;
- `verifyRebuildParity` (`nooklet verify`), which already loaded the log `ORDER BY seq`.

The default stays `"hlc"`: a device applying its own ops (already HLC-increasing) and the
serverless property tests (`packages/core/src/sync/sync.property.test.ts`), where there is no
arbiter and HLC order is the only order every device can agree on without coordination.

Why this is exact, not a heuristic: `serverApplyOps` calls core `applyOps` on each push (HLC-sorted
within that one batch), and core inserts each op's `op` row in the order it applied them, so `seq`
order *is* the server's order of application, push boundaries included. A replica applying the
applied ops in `seq` order makes the same `applyOne` calls on the same state the server did. LWW
fields never cared about order; the checks that do — page-name collisions (create, rename,
un-delete), the cycle check, `resolvePlace`'s parent fallback — now meet the state the server's
check met.

## Alternatives rejected

**1. The server re-stamps an op whose HLC is behind ops it already applied on the same name.**
An op's id *is* its HLC (ADR 004), and the pushing device already holds it under that id: the
server cannot change the HLC of A's `page.create` without minting a different op. So "re-stamp"
means rejecting A's create and logging a server `page.create` for the same entity with a fresh
HLC. Costs: (a) every op A built on that page — its `block.create`s, minted with A's older clock —
now sorts *before* the page exists on any HLC-ordered replay and is rejected `no-such-page`, so
the re-stamp has to cascade to every dependent op, which is ADR 024 §7's rejected "rewrite late
ops" with all its problems; (b) A's replica holds `name_hlc` = A's HLC while everyone else holds
the server's, a permanent column-level divergence unless A is also told to rewrite its row;
(c) "on the same name" is not the whole hazard — a cycle check or a parent fallback can flip the
same way, and each would need its own re-stamp rule.

**2. The server rejects such an op.** The name was free on the server: refusing A's page would
throw away a legitimate write, and the `refused_pages` machinery (ADR 024 §7) has no winner page
to hand A. It trades a convergence bug for a lost write.

**3. Make name ownership order-independent** (e.g. the smaller HLC always owns the name, the
loser is renamed or evicted). Changes what users see after every race, needs a rename/evict op
that every device derives identically, and still leaves the cycle check order-dependent. Far larger
than the bug.

**4. Fix only `verify`.** Would have hidden the alarm and kept the divergence on C and D.

## Consequences

- The client's pull and verify now depend on `/sync/pull` and the `op` table returning `seq` order
  (they always did; `pagesDisplacedByPull` in `apps/web/src/sync/refused-page.ts` already relied
  on "pulled ops are in server order").
- ADR 024 §7 rejected "the server rewrites A's late ops onto its page" partly because verify
  replayed in HLC order. That premise no longer holds; the decision stands on its other costs
  (rewriting another device's ops, B-442), and is not reopened here.
- Not fixed by this: B-443 — a replica that created a page of a name can still lack the tombstone
  of an older page of that name (its pulled `page.create` meets the replica's own live page). Live
  state is identical; tombstone rows differ. Device A in the B-587 test shows exactly that.

## Tests

- `apps/web/src/sync/e2e.test.ts` "a page created under a name the server freed, with an HLC
  older than the freeing op, converges on every replica (B-587)" — five replicas, failed with
  `[ 'C', 'D' ]` diverged before the fix.
- `packages/server/src/sync/convergence.property.test.ts` — fast-check, 150 runs: three authoring
  devices with clocks 0–5 s behind, reference pages minted and deleted by the server, pull-only
  replicas pulling in pages of 1–50 plus a fresh one pulling everything at once; all must equal the
  server and `verify` must be clean. With `seq` disabled it fails (shrunk counterexample: two
  devices create "Alpha", one deletes and another renames — no clock lag needed).
- `packages/core/src/sync/apply-ops.test.ts` `order: "seq"` — the B-587 log applied both ways.
