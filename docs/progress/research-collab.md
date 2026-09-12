# Progress: research/15 collaboration and sharing

Task: write `docs/research/15-collaboration-and-sharing.md` (dated, cited, "Still unverified"
section). Owner's question: "research how we could do collaborative editing / sharing features."
Constraint: that file is the only deliverable in the tree; this progress file exists per the
coordinator's resilience instruction. Do not commit.

Updated: 2026-09-12 15:40Z

## State

- `docs/research/15-collaboration-and-sharing.md`: **written in full** (sections 0–10: TL;DR, what
  exists today, Q1 sharing, Q2 membership, Q3 co-editing, Q4 presence, Q5 hosting for friends,
  Q6 prior art, ranked shortlist + stay-out, still unverified, sources).
- Web-search budget was exhausted before this task; all external facts came from direct WebFetch of
  primary URLs, `gh api`, and `curl` against the npm registry.

## Sources fetched (done)

Repo: ADR 003/013/015, PLAN §2, research/02 §(collab lines), research/03 §2–3/§6/§8, research/11 (all),
research/12 (all), research/13 (roadmap link), core `apply-ops.ts`, `text-merge.ts`, `types.ts`,
`hlc.ts`, server `auth/tokens.ts`, `sync/{auth,live,push,realtime}.ts`, `live/{registry,wire}.ts`,
`http/app.ts` (Host fix present), `http/assets.ts`, `ops/{page-read,changes-since,idempotency}.ts`,
`schema.ts` (token/device/changes/idempotency), `apps/web/src/sync/sync-client.ts` (rejected/
corrections handling, resolveTextConflicts), `apps/web/src/live/socket.ts`, `apps/web/package.json`.

External: npm registry (yjs, y-codemirror.next, @y/codemirror, y-protocols, y-websocket,
@hocuspocus/server, loro-crdt, loro-codemirror, @automerge/automerge, @automerge/automerge-codemirror,
@codemirror/collab); GitHub via gh api (stars/last commit for yjs, loro, automerge, the three CM6
bindings, any-sync; logseq/docs pages Logseq Sync, Logseq Sync Encryption, Publishing, Publish Web;
logseq/logseq worker/sync listing, rtc_flows.cljs, clj-e2e rtc.clj, releases; loro-docs
ephemeral.mdx; any-sync docs listing; anytype-ts latest release); WebFetch (y-codemirror.next README,
loro-codemirror README, automerge-codemirror README, codemirror.net collab example, y-protocols README,
Figma multiplayer blog, Keyhive notebook, Tailscale sharing + serve, Obsidian sync/collaborate/
troubleshoot/security/publish/help-publish/changelog, Notion sharing + public pages, tana.inc,
outliner.tana.inc, Anytype collaboration doc, any-sync README + stateless-pubsub, logseq.io split
announcement + roadmap).

Failed fetches (recorded in §9 of the research file): outliner.tana.inc sharing pages (404),
anytype pricing (JS-rendered / 404), loro.dev ephemeral page (403 — got it from loro-docs repo
instead), any-sync docs/acl.md (does not exist), raw logseq/docs URLs (404 — used gh api instead),
logseq worker/rtc dir (does not exist; RTC lives under worker/sync + handler/db_based).

## Done since the first write (15:45Z)

- Read `apply_txs.cljs` (conflict detection: `sync-conflict-attrs #{:block/title}`,
  `remote-sync-conflicts`, `broadcast-sync-conflicts!`, client-side rebase) → patched §0 item 6,
  §4.2 D, §4.4, §7.1, §9 item 1.
- Found `deps/db-sync` (open-source sync server: Cloudflare Worker + Node adapter; `start.sh` and
  `node/config.cljs` require Cognito env; storage defaults sqlite + filesystem; last commit
  2026-09-08) → patched §0 item 6, §7.1, §9 item 2.
- Grepped `deps/db-sync/.../worker/auth.cljs` for a non-Cognito path: only
  `DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS` → folded into §7.1 and §9 item 2.

## Next steps

None. Consistency pass done (all `§` cross-references resolve to this file or are qualified with
`11 §`/`12 §`/`mcp-tools.md §`). Report delivered to the owner. Nothing committed, per the task.

If restarted: the task is finished. Do not rewrite or re-research; at most re-read
`docs/research/15-collaboration-and-sharing.md` §8 to restate the shortlist.
