# 15 — Collaboration and sharing: read-only links, graph membership, co-editing, presence, hosting for friends

Dated record, 2026-09-12. Like the other files in `docs/research/`, this is kept as written rather
than updated in place. No ADR follows from it yet; §8 says what one would decide. Working tree at
commit `d24ce73` plus six agents' uncommitted M7 work; nothing in this document depends on the
uncommitted parts.

**Read `research/11-e2ee-sync.md` and `research/12-multi-user-and-pairing.md` first.** They settled
two things this document does not reopen: hosted multi-user was parked ("stay single-user, spend the
effort on pairing", 12 §2), and end-to-end encryption was parked for the owner's own graph and
declared *only* defensible for other people's graphs if the client is a signed native build, not the
PWA the relay serves (11 §9.4). This document takes both verdicts as given and answers the six
questions the owner asked *on top of* them: what sharing and collaboration could look like, what each
option costs against the code as it stands, and what to do first.

Method note. The web-search budget for this session was exhausted before this task started, so every
external claim below comes from a **direct fetch of a primary URL** (project docs, GitHub via `gh api`,
the npm registry), or from an earlier research file that measured it, and is cited as such. Where a
page could not be fetched, §9 says so rather than guessing.

---

## 0. TL;DR

1. **Presence is nearly free and is the single most useful collaboration feature for the merge model
   nooklet already has.** The `/ui/live` socket (ADR 015) already carries `page` and `focused` per
   window and re-sends `hello` on every change; adding a block id and fanning it out to other windows
   is ~300 lines. Every real system separates presence from the document path (Yjs awareness,
   Loro's `EphemeralStore`, any-sync's stateless pub/sub, Figma) — it is a broadcast, not a merge.
2. **Character-level co-editing is not worth a CRDT here.** The existing word-token 3-way merge
   (`text-merge.ts`) already keeps both edits when they touch different spans; with presence showing
   "Dan is in this block", the overlapping case becomes rare *and visible*. If live typing-together is
   ever wanted, CodeMirror's own `@codemirror/collab` (OT with a central authority — exactly nooklet's
   server-as-arbiter model, 24 KB, no WASM) fits better than any CRDT, and can be scoped to "while two
   people are in the same block", leaving the op log untouched.
3. **Read-only sharing should be a server-side `share` row and a capability URL, not a page
   property.** `/s/<id>` renders HTML from the outline the server already produces for `page_read`;
   no client app, no API token, per-page or whole-graph, revocable. This is the same shape as Notion's
   public link and Tana Outliner's "turn any node into a public web page", and it is where the sibling
   "publish" research meets this one (§2.4).
4. **Graph membership changes less than expected.** LWW, HLC, fractional order, cycle rejection and
   corrective ops all survive untouched. `Op` needs no `user_id` — attribution goes through
   `device → user`, and `changes.actor` already carries a human label. The one genuinely new mechanism
   is that a *forbidden* op must be answered the way a cycle is today: rejected plus a corrective op
   with a newer HLC, because the client applied it optimistically. That is ADR 003's existing
   mechanism generalised, not a new one.
5. **Hosting for friends has a zero-code v0 the earlier research did not spot:** Tailscale node
   sharing gives a friend HTTPS to one machine "without exposing them to the public internet", on
   every plan, and `tailscale serve` stamps `Tailscale-User-Login` on each proxied request — identity
   without a users table. One `nooklet serve --data` process per friend on its own port is the whole
   multi-tenancy story until quotas matter.
6. **The most surprising prior-art finding:** Logseq's DB version ships real-time collaboration, and
   its shipped answer to two people editing one block is *not* a character-level merge. The client
   rebases its pending transactions over the remote ones, and when a remote write to `:block/title`
   lands on a block the local side also changed, it records a per-block **conflict** and broadcasts
   it to the UI (`worker/sync/apply_txs.cljs`, `sync-conflict-attrs #{:block/title}`). Its sync
   server is open source in the same repo (`deps/db-sync`, Cloudflare Worker plus "a Node.js adapter
   for self-hosting", last commit 2026-09-08) but its `start.sh` authenticates against AWS Cognito.
   Obsidian Sync's shared vaults (up to 20 people, no permission levels) merge with diff-match-patch.
   Two shipped multi-user outliners, and both land where nooklet already is: merge if you can,
   otherwise keep both and show it.

---

## 1. What exists today (verified by reading the tree at `d24ce73`)

The op log and its invariants, restated only as far as the questions below need them:

- **An op is `{id, hlc, device, entity, payload}`** with `id === hlc` (`packages/core/src/ops.ts`);
  `applyOps` (`packages/core/src/sync/apply-ops.ts`) is per-field LWW by HLC, HLC-sorted within a
  batch, idempotent on `op.id`, with the tree-cycle check via a recursive CTE. The server
  (`packages/server/src/apply-ops.ts`, `serverApplyOps`) is the single write path; it records one
  `changes` row per touched entity with `origin`, `actor` (the token label) and `batch_id`.
- **Client-side reconciliation already handles rejection and correction.** `apps/web/src/sync/
  sync-client.ts:251–262`: after a push, every `rejected` op is deleted from `pending_op` and every
  `corrections` op is applied through `coreApplyOps`. This is the seam a permission denial would use
  (§3.4).
- **The 3-way text merge is wired, not planned.** `sync-client.ts:459–484` (`resolveTextConflicts`)
  reads the pre-edit text from `pending_op.base` and calls `resolvePendingTextConflict`
  (`packages/core/src/sync/text-merge.ts`), a hand-rolled word/whitespace-token diff3 that either
  emits one merged `block.text` with a newer HLC or leaves LWW alone and stores the loser in a
  `conflict_copy` block property. Its own header explains why `diff-match-patch` was rejected (fuzzy
  patch placement "can silently place a hunk in the wrong spot instead of failing closed").
- **Identity is one token.** `packages/server/src/auth/tokens.ts`: `scope ∈ {read, write, admin}`
  with implication, plus two orthogonal capabilities `can_sync` (checked in `sync/auth.ts` and the
  `/sync/live` hello) and `ui_control` (ADR 015). No `user_id`, no `expires_at`. The `device` table
  (`server/src/schema.ts:183`) is advisory: `token_id` is set on first push, `acked_seq` drives GC.
- **Two live sockets, deliberately separate.** `/sync/live` (`server/src/sync/live.ts`,
  `realtime.ts`) is poke-only and keeps `Map<WSContext, deviceId>`; `/ui/live`
  (`server/src/live/registry.ts`) keeps an in-memory window registry whose `HelloInfo` already
  includes `page` and `focused`, and the client (`apps/web/src/live/socket.ts:32–34`) re-sends
  `hello` "to report a control-toggle/page/focus" change. The registry header calls it "what is on
  screen right now" and says it is "never persisted and never something `rebuild()` reproduces."
- **No read-only rendering surface exists.** The only `text/html` in `packages/server/src` is the SPA
  shell (`http/web-client.ts`); `ops/page-read.ts` renders outline Markdown (with or without `^ids`)
  or a JSON tree. `apps/web/src` has no read-only or viewer mode (grep for `readonly`/`read-only`
  returns only type modifiers).
- **`/assets/:id` is unauthenticated by design** (`http/assets.ts:5`: an `<img src>` in rendered
  Markdown has no way to carry a bearer header). Asset ids are 14-char Crockford base32 — a
  capability URL already, which is convenient for §2.
- **Changed since research/12 (2026-09-11):** the forged-`Host` credential leak (12 §1.6a) is fixed —
  `http/app.ts:86` now reads `getConnInfo(c).remote.address`; the idempotency store 12 §11.3 said was
  never built now exists (`ops/idempotency.ts`, `idempotency` table, SCHEMA_VERSION 6). **Rate
  limiting is still absent** (grep for `rateLimit`/`hono-rate-limiter` in non-test server code returns
  nothing). It matters the moment anyone but the owner can push (§3.6).
- Two constants that become visible with more people: `HLC_MAX_DRIFT_MS = 60_000`
  (`core/src/hlc.ts:18`) — a friend whose clock is a minute fast gets every push rejected with a
  message that must name the device; and `newDeviceId()` is 32 random bits (11 §11.15) — fine for one
  household, worth widening before a graph has dozens of devices.
- `graph_id` columns are inert (12 §6.1, five reasons); multi-graph is **one SQLite file per graph,
  one process per graph** (12 §6.2). Nothing below assumes otherwise.

---

## 2. Q1 — Sharing, read-only

### 2.1 The three shapes, and what each costs against the tree

| Shape | What the viewer gets | What must be built | Cost | Revocable? |
|---|---|---|---|---|
| **A. Server-rendered HTML at a capability URL** (`/s/<share-id>`) | A static-looking page (or a page tree) with the graph's rendering of links, tasks, code, images | An HTML renderer over the outline the server already builds for `page_read`; a `share` table; one Hono route; an `.md` twin (`/s/<id>.md`) for free | Small: `packages/core` already has the offset-annotated inline tokenizer (ADR 006), so rendering is a token→HTML walk. Refs to unshared pages render as plain text | Yes — delete the row |
| **B. The client app in a read-only mode** at a share URL | The real UI: collapse, zoom, search within the share, backlinks | A viewer build/route that boots without a device token or OPFS replica, fetches through a share-scoped token, hides every editing affordance, and refuses `pending_op` writes; a *resource-scoped* token kind | Medium–large: the client assumes a replica (`bootstrap.ts`, `db.worker.ts` leader election, sync client); "read-only" is a new mode across ~7k lines of platform-bound code (research/10 §7) | Yes, but the token surface is wider |
| **C. Static export** ("publish") | A folder of HTML you can host anywhere | An exporter | Scoped by the sibling agent; see §2.4 | Not after export |

Per-page vs per-graph is a property of the `share` row, not a different mechanism: `kind ∈ {page,
graph}`, optionally `include_descendants` for namespace pages (`A/B/*`). A whole-graph share is one
row whose renderer lists pages and resolves every internal link; a page share resolves links only
inside its own set and degrades the rest to text.

### 2.2 Recommendation: A, then B only if asked

Build **A**. It reuses the two things the server already has (the outline model and the tokenizer),
has no client-side state, needs no token — the URL *is* the grant — and it composes with `/assets/:id`
which is already a capability URL. It is also the shape every surveyed product ships for its
"anyone with the link" tier: Notion ("Anyone on the web with link", no account needed, and on
password protection "Unfortunately, not at the moment"
<https://www.notion.com/help/public-pages-and-web-publishing>), Tana Outliner ("Turn any node into a
public web page that anyone can view without a Tana Outliner account", read-only, password-protectable
<https://outliner.tana.inc/>), Obsidian Publish ("Select the notes you want to share with the world,
press Publish", hosted at `publish.obsidian.md/your-site`, "$8 USD Per site, per month, billed
annually", passwords and custom domains <https://obsidian.md/help/publish>,
<https://obsidian.md/publish>), and Logseq's file-graph publishing (per-page `public::` property, "All
published pages are displayed in a read-only mode", exported as an SPA —
`logseq/docs` `pages/Publishing.md`).

Shape **B** is what a collaborator-to-be wants ("let me poke around before you invite me") and it is
better built as the *viewer* role of §3 than as a separate mode: a `viewer` token is `read` +
`can_sync` and gets the ordinary client with writes refused. That reuses everything and adds nothing
to the share surface.

### 2.3 Token and scope model on top of what exists

Nothing in `Scope` changes. A share is not a token:

```sql
-- server-only, never synced (sql-schema.md rule 22 already keeps token/device server-only)
CREATE TABLE share (
  id           TEXT PRIMARY KEY,           -- 14-char id; the URL is /s/<id>
  graph_id     TEXT NOT NULL DEFAULT 'default',
  kind         TEXT NOT NULL CHECK (kind IN ('page','graph')),
  page_id      TEXT REFERENCES page(id),   -- NULL for kind='graph'
  include_descendants INTEGER NOT NULL DEFAULT 0,  -- namespace children
  label        TEXT NOT NULL,
  password_hash TEXT,                      -- optional, argon2id (12 §9.6 floor); later
  created_by   TEXT NOT NULL,              -- token id / user id
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  view_count   INTEGER NOT NULL DEFAULT 0
);
```

Two design rules worth writing down now:

- **The id is the secret, so it needs the entropy of a token, not of a page id.** Page and asset ids
  are 45 bits of time + 25 random bits; a share id must be random (≥128 bits, 22+ base32 chars) or the
  URL is guessable from a creation time. Store `sha256(id)` if the row should survive a database
  leak the way `token_hash` does; a share is lower-stakes than a write token, so plain storage is
  defensible — pick one and say why.
- **Do not make the page property `public:: true` the grant.** It is Logseq's convention and it is
  greppable in the mirror, which is attractive — but properties sync to every device and every agent
  with `write` can set them, so an agent could publish a page by mistake. A server-side row created by
  an `admin`-scoped op (`share.create`, `share.revoke`, `share.list` in the `defineOp` registry, MCP
  exposure off by default like `admin.tokens.*`) keeps publication a deliberate act. The property can
  come later as a *hint* the UI offers to turn into a share.

Enforcement is one place: the `/s/:id` route, which never touches the op registry or `bearerAuth`.
Rate-limit it per peer (it is unauthenticated), and count views — the only telemetry a share needs.

### 2.4 The seam with "publish"

A static export (shape C) and a live share (shape A) should share the renderer and differ only in
where the HTML goes: the exporter walks the same `share`-like selection and writes files; the route
renders on demand. If the sibling research picks a different renderer (e.g. reusing the client's Solid
components server-side), this document's only requirement is that the *selection model* (page,
namespace, whole graph; link degradation outside the set) be one implementation. The other seam is
the markdown mirror: `/s/<id>.md` should be byte-identical to the mirror file for that page, minus
`^id` suffixes if the share is meant for humans.

---

## 3. Q2 — Graph membership

### 3.1 Schema: research/12 §6.3, plus one column

Research/12 already drafted `user`, `graph`, `graph_member(role ∈ owner|editor|viewer)` in a separate
`instance.sqlite`, and `token.user_id / device_id / expires_at`. That stands. The one addition this
document makes is **`device.user_id`**, set at pairing (12 §5.4 binds a token to a device; binding the
device to a user is the same write). With it, every op's `device` field resolves to a person with one
join, on the server, at read time.

### 3.2 The op log needs no `user_id`

Three reasons, in order of weight:

1. **Attribution already exists at the right granularity.** `changes.actor` and `changes.origin` are
   written per batch by `serverApplyOps`, and `changes_since` (`ops/changes-since.ts:130`) returns
   "who did it (origin, actor)". Today the actor is a token label; under membership it becomes the
   token's user display name. Zero change to the op wire format.
2. **The client needs a display map, not a new op field.** Clients render "edited by Jana" from
   `op.device`. A `GET /sync/members` returning `device_id → {user_id, display_name, colour}` (or the
   `device` rows joined to `user`, filtered to this graph) cached client-side is enough; it changes
   rarely and is tiny. This is also what presence (§5) needs.
3. **Putting a user id on every op is a one-way door with no upside.** Ops are immutable and replayed
   by `rebuild()`; a user could later be renamed, merged, or removed, and the mapping belongs in a
   mutable table. Research/11 §10.3 made the same argument for `key_epoch`: add a field to `op` only
   when the log itself needs it to be interpretable. Attribution does not.

### 3.3 What survives untouched

| Invariant | Under 2+ people | Why |
|---|---|---|
| HLC total order, `id === hlc` | unchanged | nothing about a person enters the clock |
| Per-field LWW | unchanged | Figma's shipped multiplayer model is exactly this — "Figma's multiplayer servers keep track of the latest value that any client has sent for a given property on a given object" and "Since Figma is centralized (our server is the central authority), we can simplify our system by removing this extra overhead" (2019-10-16, <https://www.figma.com/blog/how-figmas-multiplayer-technology-works/>) |
| Fractional sibling order, id tie-break | unchanged | concurrent inserts at one position interleave; acceptable for outlines (research/03 §9) |
| Cycle rejection + corrective `block.place` | unchanged | Figma again: "Figma's multiplayer servers reject parent property updates that would cause a cycle" |
| Idempotent push, `pull?since=seq`, snapshot bootstrap | unchanged | |
| 3-way merge + `conflict_copy` | unchanged, **more often exercised** | §4 |
| Op-log GC floor `MIN(device.acked_seq)` over live devices | unchanged in code, **changed in effect** | a friend's phone that never returns pins the floor forever; `token.expires_at` (12 §12) is what un-pins it — make expiry mandatory for non-owner tokens |
| `nooklet verify`, `backup`, `restore` | unchanged | per graph file (12 §6.4) |

### 3.4 What needs a decision

**Roles.** Research/12 §7.1's ceiling — `owner → admin`, `editor → write`, `viewer → read`, and
`effective(token) = scopesFor(min(token.scope, roleCeiling(role)))` — is enough. `viewer` is `read` +
`can_sync` (pull and snapshot allowed, push returns 403 from `requireSyncToken`'s sibling check). No
fourth role.

**Who may delete a page.** Proposal: *editors may*, because every delete in nooklet is soft
(`page.delete` sets `deleted_at`; `batch_undo` and the M7 history viewer restore), so the blast radius
is a trash-restore, not data loss. What editors may *not* do — membership, token minting, share
creation, `gc`, mirror settings, graph deletion — is already gated by `admin` scope plus the
`role === 'owner'` assertion 12 §7.1 puts inside `graph.member.*` handlers. Notion's six levels
(<https://www.notion.com/help/sharing-and-permissions>) and Anytype's four (Viewers, Editors, Admins,
Owners — <https://doc.anytype.io/anytype/collaborate/collaboration>) both stop at "can delete content"
for editors; Obsidian's shared vaults have no levels at all ("Fine-grained permissions are not
supported yet. All collaborators receive the same permissions as the vault owner, with one exception:
only the vault owner can invite collaborators" — <https://obsidian.md/help/sync/collaborate>). Three
tiers is the median.

**How a forbidden op is answered — the one new mechanism.** A viewer's client never mints ops. But
an editor whose role was just downgraded, or a token that lost `write` mid-session, has already
applied its op locally (optimistic, in the same transaction as the UI change). ADR 003 forbids client
rebase. So the server must do what it does for a cycle: mark the op `rejected` (new `ApplyReason`
`"forbidden"`) **and emit a corrective op with a newer server HLC restoring the field** — the current
`content`/`place`/`deleted_at` re-asserted so that LWW on every replica, including the offender's,
converges back. `sync-client.ts:257–258` already deletes rejected pending ops and applies corrections
in that order, so the client half exists. The cost is ~60 lines in `serverApplyOps` (a role check per
op kind before `coreApplyOps`, a `mintCorrection` for each field kind) and a property test: "a
device whose token is downgraded between two pushes converges with the others".

**Page-name collisions.** Research/11 §6.2 flagged that concurrent `page.create` of the same name is
reconciled only by the server's `UNIQUE` index today and that the spec calls collision reconciliation
out of scope. With one person it is a race against yourself; with two people creating `[[Meeting
notes]]` on the same day it is Tuesday. The deterministic rule (lowest HLC keeps the key, the loser
is renamed `Meeting notes (2)` by a corrective `page.rename`, or merged) has to exist before
membership ships. It is a corrective-op job like the two above.

**Rate limiting** (12 §11.3, still absent per §1): per token id for `/api/v1/*` and `/mcp`, per peer
for `/s/:id` and `/pair/claim`. Load-bearing once a non-owner can push.

### 3.5 Invitations

An invite is a `pairing` row with a `user_id` and a role (12 §8.1): the owner runs `nooklet invite
--role editor --label jana`, gets an 8-character code and a QR, and the redemption creates the user
row, the membership, a device-bound token and a `device.user_id`. Same expiry, single use and attempt
limits as device pairing (12 §5.3). An invite must not grant a role above the inviter's, and `owner`
must not be grantable by invite (12 §8.1). Anytype's flow is the UX to copy: "The 'Add members via
link' toggle generates a link you can share with others to invite them into the space", with the link
either requiring owner approval or auto-approving (<https://doc.anytype.io/anytype/collaborate/collaboration>).

### 3.6 Revocation, stated the way research/12 §8.3 already states it

Removing a member revokes their tokens and stops future sync. It does not recall what their devices
already hold — a full replica in OPFS/SQLite. Research/12 §8.3 drafted the wording; nothing here
changes it. One addition: revocation should also **close the member's open `/sync/live` and
`/ui/live` sockets** (12 §8.2 found neither socket re-verifies after `hello`), and under §5 it must
drop their presence entry immediately rather than waiting for the TTL.

---

## 4. Q3 — Real-time co-editing of the same block

### 4.1 What the libraries are, today (fetched 2026-09-12)

| | Version, date | Size | CodeMirror 6 binding | Runs in Node | Notes |
|---|---|---|---|---|---|
| **Yjs** | `yjs` 13.6.32, 2026-08-04 (npm `time`); v14 is at **rc.26**, 2026-09-07, still prerelease (`gh api repos/yjs/yjs/releases`); 22,783★ | 63 KB gz (research/03 §2, same version) | **`y-codemirror.next` 0.3.6**, 2026-08-18, 208★, peers `yjs ^13.5.6`, `@codemirror/view ^6`, `@codemirror/state ^6` — compatible with `apps/web`'s `^6.43.11`/`^6.7.4`. README: "Sync CodeMirror 6 editor", "Render remote selection ranges and cursors - as a separate plugin", "each client has its own undo-/redo-history - as a separate plugin"; and "Most users should continue to use the stable `y-codemirror.next` package with Yjs v13 for now" — the v14 binding `@y/codemirror` is 0.0.0-3 (2026-01-19), peers `yjs ^14.0.0-16` | yes, pure JS | Servers: `@hocuspocus/server` 4.7.0 (2026-09-09, peers `yjs ^13.6.8`), `y-websocket` 3.1.0 (2026-08-06). No tree type; v14 removes list `move` (research/03 §2.1) — irrelevant if the tree stays in the op log |
| **Loro** | `loro-crdt` 1.16.1, 2026-09-10; 6,134★, last commit 2026-09-10 | 1.07 MB gz WASM (research/03 §2, same version); npm unpacked 19.9 MB | **`loro-codemirror`** 0.3.3, 2025-10-07, 41★, **last commit 2026-09-12**, peers `loro-crdt ^1.8.2`, CM6 `^6.7.0`. README: "Sync document state with Loro", "Sync cursors with Loro's Awareness and Cursor", "Undo/Redo in collaborative editing" | yes, via WASM | Movable tree with Kleppmann semantics (research/03 §2.3) — the one thing nooklet does *not* need from it, since the tree is already solved by the op log. `EphemeralStore` for presence (§5) |
| **Automerge** | `@automerge/automerge` 3.4.1, 2026-08-12; 6,595★, last commit 2026-09-11 | 1.12 MB gz WASM (research/03 §2); npm unpacked 46.5 MB | **`@automerge/automerge-codemirror`** 0.2.0, 2025-07-21, 38★, **last commit 2025-07-21** — 14 months idle; README says it "adds collaborative editing to codemirror using `automerge-repo`", and `automerge-repo` is `2.6.0-alpha.3` (research/03 §3.2) | yes, via WASM | Not a candidate: alpha repo layer, stale binding, largest bundle, no move op |
| **CodeMirror's own `@codemirror/collab`** | 6.1.1, 2023-09-14 (stable, part of CM6 core) | 24 KB unpacked, no WASM | *is* the binding | n/a — the server is ~50 lines of "append update at version N or rebase" | OT with a central authority: "There is a central system (authority) that builds up a history of changes"; "If there are unconfirmed changes present, operational transformation is used to transpose the remote changes across the unconfirmed local ones"; server-side "If that version matches the server's version, the server accepts the changes as-is … Otherwise, the server can … either reject the updates, or rebase and accept them" (<https://codemirror.net/examples/collab/>). Caveat stated there: shared effects' position mapping "is not guaranteed to converge" across peers — fine for text, so keep cursors on the presence channel (§5) |

Three observations that decide the shape:

- **Yjs is the only CRDT whose CM6 binding is maintained by the library's own author and whose core
  runs in Node without WASM.** That matters because the server would have to run the same library to
  keep `block.content` (the column FTS, refs, embeddings and `page_read` all read) derived from CRDT
  state.
- **Loro's headline feature is the movable tree, and nooklet already has a tree.** Paying 1.07 MB of
  WASM on a phone for a text CRDT alone is the wrong trade; its CM6 binding is young (41★) though
  clearly alive (a commit today).
- **The server-as-authority model nooklet already has is exactly the model CodeMirror's collab module
  assumes, and exactly the one Figma chose over CRDTs.** A CRDT buys convergence *without* an
  authority; nooklet has one by design (ADR 003: "The home server is the single validator").

### 4.2 Four ways to coexist with an op log that is the source of truth

**A. "CRDT bytes in a `block.text.crdt` op"** — ADR 003's documented upgrade path. Each block that
has ever been co-edited carries a per-block `Y.Doc` (or `LoroDoc`) whose updates are appended as ops;
the server applies them with the same library and writes the resulting string into `block.content`
with the op's HLC, so every non-CRDT reader is unchanged. Costs: two merge semantics for one field
(a plain `block.text` from an agent or an old client must be folded into the CRDT as a replace-all
edit on the server, or it fights the CRDT); per-block documents in memory on every device (18,628
blocks × a `Y.Doc` is tens of MB before content, and Yjs tombstones never leave a doc — research/03
§2 estimated 2–4 KB per block snapshot); the op log grows by every keystroke batch, which changes
`sql-schema.md` rule 28's 50k–150k mature-log projection by an order of magnitude and makes op GC
load-bearing; and `rebuild()` now needs the CRDT library to reproduce state. Migration-free, as ADR 003
promised, but not free.

**B. One CRDT document per page** (Y.Map of block id → Y.Text). Cheaper in memory than A and it is
how AFFiNE and BlockSuite do it (research/02: "Yjs doc per page + workspace root doc"), but it puts a
*second* tree next to the op log's tree and every `block.place` across pages becomes a move between
documents — the "delete+insert, so concurrent moves duplicate" problem research/03 §2.1 recorded for
y-prosemirror. Rejected.

**C. Session-scoped OT with `@codemirror/collab`, op log untouched.** While two or more windows are
*in the same block* (known from presence, §5), the server opens an in-memory collab session for that
block: it holds the update history from the session's base text, rebases each client's updates, and
fans them out over `/ui/live`. Every client runs `collab()` in the single CM6 `EditorView` that is
already re-parented into the active block (ADR 006). When the last participant leaves, the session's
final text becomes **one ordinary `block.text` op** from the last writer's device, and the history is
dropped. Nothing is persisted; `rebuild()` is untouched; agents and old clients see a normal text op.
Costs: a `collab` session registry next to the window registry (`live/registry.ts` is the right
home), a `/ui/live` frame pair (`collab.update`/`collab.updates`), a client extension, and the
"leaving mid-session while offline" edge: the departing device's pending `block.text` still goes
through the 3-way merge against the session's committed text, which is the existing path. Roughly
600–900 lines plus tests, no new dependency.

**D. Good enough: presence + soft-lock + the existing merge.** Presence (§5) shows who is in which
block. A "soft lock" is nothing more than presence rendered as a hint on the bullet and, optionally,
a one-line banner in the editor: *"Jana is editing this block; your changes will be merged."* No
locking semantics, no server state beyond presence. Concurrent edits to disjoint spans of a block
merge cleanly today (`merge3`), and the failure mode of overlapping edits is a visible
`conflict_copy` property — the exact behaviour Obsidian Sync ships to shared vaults of up to 20
people ("Obsidian Sync merges the changes using Google's diff-match-patch algorithm", with a
"Create conflict file" alternative — <https://obsidian.md/help/sync/troubleshoot>) and, in
substance, what Logseq DB's RTC does: a remote `:block/title` write that collides with a pending
local one is recorded as a per-block conflict and broadcast to the UI, not merged (§7.1). Logseq's
own roadmap still lists "Present conflicts when multiple clients editing the same block's content",
so the *presentation* is evidently the unfinished half there too.

### 4.3 What each would cost nooklet specifically

| | Client (SolidJS + one CM6 view) | Server (Node + SQLite) | Op log / `rebuild()` | Mobile bundle | New dependency |
|---|---|---|---|---|---|
| A. Yjs per block | `yCollab` in the active view; a `Y.Doc` cache keyed by block id; awareness plugin for cursors | run `yjs` in Node, derive `content` on every update op, fold plain `block.text` into the doc | new op kind, log grows per keystroke batch, replay needs `yjs` | +63 KB gz | `yjs`, `y-codemirror.next`, `y-protocols` |
| A′. Loro per block | same shape via `loro-codemirror` | `loro-crdt` WASM in Node | same | **+1.07 MB gz** | `loro-crdt`, `loro-codemirror` |
| C. Session OT | `collab()` extension + a small transport shim | in-memory sessions in `live/`; ~100 lines of rebase bookkeeping | **none** | +24 KB | none (already in CM6 core) |
| D. Presence + merge | avatar chips on bullets; optional banner | presence fan-out (§5) | none | ~0 | none |

### 4.4 Recommendation

**D now. C if, after living with D, "we both typed in the same block" is a real complaint. A only if
live typing-together becomes a product goal in its own right, and then Yjs, not Loro.** The reasoning
is the same as ADR 003's: nooklet has a central validator, so it should use it; a CRDT's whole value
is convergence without one. And the honest empirical point is that the two shipped outliners that
have multi-user sync — Obsidian's shared vaults and Logseq DB's RTC — both stop at "merge, or keep
both and present the conflict" for a single block, which is where nooklet already is. (Logseq gets
there by client-side rebase, which ADR 003 rejected; the *outcome* for the user is the same.)

One thing to do regardless: make `conflict_copy` **visible**. Today it is an ordinary block property;
with two people it needs a badge on the block, a one-click "take theirs / take mine / keep both as
two blocks", and a "conflicts" filter in the Tasks-style views. That is UI on top of data that already
exists and it is the cheapest possible improvement to co-editing.

---

## 5. Q4 — Presence

### 5.1 It is a broadcast, not a merge — every system separates it

- Yjs: awareness "manages user status (who is online?) and propagates ephemeral state such as cursor
  location, username, or color", and "Each client whose state has not been refreshed for 30 seconds
  is dropped locally"; it is a separate module from the sync protocol
  (<https://github.com/yjs/y-protocols>).
- Loro: the `EphemeralStore` exists because presence "doesn't persist in the CRDT Document but
  remains ephemeral"; it is "a timestamp-based, last-write-wins key-value store" with a constructor
  timeout (`loro-dev/loro-docs` `pages/docs/tutorial/ephemeral.mdx`).
- any-sync (Anytype): "An ephemeral, fire-and-forget, at-most-once publish/subscribe channel scoped to
  a space", "carried over a dedicated DRPC bidi stream fully isolated from the sync engine", "No
  message persistence anywhere", NATS-style topics, and for presence it recommends the "Yjs awareness"
  pattern — "full state per message, no diffs" — with "TTL expiry as the normative leave mechanism"
  (`anyproto/any-sync` `docs/stateless-pubsub.md`).

nooklet already has the same separation for a different reason: ADR 015 put per-window ephemeral
state on its own socket precisely because the sync poke channel is "mandatory, always-on, per-device,
and protected by property tests".

### 5.2 Which socket, and what it takes

**Use `/ui/live`, not `/sync/live`.** The window registry already is a presence table: keyed by
`(device_id, window_id)`, in-memory only, holding `page`, `focused`, `lastActiveAt`, with the client
re-sending `hello` on page/focus change. What is missing:

1. `HelloInfo` gains `block?: string | null` and `selection?: {from, to} | null` (block-relative
   offsets; CM6 positions inside the active block), and the client's existing "keep it updated"
   re-send fires on block focus change and, throttled to ~100 ms, on selection change.
2. A new outbound frame `{type: "presence", windows: [...]}` fanned out on every registry change to
   every other window **of the same graph** (one graph per process today, so "every other window"),
   excluding the sender. Full state per message, as Yjs and any-sync do — no diffs, no ordering
   problem.
3. Identity for display: `device_label` is already looked up in `wire.ts`; under §3 it becomes the
   member's display name plus a stable colour derived from `user_id`.
4. TTL: the registry already unregisters on `onClose`; add a 30 s inactivity drop like Yjs so a
   suspended phone does not haunt a block.
5. Client: a Solid store `presence: Map<blockId, Participant[]>`; a chip on the bullet; and, only if
   wanted, a remote caret decoration in CM6 (y-codemirror's remote-cursor plugin is self-contained and
   a reasonable pattern to copy without adopting Yjs).

Roughly 300 lines server, 300 client, plus a property test that "windows never see stale presence
after a close". `ADR 015`'s default-on "let agents view this window" toggle is about *agents*;
presence to *other people* needs its own toggle, default on for members, and the status-bar badge
should show it.

### 5.3 Why it is separable from co-editing

Presence carries no document state and needs no merge semantics; it is correct if it is merely
*recent*. Co-editing (any of §4 A/C) needs an ordered, acknowledged stream. The two can share a socket
but must not share a queue — any-sync's reason for a dedicated stream is head-of-line blocking, and
it applies here: a burst of `collab.update` frames must not delay the presence frame that tells the
other person you have left the block.

---

## 6. Q5 — Hosting for friends

### 6.1 What a multi-tenant server needs (and where each piece is already designed)

| Need | Where designed | Status |
|---|---|---|
| Per-graph isolation | file-per-graph, process-per-graph (12 §6.2) | works today with zero code: `nooklet serve --data <dir> --port <n>` per graph |
| Users, memberships | `instance.sqlite` (12 §6.3), §3 here | designed, not built |
| Browser login that mints bearer tokens | session cookie authenticating only `GET /api/session` (12 §9.6) | designed, ~200 lines |
| Device pairing / invites | pairing codes (12 §5), invites (§3.5) | designed, ~250 lines |
| TLS, secure context | Tailscale or Caddy, never in-process (12 §10) | documented; plain-LAN HTTP does not work at all (12 §10.1) |
| Rate limiting | 12 §11.3 | **absent** |
| Quotas | — | none: needs per-graph caps on `graph.sqlite` bytes, `assets/` bytes and op count, checked in `serverApplyOps`/`asset_upload`, and a per-graph `nooklet gc` schedule |
| Backups | `nooklet backup` per data dir (OPERATIONS.md) | per graph, unchanged |
| The E2EE question | research/11 §9.4 | answered: a browser-delivered E2EE relay is not defensible against the operator; a signed native client would be. So: **trusted-operator hosting, disclosed in Bitwarden's style** (11 §9.2), plus cheap exit (mirror `.md` + backup tarball) |

### 6.2 A sensible v1, in two steps

**v0 — no code: Tailscale sharing.** Tailscale node sharing: "You can share access to specific
machines with people outside your Tailscale network (known as a tailnet) without exposing them to the
public internet"; "Sharing gives the recipient access to only the shared machine in your tailnet, and
nothing else"; "Sharing is available for all plans"; the shared machine is quarantined by default —
it "can receive incoming connections (from the other user's tailnet) but cannot start connections"
(<https://tailscale.com/kb/1084/sharing>). The recipient must themselves be "an Owner, Admin, or IT
admin of a tailnet" — i.e. have a (free) Tailscale account. With `tailscale serve` the friend gets a
real Let's Encrypt certificate and, notably, **identity headers for free**: serve adds
`Tailscale-User-Login` ("the requester's login name (for example, `alice@example.com`)"),
`Tailscale-User-Name` and `Tailscale-User-Profile-Pic` to proxied requests
(<https://tailscale.com/kb/1312/serve>). So today, a friend = one `nooklet serve --data
~/graphs/jana --port 6102` process, one `tailscale serve --bg --https=6102 http://127.0.0.1:6102`,
one node share, and one pairing code for their phone. Separate graph, separate token table, separate
backups; the owner can read it (trusted operator) and says so.

**v1 — small code, in this order.** (1) Rate limiting and per-graph quotas, because they are the
difference between "a friend" and "a tenant". (2) Pairing codes and `token.expires_at`, already
research/12 §13's top items. (3) Trust `Tailscale-User-Login` as the identity for `/api/session`
**only** when the request's peer is the local tailscaled (12 §10.5's `--trusted-proxy` rule) — a
users table with no password storage, no email, no OIDC, because Tailscale already did the login.
(4) `instance.sqlite` + a `nooklet graph create --owner <login>` command, so a graph is minted rather
than hand-made. (5) Only then, if a friend wants *in* to the owner's graph rather than their own: §3.

What stays out: multi-graph in one process (12 §13: two processes is already multi-graph, and it
keeps `writeLock`, the plugin registry and the WeakMaps correct by construction); OAuth/OIDC as a
provider (12 §9); E2EE for the PWA (11 §9.4); a billing or abuse system — "friends" is a fixed, named
list, not a sign-up page.

---

## 7. Q6 — Prior art, what actually ships, with dates

### 7.1 Logseq

- **File-graph Logseq Sync**: "Paid feature that provides encrypted synchronization of graphs between
  devices", "This feature is in BETA", "available for all *active* Open Collective contributors ($5
  or $15 per month)", "Syncs up to 10 graphs", encryption via `age` with filenames encrypted too, and
  — the sentence that matters here — "**Question:** Can I use Sync with other users? This isn't
  supported yet." (`logseq/docs` `pages/Logseq Sync.md`, fetched 2026-09-12 via `gh api`; the page
  carries no date). Encryption scheme in `pages/Logseq Sync Encryption.md`: age + a "modified version
  of ChaCha20-Poly1305. Weaker, bug good enough for filenames" with an all-zero nonce, implemented in
  `logseq/rsapi` (last pushed 2025-05-24).
- **The split**: announced 2026-04-24 (<https://logseq.io/p/e3YDyX5AYr>): "Logseq OG" keeps
  file-based graphs; the DB version is "the main version going forward"; DB Sync "encrypted locally on
  your device", "Encrypted graph nodes are synchronized to Logseq's servers"; "Self-hosted sync" and
  "Page publish" are listed as recent DB improvements; "Real-time collaboration" is in the vision
  section. Logseq 2.0.1 (DB) beta shipped 2026-07-13 (`gh api repos/logseq/logseq/releases`).
- **RTC exists in the DB codebase**: `src/main/frontend/worker/sync/` holds `presence.cljs`
  ("Presence and rtc state helpers for db sync"), `transport.cljs`, `apply_txs.cljs`, `crypt.cljs`,
  `auth.cljs`, `client_op.cljs`; `src/main/frontend/components/rtc/indicator.cljs`,
  `handler/db_based/rtc_flows.cljs` ("Reactive RTC atoms", last commit 2026-06-05) and
  `clj-e2e/src/logseq/e2e/rtc.clj` (waits on a `rtc-tx` `{:local-tx :remote-tx}` pair) — the sync
  client `worker/sync.cljs` reconnects with jitter and tracks a remote checksum.
- **How it handles two people in one block** (`worker/sync/apply_txs.cljs`, "Pending tx and remote
  tx application helpers for db sync"): `apply-remote-tx-with-local-changes!` does
  `reverse-local-txs!` → `transact-remote-txs!` → `rebase-local-txs!` — a **client-side rebase** of
  pending local transactions over the remote ones, the design ADR 003 explicitly rejected ("Clients
  never rebase"). Before rebasing it computes `remote-sync-conflicts`: for the attribute set
  `sync-conflict-attrs #{:block/title}` only, any remote `:db/add` whose block is also touched by a
  pending local tx and whose value differs from the current one becomes `{:block-uuid :attr :value
  :remote-t}`; those are stored (`client-op/add-sync-conflicts!`) and pushed to the UI
  (`broadcast-sync-conflicts!` → `:sync-conflicts-updated`). No text merge, no CRDT: the local
  edit is re-applied over the remote one and the remote value is kept as a recorded conflict —
  functionally nooklet's `conflict_copy`, reached by rebase instead of LWW.
- **The sync server is open source, in the same repo**: `deps/db-sync/README.md` — "This package
  contains the DB sync server code and tests used by Logseq. It includes the Cloudflare Worker
  implementation and a Node.js adapter for self-hosting." Server side has `worker/{presence,ws,
  auth,http}.cljs` and `node/{server,routes,storage,assets,api_docs}.cljs`; D1 (Cloudflare's SQLite)
  migrations; admin scripts for per-user graph lookup and usage stats; last commit 2026-09-08.
  `start.sh` runs `node worker/dist/node-adapter.js` with `COGNITO_ISSUER`, `COGNITO_CLIENT_ID` and
  `COGNITO_JWKS_URL` exported, and `node/config.cljs` reads exactly those three keys from the
  environment with no default, alongside `DB_SYNC_STORAGE_DRIVER` defaulting to `"sqlite"` and
  `DB_SYNC_ASSETS_DRIVER` to `"filesystem"` — so the adapter genuinely runs on one SQLite file plus a
  directory, the same shape as nooklet, but as shipped it authenticates users against **AWS
  Cognito**; the one alternative `worker/auth.cljs` exposes is a `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS`
  flag (§9 item 2). An earlier `gh api
  search/repositories?q=org:logseq+sync` found only `rsapi` and `capacitor-file-sync`, because the
  server is a subdirectory, not a repository.
- **Roadmap** (<https://logseq.io/p/NX4mc_ggEV>, page dated 2026-08-18): "Self-hosted sync" with no
  status; an "RTC" section containing "End-to-End encryption support", "Recycle to restore deleted
  pages" and "**Present conflicts when multiple clients editing the same block's content**"; "Page
  publishing" with a 2025-12-30 deadline; "Server Restful API && MCP support"; "New CLI" enabling
  "Headless sync doesn't rely on the desktop app".

### 7.2 Obsidian

- **Sync**: "Sync Standard: $4 USD Per user, per month, billed annually" (1 synced vault), "Sync
  Plus: $8" (10 vaults); "Invite your team to a shared Obsidian vault. Notes are updated in real-time
  across your team's devices" (<https://obsidian.md/sync>). Collaboration page: invite by email; "All
  collaborators must have an active Sync subscription to access a shared vault"; "Fine-grained
  permissions are not supported yet"; "If multiple users are editing the same file at the same time,
  changes will be merged during the syncing process"; "The maximum number of collaborators on a
  shared vault is 20 users" (<https://obsidian.md/help/sync/collaborate>). Merge rule: "Obsidian Sync
  merges the changes using Google's diff-match-patch algorithm", other files "last modified wins",
  optional `(Conflicted copy device-name YYYYMMDDHHMM).md` (<https://obsidian.md/help/sync/troubleshoot>).
  Security page still lists the unencrypted metadata ("which device uploaded or deleted a file, when
  it was uploaded, and the *mapping* between encrypted file paths and encrypted content" —
  <https://obsidian.md/help/sync/security>). So: E2EE **and** shared vaults, at file granularity,
  with no presence, no permissions, and diff-match-patch — the closest shipped analogue to nooklet's
  merge model.
- **Publish**: hosted at `publish.obsidian.md/your-site`, per-note selection, passwords, custom
  domain, "$8 USD Per site, per month, billed annually", "up to 4GB" (<https://obsidian.md/publish>,
  <https://obsidian.md/help/publish>). Changelog through 1.14.1 (2026-09-08) shows only Sync
  housekeeping (a warning dialog for syncing plugins) — no new shared-vault features in 2026
  (<https://obsidian.md/changelog/>).

### 7.3 Tana

The company split its product: tana.inc is now "a workspace where your team, your agents, and your
shared context come together" — an "agentic meeting platform" — and the outliner "was renamed Tana
Outliner" at <https://outliner.tana.inc>, which says: "Not to be confused with Tana, the company's
separate, newer agentic meeting platform". Tana Outliner: "A workspace is a top-level container for
your content. Every user has a private workspace that only they can see. You can create additional
workspaces and invite members to collaborate"; "Turn any node into a public web page that anyone can
view without a Tana Outliner account", read-only and password-protectable; Free/Plus/Pro plans. Its
permission levels and conflict behaviour could not be fetched (§9).

### 7.4 Anytype — the closest architecture

- Roles: "Viewers can only read content", "Editors can edit and delete content", "Admins can manage
  members", "Owners can do everything, including managing invitation links and transferring
  ownership"; invite links with owner approval or auto-approve; "Data is encrypted before it leaves"
  the device and "only you and your invited teammates can ever read it"; "Everything works offline
  by default and syncs with end-to-end encryption again once a network connection is established";
  "Each Channel has a maximum number of Editors based on the Owner's plan"
  (<https://doc.anytype.io/anytype/collaborate/collaboration>). Client `anytype-ts` v0.56.9-alpha,
  2026-09-07.
- Protocol: `anyproto/any-sync` (1,707★, last commit 2026-09-08) — sync nodes, file nodes, "a
  consensus node responsible for ACL changes monitoring and validation", a coordinator; "data in
  any-sync is stored as encrypted Directed Acyclic Graphs (DAGs)"; "Each device independently applies
  and cryptographically verifies CRDT updates"; presence via the stateless pub/sub of §5.1.
- The lesson research/02 already drew stands: this is what E2EE + multi-user + local-first costs —
  four node types and a consensus service for ACL ordering. It is the right design for a company
  whose product *is* the network; it is not the right design for one person hosting friends.

### 7.5 Notion

Page-level sharing with six levels ("Full access", "Can edit", "Can edit content", "Can create",
"Can comment", "Can view"); subpages inherit; "Anyone on the web with link" needs no account; public
pages cannot be password-protected ("Unfortunately, not at the moment"); a separate "Notion Sites"
tier adds indexing and custom domains (<https://www.notion.com/help/sharing-and-permissions>,
<https://www.notion.com/help/public-pages-and-web-publishing>). Real-time co-editing is the product's
baseline and is not documented as a feature. Notion is the reference for *what a share link is
expected to do*, not for how to build one.

### 7.6 Beyond products: local-first access control

Ink & Switch's Keyhive (started August 2024, pre-alpha March 2025, "DO NOT use this release in
production applications") is the research answer to membership *without* a server: documents
"delegate control over themselves to other public keys", membership is a CRDT, and revocation blanks
a leaf and "the entire path from that leaf up to the root node" of a key tree
(<https://www.inkandswitch.com/keyhive/notebook/>). Worth knowing it exists; nooklet has a server and
does not need it.

---

## 8. Ranked shortlist, and what stays out

### Do, in this order

1. **Presence on `/ui/live`** (§5) — block-level "who is here", 30 s TTL, own consent toggle. Small,
   no schema, no dependency, and it is the feature that makes the existing merge model *feel* safe
   with two people. Also the precondition for anything in §4.
2. **Read-only share links** (§2): `share` table, `/s/<id>` HTML + `.md`, `share.*` admin ops. Uses
   only the server; the sibling publish work and this share the renderer.
3. **Make conflicts first-class** (§4.4): badge + resolve UI over `conflict_copy`, a deterministic
   page-name-collision rule, and a "forbidden → corrective op" path in `serverApplyOps` (§3.4). These
   are the three corrective-op jobs that membership needs and that also fix single-user rough edges.
4. **Host-for-friends v0 and v1** (§6.2): Tailscale share now; then rate limiting, quotas, pairing
   codes with expiry, and Tailscale identity headers as the login.
5. **Graph membership** (§3) — roles, invites, `device.user_id`, `GET /sync/members` — only when a
   second person actually wants into one graph, and after 3 and 4.
6. **Session OT for the same block** (§4.2 C) — only if, after 1 and 3, simultaneous typing in one
   block is a real complaint. No new dependency.

### Stay out, and why

- **A CRDT as the source of truth, or per-block CRDT ops** (§4.2 A): ADR 003's reasons still hold,
  every shipped outliner with multi-user sync stops at merge-or-present, and the cost lands on the op
  log's size, `rebuild()`, and the phone bundle. Yjs would be the pick if this is ever revisited.
- **Loro or Automerge specifically**: Loro's tree solves a problem nooklet solved another way and
  costs 1.07 MB gz; Automerge's CM6 binding has been idle for fourteen months and its repo layer is
  alpha.
- **E2EE for hosted friends via the PWA**: research/11 §9.4's verdict, unchanged.
- **Users/roles before someone asks for them**: research/12 §13's verdict, unchanged; §3 is the
  design to keep, not the code to write.
- **Page property as the share grant** (§2.3): agents can write properties; publication must be a
  server-side act.
- **Real-time cursors inside CodeMirror** as a first step: caret decorations are the visible part of
  presence but the least useful in an outliner where the unit of attention is the block; ship block
  chips first.
- **mDNS, OAuth-as-provider, multi-graph-in-one-process**: already out (research/12 §13).

---

## 9. Still unverified

Copying `research/10`'s shape: things this report could not check that would change a conclusion if
they came out differently.

1. **Whether Logseq's UI actually shows the recorded block conflicts.** §7.1 read the worker code
   that detects, stores and broadcasts `:sync-conflicts-updated`; the component that renders them
   was not located (`components/rtc/` was only listed, not read), and the roadmap still lists
   "Present conflicts" as open. The *detection* claim is verified; the *presentation* claim is not.
2. **Whether Logseq's self-hosted `db-sync` adapter can run without AWS Cognito.** `start.sh` exports
   Cognito issuer/client/JWKS variables, `node/config.cljs` reads only those three auth keys (no
   default, no alternative provider key), and the README calls the Node adapter "for self-hosting".
   `worker/auth.cljs` was grepped, not read: the only non-Cognito path it exposes is an environment
   flag `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS` — accept a JWT's claims without verifying its
   signature — which is a development switch, not an identity model. Treat "self-hostable" as
   "self-hostable if you also point it at a Cognito-compatible JWT issuer, or disable signature
   verification" until someone runs it. For nooklet this is the comparison that matters: its equivalent is a bearer
   token in a table (12 §9.6), which is why §6.2's v0 is zero code and Logseq's is not.
3. **Tana Outliner's permission levels and same-node conflict behaviour.** `/learn/features/sharing`
   and `/learn/features/sharing-and-permissions` both returned 404; only the landing page was read.
4. **Anytype's per-plan editor limits.** The docs say "a maximum number of Editors based on the
   Owner's plan"; the pricing page is JavaScript-rendered and returned only its headline. The doc's
   use of "Channel" where older material says "Space" is also unexplained.
5. **Bundle sizes** are from research/03's measurement of 2026-09-10 (`yjs` 63 KB gz, `loro-crdt`
   1.07 MB gz, `@automerge/automerge` 1.12 MB gz). The versions are unchanged since (13.6.32, 1.16.1,
   3.4.1, confirmed against the npm registry today), so the numbers should hold; they were not
   re-measured here. `@codemirror/collab`'s 24 KB is npm's *unpacked* size, not gzipped.
6. **Memory of one `Y.Doc` per block at 18k blocks** (§4.2 A). Estimated from research/03's 2–4 KB
   snapshot figure; never measured on a phone. Only matters if option A is revisited.
7. **`@codemirror/collab` inside a re-parented single `EditorView`** (§4.2 C): the collab extension
   assumes one document per view; swapping the view between blocks means starting and stopping a
   collab session per focus change. Plausible, not prototyped.
8. **`tailscale serve` identity headers for a path/port-mounted HTTP proxy from a *shared* node.**
   The serve docs state the headers; whether they are populated for a user on another tailnet
   reaching a shared machine was not tested. Test with one friend before building §6.2 step 3 on it.
9. **Whether `/ui/live` frames reach every window of a graph across processes.** Trivially yes today
   (one process per graph); if 12 §6.2's "one process, many graphs" is ever chosen, the fan-out must
   be keyed by driver, as `live/registry.ts` already is.
10. **`y-codemirror.next` behaviour with Yjs 14** is explicitly unstable per its own README; if
    option A is ever taken, pin Yjs 13 until `@y/codemirror` leaves 0.0.0-x.
11. **Obsidian shared-vault presence.** The collaboration page says nothing about seeing other
    editors' positions; it is assumed absent because it is undocumented, not because it was tested.
12. **Rate-limit and quota numbers.** `docs/spec/mcp-tools.md` §3.7's figures were written for one
    user; nothing here measured what a second editor's sync burst looks like.

---

## 10. Sources

In this repository: `docs/adr/003-sync-oplog-hlc-lww.md`, `docs/adr/013-*.md`,
`docs/adr/015-live-ui-control-channel.md`, `docs/PLAN.md` §2, `docs/research/02-competitors.md`,
`docs/research/03-sync.md` §2–3/§6.4/§8, `docs/research/11-e2ee-sync.md` §1/§6–§10,
`docs/research/12-multi-user-and-pairing.md` §1/§5–§13, `docs/research/13-logseq-usage-and-demand.md`
§4, `docs/spec/sql-schema.md` rules 21–22, `packages/core/src/sync/{apply-ops,text-merge,types}.ts`,
`packages/core/src/hlc.ts`, `packages/server/src/apply-ops.ts`, `packages/server/src/auth/tokens.ts`,
`packages/server/src/sync/{auth,live,push,realtime}.ts`, `packages/server/src/live/{registry,wire}.ts`,
`packages/server/src/http/{app,assets,web-client}.ts`, `packages/server/src/ops/{page-read,changes-since,idempotency}.ts`,
`packages/server/src/schema.ts`, `apps/web/src/sync/sync-client.ts`, `apps/web/src/live/socket.ts`,
`apps/web/package.json`.

Libraries (npm registry `time`/`dist-tags`/`peerDependencies`, and `gh api` for stars and last commit,
all 2026-09-12): `yjs`, `y-codemirror.next`, `@y/codemirror`, `y-protocols`, `y-websocket`,
`@hocuspocus/server`, `loro-crdt`, `loro-codemirror`, `@automerge/automerge`,
`@automerge/automerge-codemirror`, `@codemirror/collab`. Repositories:
<https://github.com/yjs/y-codemirror.next>, <https://github.com/yjs/y-protocols>,
<https://github.com/loro-dev/loro-codemirror>, <https://github.com/loro-dev/loro-docs>
(`pages/docs/tutorial/ephemeral.mdx`), <https://github.com/automerge/automerge-codemirror>,
<https://codemirror.net/examples/collab/>.

Products: Logseq — `logseq/docs` `pages/{Logseq Sync,Logseq Sync Encryption,Publishing,Publish Web}.md`,
<https://logseq.io/p/e3YDyX5AYr>, <https://logseq.io/p/NX4mc_ggEV>, `logseq/logseq`
`src/main/frontend/worker/sync/*`, `handler/db_based/rtc_flows.cljs`, `clj-e2e/src/logseq/e2e/rtc.clj`,
releases. Obsidian — <https://obsidian.md/sync>, <https://obsidian.md/help/sync/collaborate>,
<https://obsidian.md/help/sync/troubleshoot>, <https://obsidian.md/help/sync/security>,
<https://obsidian.md/publish>, <https://obsidian.md/help/publish>, <https://obsidian.md/changelog/>.
Tana — <https://tana.inc/>, <https://outliner.tana.inc/>. Anytype —
<https://doc.anytype.io/anytype/collaborate/collaboration>, <https://github.com/anyproto/any-sync>
(`README`, `docs/stateless-pubsub.md`), `anyproto/anytype-ts` releases. Notion —
<https://www.notion.com/help/sharing-and-permissions>,
<https://www.notion.com/help/public-pages-and-web-publishing>.

Architecture: Figma, *How Figma's multiplayer technology works* (2019-10-16)
<https://www.figma.com/blog/how-figmas-multiplayer-technology-works/>; Ink & Switch, Keyhive
<https://www.inkandswitch.com/keyhive/notebook/>; Tailscale node sharing
<https://tailscale.com/kb/1084/sharing> and serve <https://tailscale.com/kb/1312/serve>.
