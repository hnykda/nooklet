# nooklet — Sync architecture research (2026-09-10)

Scope: local-first block-outliner (Logseq replacement) with a self-hosted Node "home" server that also hosts the HTTP API, MCP server and Ollama embeddings; web/PWA clients (incl. iOS/Android) that work fully offline; markdown files on disk as import/export or continuous mirror.

All versions below were checked against the npm registry / GitHub API on 2026-09-10 unless noted. Bundle sizes were measured by downloading the npm tarballs and gzipping the shipped artifacts.

---

## 0. TL;DR

**Recommendation: do not build the app on a general-purpose CRDT document. Build a small, boring, fully-inspectable sync core on SQLite:**

- One append-only **oplog** of tiny per-field operations (`set block.text`, `set block.parent+pos`, `tombstone`, …), each stamped with a **hybrid logical clock (HLC)** by the device that made it.
- **Per-field last-writer-wins by HLC** (Actual Budget / cr-sqlite / TinyBase / Evolu all use exactly this rule) — this handles concurrent property/text edits and delete-vs-move without any special casing.
- **Sibling order = fractional index string** on each block (LWW field like any other; ties broken by op id). Concurrent inserts at the same position never lose a block.
- **Tree moves = LWW `parent` field + the home server as the single validator** (the Figma rule): the server applies pushed ops in arrival order, rejects any move that would create a cycle in *its* state, and emits a *corrective* move op with a fresh (newer) HLC. Clients need no undo/redo, no rebase — they just keep applying LWW ops; the renderer tolerates a transient cycle for the few hundred ms until the correction arrives.
- **Home server = hub and source of truth.** HTTP API / MCP writes, markdown-import writes, and the continuous markdown mirror all produce ops through the *same* `applyOps()` function as device pushes — so there is exactly one write path. Embeddings are a server-side consumer of that same path (dirty queue keyed by content hash).
- Client store: **SQLite in a worker via wa-sqlite `OPFSCoopSyncVFS`** (works Chrome 108+/Safari 16.4+/Firefox 111+, no COOP/COEP headers, cooperative multi-tab) with the official `@sqlite.org/sqlite-wasm` `opfs-sahpool` as an equally good alternative; IndexedDB VFS fallback for private mode.
- Text: per-block LWW in v1; **3-way merge (diff-match-patch / diff3) when a remote text op collides with a locally pending edit** as v1.1 (this is literally what Obsidian Sync does for `.md`); a per-block **Loro** `LoroText` container only if you ever want live character-level co-editing (v2, opt-in, no data migration needed because ops are extensible).

Top alternative ("start with Loro and never migrate"): Loro 1.16 is the only mainstream library with a *correct* movable tree (Kleppmann move-op + fractional index) plus a text CRDT, and its own MIT sync protocol/server. It is genuinely good and is the right answer if live multi-user co-editing is a core goal. It costs a 1.07 MB gzipped wasm, an in-memory whole-graph document model on mobile, a derived-SQLite bookkeeping layer, a young (0.x, ~40-star) protocol package, and opaque binary state that is harder for one person to debug than rows in SQLite. Details in §8.

---

## 1. What the requirements imply

| Requirement | Implication |
|---|---|
| (a) fully offline client with local DB | Client must hold *all* of the graph locally (a personal graph: 10k–200k blocks). Sync is "replicate everything", not "subscribe to shapes". Engines built around Postgres row-subscription (Electric, PowerSync, Zero) are a poor fit. |
| (b) self-hosted Node home server that also runs API/MCP/embeddings | Server is a **hub**, not a peer. That is a huge simplification: you can let the server linearize/validate structure (Figma/Logseq-RTC/Replicache pattern) instead of needing a fully P2P-correct CRDT. |
| (c) block tree + pages | You need: a movable tree with ordered siblings, per-node properties, text. Only Loro has this natively; everyone else (Yjs, Automerge, all SQL engines) makes you build it. |
| (d) sane merges; per-block LWW text is acceptable | Per-field LWW + fractional index + server cycle check covers everything except char-level text merge, which is explicitly optional. |
| (e) one developer owns/debugs it | Favor: plain rows, a total order you can print (`server_seq`), deterministic replay, property-based tests. Avoid: opaque binary CRDT state as the source of truth unless it buys you something you actually need. |
| (f) markdown files on disk without corrupting sync state | Files must never be the sync medium. They are an *importer/exporter of ops* on the server side. Anything that syncs files themselves (SilverBullet, Obsidian Sync, Syncthing) ends up with conflict copies. |

---

## 2. CRDT libraries (state as of 2026-09-10)

Measured artifact sizes (from npm tarballs, gzip -6):

| Package | Version (date) | License | Shipped size | Notes |
|---|---|---|---|---|
| `yjs` | 13.6.32 (2026-08-04); **14.0.0-rc.26** (2026-09-07) | MIT | `dist/yjs.mjs` 300 KB raw / **63 KB gz**, no wasm | v14 still RC after 26 RCs |
| `loro-crdt` | **1.16.1** (2026-09-10) | MIT | `loro_wasm_bg.wasm` 3.24 MB raw / **1.07 MB gz** (+ JS glue) | very active (release the same day) |
| `@automerge/automerge` | 3.4.1 (2026-08-12) | MIT | `automerge.wasm` 3.57 MB raw / **1.12 MB gz** | |
| `diamond-types-web` | 1.0.2 (2023-05-15) | ISC/Apache | — | repo active (pushed 2026-09-02) but "WIP", text-only |

### 2.1 Yjs
- Data types: `Y.Map`, `Y.Array`, `Y.Text`, `Y.XmlFragment`. **No tree type and no move operation.** v13 had an experimental `move` for arrays; **Yjs 14 removes it** — Bartosz Sypytkowski (Yjs/Yrs maintainer) explains why and recommends fractional-index `ord` attributes with `clientID` tie-breaks instead: <https://www.bartoszsypytkowski.com/replacing-yjs-move-feature/> (2026-05-14).
- How outliners do trees on Yjs: a `Y.Map<blockId, Y.Map{parent, order, text: Y.Text}>` with LWW parent + fractional order, and hand-written cycle handling (Evan Wallace's read-time reattach: <https://madebyevan.com/algos/crdt-mutable-tree-hierarchy/>). y-prosemirror is a rich-text binding, not a tree solution (it represents the doc as `XmlFragment`; nested structure = nested `XmlElement`, moves are delete+insert, so concurrent moves duplicate).
- v14 adds attribution ("who wrote what"), `lib0/delta`-based deltas, `AttributionManager`; `Y.Doc` API otherwise similar. Ecosystem: `y-websocket` 3.1.0 (2026-08-06), `y-prosemirror` 1.3.7 (2025-07), `y-indexeddb` 9.0.12 (**last published 2023-11**; works but unmaintained).
- Verdict: smallest and most battle-tested, but it does *not* solve the two hard problems you have (tree moves, ordered siblings) and its state is opaque. Good fit only if you want rich-text co-editing via Tiptap/BlockNote and are happy to hand-roll tree semantics.

### 2.2 Automerge 3
- 3.0 shipped July 2025 (memory −10×, same file format): <https://automerge.org/blog/automerge-3/>. 3.4.1 current.
- **No movable tree / move op.** Issues still open: #352 "Moving objects inside and between lists" (2022), #1242 "nested tree type" (Dec 2025). The Kleppmann/Da "Extending JSON CRDTs with Move Operations" work (2024, <https://martin.kleppmann.com/2024/04/22/json-crdt-move.html>) says it "plans to integrate" into Automerge; nothing has landed.
- `@automerge/automerge-repo`'s `latest` dist-tag is **2.6.0-alpha.3** (2026-08-07); `@automerge/automerge-repo-sync-server` is 0.2.8 from **2024-07**. Repo layer is in flux (tags: `subduction`, `authors`).
- Verdict: no tree, alpha repo layer, biggest wasm. Not a fit.

### 2.3 Loro
- 1.16.1 (2026-09-10), MIT, Rust core with wasm/JS, Swift, Python bindings. Repo 6.1k stars, 53 open issues. Data format stabilized at 1.0 ("no breaking changes").
- **Movable tree with correct semantics**: implements Kleppmann et al. *A highly-available move operation for replicated trees* (2021, <https://martin.kleppmann.com/papers/move-op.pdf>) — all ops totally ordered by Lamport timestamp, out-of-order arrival handled by undo-do-redo, an op that would create a cycle is recorded but has no effect. Sibling order via **fractional index** (fork of drifting-in-space `fractional_index`, base-256, PeerID tie-break, optional jitter `doc.setFractionalIndexJitter(n)`; jitter 2 bytes ≈ 37 concurrent same-position inserts at 99 %). Details: <https://loro.dev/blog/movable-tree> (2024-07) and tree docs (`pages/docs/tutorial/tree.mdx` in loro-dev/loro-docs). Bench: 10k random moves in 28 ms, 1000 version checkouts in 153 ms (M2 Max).
- Also: `LoroText` (Peritext-style rich text), `LoroMovableList` (Kleppmann list-move), `LoroMap`, counters; **shallow snapshots** to drop old history (<https://loro.dev/docs/concepts/shallow_snapshots>; caveat: peers behind the shallow point cannot sync); `import()` returns `{success, pending}` version ranges; 1.14.1 made `importBatch` atomic; 1.16 added bulk readers (`toContainerTree()`), `ensureMergeableList/Text` (needed because two offline peers lazily creating a child container under the same map key otherwise converge to *one* visible child and hide the other — a real gotcha for "text container per block" models).
- A 2026 release note documents a fixed **movable-tree convergence bug** (incremental tree state could diverge from a full oplog replay when imports were concurrent with part of a multi-head frontier). It was fixed, but it is a reminder that the tree is the most intricate part of the library and you would be relying on their fuzzers.
- Gotchas: tree node IDs are Loro `TreeID`s (`peer@counter`), so your block UUID lives in `node.data`; `enable_fractional_index` must be turned on; fractional index has interleaving (acceptable for outlines); wasm is 1.07 MB gz (cached by the SW after first load, but it is a real cost on mobile); whole-doc-in-memory model.
- Sync/server: see §3.3.
- Verdict: the only library that natively gives you the block-tree semantics you need. Its cost is the in-memory document model + 1 MB wasm + opaque state + a young protocol layer.

### 2.4 Diamond types / Eg-walker
- Joseph Gentle's diamond-types: fastest text CRDT, Rust, "WIP"; JS packages unpublished since 2023. Text-only (no list/map/tree). Loro already uses the Eg-walker idea internally. Not a candidate.

### 2.5 Which has a correct native movable tree?
**Only Loro.** Yjs: no (and removed the list-move it had). Automerge: no. Everything SQL-based (cr-sqlite, Evolu, TinyBase, Electric, PowerSync, Zero…): no — you write tree semantics yourself on top of LWW columns.

---

## 3. Sync servers / frameworks

### 3.1 Yjs servers
| | Version | Status |
|---|---|---|
| `y-websocket` | 3.1.0 (2026-08-06) | reference server, in-memory + leveldb persistence hooks |
| `@hocuspocus/server` | **4.7.0** (2026-09-09), MIT, Tiptap | v4 stable May 2026; runs on Node/Bun/Deno/CF Workers; hooks for auth/storage; v3⇄v4 providers interoperate. Healthy. |
| `y-sweet` (Jamsocket) | 0.9.1 (2025-09-16); repo last push 2025-12-04 | Rust, S3-backed; activity slowing |
| `partyserver` / `y-partyserver` | 0.5.10 (2026-08-03) | Cloudflare-Durable-Objects only (PartyKit was acquired by Cloudflare in 2024; `partykit` npm 0.0.115, 2025-05) |

### 3.2 Automerge
`automerge-repo` 2.6.0-alpha.3 + `automerge-repo-network-websocket`; sync server 0.2.8 (2024). Alpha. Not recommended.

### 3.3 Loro protocol
- <https://github.com/loro-dev/protocol> (MIT): `loro-protocol` 0.3.0 (2025-12-08), `loro-websocket` 0.6.2 (2026-01-04), `loro-adaptors` 0.6.1; Rust client + `loro-websocket-server` with optional SQLite snapshotting. Announced 2025-10-30 (<https://loro.dev/blog/loro-protocol>) as "mostly stable".
- Wire spec (`protocol.md`): 4 magic bytes (`%LOR`, `%EPH`, `%EPS`, `%ELO`, `%YJS`, `%YAW`), room id, msg type; multiplexes many rooms on one socket; 256 KiB max message with fragmentation; `JoinRequest(version vector)` → `JoinResponseOk(server version)` → missing updates; `Ack` per batch; `RoomError` eviction. **"It does not address collection-level synchronization"** — i.e. if you have a doc per page you must build the "which docs changed" layer yourself (AFFiNE-style root doc).
- `SimpleServer` (Node) is explicitly "for local testing": in-memory rooms, `onLoadDocument/onSaveDocument` snapshot hooks on a `saveInterval`. Fine as the seed of a home server; you would add SQLite persistence of updates (Loro's own guidance: snapshot periodically + append updates).
- E2EE (`%ELO`) is experimental.
- Third-party: `@loro-extended/repo` 5.4.2 (2026-02-11, SchoolAI) — an automerge-repo-like layer (schemas, IndexedDB persistence, SSE/WS/WebRTC adapters, Postgres storage). Small community; nice reference code.

### 3.4 SQLite-centric engines
| | Version | Fit |
|---|---|---|
| **cr-sqlite** (vlcn.io) | last release **v0.16.3 (2024-01-17)**; `@vlcn.io/crsqlite-wasm` 0.16.0 (2023-12); 2026 commits are only platform build fixes (Aug 2026: Android 16 KB pages, Windows ARM64, iOS sim) | Column-level LWW + causal length as a loadable extension — the right *idea*, but the wasm/browser package is stale and the project is effectively in maintenance. Do not depend on it. |
| **Evolu** | `@evolu/common` 8.10.0 (2026-09-06), very active; relay = `@evolu/relay` / `evoluhq/relay` Docker, stateless, SQLite | SQLite + timestamp-based CRDT + E2EE + owners. Row/column LWW only; no tree/text CRDT; opinionated stack (own Result/Type/DI libs). Its **protocol docs are worth reading** for the timestamp/range-based reconciliation design. |
| **TinyBase** | 9.7.0 (2026-09-02) | `MergeableStore`: per-cell HLC + hash tree, LWW. SQLite persisters only support mergeable data in JSON mode (not tabular). No ordering/text CRDT. A good "how to do HLC + hash-tree sync in TS" reference. |
| **ElectricSQL** | `@electric-sql/client` 1.5.28 (2026-09-09); PGlite 0.5.8 | Postgres → client "shapes" read-path sync; writes via your API. Requires Postgres. Pairs with TanStack DB 0.8.7. Wrong shape for "replicate whole graph to SQLite". |
| **PowerSync** | `@powersync/web` 2.3.1 (2026-09-10) | Client SQLite ⇄ Postgres/MongoDB/MySQL through the PowerSync service (open edition self-hostable). Requires a Postgres-class backend + their service. Overkill. Their May-2026 web-persistence write-up is the best current OPFS reference (§4). |
| **Zero (Rocicorp)** | `@rocicorp/zero` 1.9.0 (2026-08-14); 1.0 in June 2026 | zero-cache + **Postgres required**; server-authoritative mutators + client rebase. Replicache is archived (`replicache` 15.3.0, 2025-07; repo archived). |
| **Triplit** | 1.0.50 (2025-07-31), AGPL; acquired by Supabase 2025; repo last push 2026-01 | Stalled. |
| **InstantDB** | `@instantdb/core` 1.0.67 (2026-08-31) | Active; self-host = Clojure backend + Postgres. Hosted-first. |
| **Jazz** | `jazz-tools` 0.20.19 (2026-07); 2.0.0-alpha | CoJSON CRDTs, E2EE, hosted-first. Framework lock-in. |
| **Dexie Cloud** | dexie 4.4.5 / dexie-cloud-addon 4.4.14 | Proprietary server. |

### 3.5 "Oplog + HLC + per-field LWW in SQLite" (hand-rolled)
- Reference: James Long, *Using CRDTs in the wild* (Actual Budget): <https://archive.jlongster.com/using-crdts-in-the-wild>. Messages `(dataset, row, column, value, hlc)`; `messages_crdt` table; apply if `hlc > stored hlc`; Merkle trie over HLCs to find the divergence point; **server ~300 lines** that just stores/forwards messages. Limitations he calls out: no ordered lists/text, schema evolution, message volume, "you can't assume anything about the state".
- Annotated example app: <https://github.com/clintharris/crdt-example-app_annotated>.
- HLC format used by Actual: `2019-06-03T16:40:53.876Z-0000-9f66d38cba0ef956` (wall ms – counter – node id), string-collatable, drift guard ~1 min.
- This is the pattern I recommend, with two additions Actual doesn't need: fractional-index ordering (`fractional-indexing` 4.0.0, 2026-06-25, Rocicorp) and server-validated tree moves.

---

## 4. Client-side storage on web / mobile (2025-26 reality)

Sources: SQLite persistence doc <https://sqlite.org/wasm/doc/trunk/persistence.md>; PowerSync "SQLite persistence on the web, May 2026" <https://powersync.com/blog/sqlite-persistence-on-the-web>; WebKit storage policy <https://webkit.org/blog/14403/updates-to-storage-policy/>; MDN browser-compat data for `FileSystemSyncAccessHandle`; Apple dev forum thread 710157.

| Option | Version | Browser support | Notes |
|---|---|---|---|
| `@sqlite.org/sqlite-wasm` (official) | 3.53.4-build1 (2026-09-08) | OPFS VFS: Chrome 102+, **Safari 17+**, FF 111+; `opfs-sahpool`: Safari 16.4+ | `opfs` VFS needs COOP/COEP + SharedArrayBuffer + a worker and gives multi-tab with lock retry. `opfs-sahpool` needs **no headers**, is faster, but **one connection at a time** (you must do leader election with Web Locks and proxy other tabs to the leader). Safari < 17 sub-worker bug breaks the `opfs` VFS. |
| `wa-sqlite` (rhashimoto) | GitHub **v1.1.2 (2026-08-11)**, MIT; npm `wa-sqlite` 1.0.0 is stale (2024) — install from GitHub | `OPFSCoopSyncVFS`: Chrome 108+, Safari 16.4+, FF 111+; `OPFSWriteAheadVFS` (Apr 2026): Chrome 121+ only (`readwrite-unsafe`); `IDBBatchAtomicVFS`: Chrome 69+, Safari 15.4+, FF 96+ | PowerSync's pick: `OPFSCoopSyncVFS` = "best balance"; multiple connections across tabs (cooperative, not concurrent transactions; handle `SQLITE_BUSY`). IDB VFS degrades >100 MB. |
| IndexedDB (Dexie 4.4.5) | | everywhere | Fine for the oplog and pending queue; poor for FTS/backlink queries at 100k rows. |
| `y-indexeddb` | 9.0.12 (2023-11) | | Only relevant with Yjs; unmaintained. |

iOS / Android specifics:
- **OPFS + sync access handles do work on iOS Safari** (BCD: Safari 15.2+, iOS mirrors desktop). Two summaries I hit claimed "no OPFS on iOS"; the compat data and SQLite's own doc (which only warns about Safari < 17) contradict that. Practical floor: iOS 17.
- **Quota (Safari 17+)**: one pool per origin shared by IndexedDB, Cache, OPFS, localStorage, SW; up to ~60 % of disk in Safari (15 % for non-browser WKWebView apps); LRU eviction under storage pressure or long inactivity; `navigator.storage.persist()` is granted "based on heuristics like whether the website is opened as a Home Screen Web App".
- **ITP 7-day script-writable storage deletion**: applies to sites visited in Safari that go 7 days of Safari use without interaction. **Home-screen (installed) web apps are exempt** — they have their own days-of-use counter and "the first-party storage in such a web application is not expected to have its website data deleted" (WebKit tracking-prevention docs; confirmed by Apple forum thread 710157). Desktop Safari has no install path, so desktop Safari users remain subject to it.
- Android Chrome: OPFS solid; `persist()` normally granted for installed PWAs; Chrome incognito caps OPFS DBs at ~100 MB.
- Field reports of "OPFS wiped" on desktop were traced to Windows Storage Sense / cleaner tools and missing `persist()` (sqlite forum 542fba6a46cec787). PowerSync notes iOS/Capacitor can close access handles when backgrounded — reopen on `SQLITE_IOERR`.
- **Design consequence**: treat client storage as a cache that can vanish. The home server is the source of truth, pending ops are pushed within seconds, and a client can always re-bootstrap from a server snapshot. Prompt to "Install app", then call `persist()`.
- Multi-tab: run SQLite in one dedicated worker; other tabs proxy via `BroadcastChannel` + Web Locks leader election (Logseq does master/slave workers; PowerSync does the same). SharedWorkers cannot open OPFS in Chrome/Safari.

---

## 5. How comparable apps do it

| App | Sync design | Conflicts | Takeaway for nooklet |
|---|---|---|---|
| **Logseq DB (2.0 beta, July 2026)** | SQLite-wasm in OPFS worker + in-memory DataScript; RTC over WebSocket; a `client-ops` SQLite DB records local tx history; ops pushed with throttling; remote ops applied via outliner ops; server = Cloudflare Worker + D1 (prod) **or a Node adapter with SQLite** (`deps/db-sync`, self-host; PR #13117 adds a no-Cognito token mode, open Aug 2026) | **Rebase**: remote applied first, then pending local txs replayed on top; if a conflict/large divergence, throw and do a **full graph pull** | Closest to your shape. Hub server, op log, rebase-on-conflict, full-pull escape hatch. Also: syncing the SQLite file itself corrupts graphs (WAL + per-device state) — never do file-level sync. |
| **Actual Budget** | HLC-stamped per-field messages in SQLite; Merkle trie for divergence; tiny relay server | LWW by HLC | The simplest proven CRDT-in-SQLite. Your base. |
| **Obsidian Sync** | Per-file versions on a remote vault | `.md`: automatic **3-way merge with diff-match-patch**; others: last-modified wins; since 1.9.7 user can choose "create conflict file" | 3-way text merge on collision is cheap and good enough for a single user's notes. |
| **Joplin** | Per-item (note/notebook/tag/resource) upload within seconds, poll download every few minutes; `sync_items` table with `sync_time`; targets: Joplin Server/Nextcloud/WebDAV/FS | Conflict notes on concurrent edits; 2026 GSoC work on better conflict handling | Item-level "changed since" sync over dumb storage works but breeds conflict copies. |
| **SilverBullet 2.10** | Sync mode replicates all files to the client; server is a "dumb data store" | **No merging; conflicted copies**; users still report conflicts after offline periods (2026) | What to avoid. |
| **SiYuan** | `dejavu`: git-like content-addressed chunk snapshots, E2EE, pushed to S3/WebDAV/SiYuan cloud | Snapshot-level; latest wins with history kept | Great for backup/versioning, not for live multi-device editing. |
| **Anytype** | `any-sync`: per-object DAG of signed changes (protobuf), Go node types (sync/file/consensus/coordinator) | CRDT merge of change trees | Heavy multi-service infra; over-engineered for one dev. |
| **AFFiNE** | Yjs doc per page + workspace root doc (subdocs), `y-octo` Rust Yjs impl, Socket.io + Redis | Yjs merge | Shows the "collection of docs" plumbing you'd have to build with Yjs/Loro. |

Closest to "simple + robust for a block tree": **Actual's op model + Logseq/Figma's hub-validated structure + Obsidian's 3-way text merge.** That combination is the recommendation below.

---

## 6. Recommended architecture (design sketch)

### 6.1 Principles
1. **Every write anywhere is an op.** Devices, the HTTP API, MCP tools, the markdown importer/mirror, and the embeddings job (which only reads) all go through `applyOps(ops, source)`.
2. **State tables are a pure function of the oplog** — `rebuild()` (drop state, replay ops in `server_seq` order) must reproduce the same state. Test it constantly.
3. **Per-field LWW by HLC**; the server additionally validates tree structure and emits corrective ops.
4. **Server order (`server_seq`) is the sync cursor**; HLC is the conflict clock. Keep both.

### 6.2 Schema (identical on server and client; SQLite)

```sql
-- ids are UUIDv7 (time-ordered, sortable) generated by the creating device.
CREATE TABLE page (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,          -- "a/b/c" namespaces are just names split on '/'
  name_lc       TEXT NOT NULL,          -- unique among non-deleted
  props         TEXT NOT NULL DEFAULT '{}',   -- JSON, LWW as a whole OR per key (see ops)
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,                -- tombstone
  -- per-field clocks (HLC strings) for LWW
  name_hlc      TEXT NOT NULL,
  deleted_hlc   TEXT
);

CREATE TABLE block (
  id            TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL,          -- denormalized root; a top-level block has parent_id = NULL
  parent_id     TEXT,                   -- NULL = top level of page
  pos           TEXT NOT NULL,          -- fractional index among siblings (base-62 string)
  text          TEXT NOT NULL DEFAULT '',
  props         TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  -- clocks: one per independently-mergeable field
  place_hlc     TEXT NOT NULL,          -- covers (page_id, parent_id, pos) as ONE field
  text_hlc      TEXT NOT NULL,
  deleted_hlc   TEXT
);
CREATE INDEX block_parent ON block(parent_id, pos);
CREATE INDEX block_page   ON block(page_id);

CREATE TABLE block_prop (               -- per-key LWW for properties (cheaper than whole-JSON LWW)
  block_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, hlc TEXT NOT NULL,
  PRIMARY KEY (block_id, key)
);

-- derived, rebuilt from text (never synced):
CREATE TABLE ref (src_block TEXT, dst_page TEXT, kind TEXT);   -- [[page]] / #tag / ((block)) links
CREATE VIRTUAL TABLE block_fts USING fts5(text, content='block', content_rowid='rowid');

-- the oplog
CREATE TABLE op (
  server_seq  INTEGER PRIMARY KEY,      -- assigned by the server on accept (NULL/absent on client pending)
  id          TEXT NOT NULL UNIQUE,     -- "<hlc>" is already unique (wall-counter-device)
  hlc         TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- see 6.3
  entity      TEXT NOT NULL,            -- block id / page id
  payload     TEXT NOT NULL,            -- JSON
  status      TEXT NOT NULL DEFAULT 'applied'   -- 'applied' | 'rejected' | 'noop' (older than current)
);

-- client only
CREATE TABLE pending_op (id TEXT PRIMARY KEY, hlc TEXT, kind TEXT, entity TEXT, payload TEXT);
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);   -- server_cursor, device_id, hlc_last

-- server only
CREATE TABLE device (id TEXT PRIMARY KEY, name TEXT, last_seen INTEGER, acked_seq INTEGER);
CREATE TABLE embed_dirty (block_id TEXT PRIMARY KEY, enqueued_at INTEGER);
CREATE TABLE embedding (block_id TEXT, model TEXT, content_hash TEXT, vec BLOB, PRIMARY KEY (block_id, model));
```

Why `(page_id, parent_id, pos)` is one field with one clock: a move is one atomic intent. If they had separate clocks, a concurrent "move to page B" and "reorder within page A" could combine into a nonsense location.

### 6.3 Op format

```ts
type Op = {
  id: string;            // == hlc; globally unique
  hlc: string;           // "2026-09-10T12:34:56.789Z-0003-a1b2c3d4" (ms wall, 4-hex counter, device)
  device: string;
  kind:
    | 'page.create'   // {id, name, created_at}
    | 'page.rename'   // {name}
    | 'page.delete'   // {deleted_at | null}      (null = restore)
    | 'block.create'  // {id, page_id, parent_id, pos, text, props, created_at}
    | 'block.place'   // {page_id, parent_id, pos}  -- move and/or reorder
    | 'block.text'    // {text}                     -- whole-text LWW (v1)
    | 'block.prop'    // {key, value | null}
    | 'block.delete'; // {deleted_at | null}
  entity: string;
  payload: Record<string, unknown>;
  // reserved for upgrades (ignored by v1 peers):
  // 'block.text.patch' {base_hash, diff}   (v1.1 three-way merge sends a full text anyway)
  // 'block.text.crdt'  {bytes}             (v2 Loro/Yjs text update per block)
};
```

HLC (≈40 lines): `now = max(wallMs, last.wall)`; `counter = (now == last.wall) ? last.counter+1 : 0`; on receive, `last = max(last, remote)` and bump counter; reject a remote HLC more than 60 s ahead of local wall clock (Actual's rule) — surface as a "device clock is wrong" error rather than silently accepting it.

### 6.4 Apply rules (`applyOps`, identical code on both sides)

```
for op in ops (server: in arrival order; client: in server_seq order for pulled ops):
  switch op.kind:
    block.create : INSERT OR IGNORE (idempotent; if it already exists treat as place+text with op.hlc)
    block.text   : if op.hlc > row.text_hlc  → set text, text_hlc; mark refs/fts dirty; (server) enqueue embed
    block.prop   : if op.hlc > prop.hlc      → upsert
    block.delete : if op.hlc > row.deleted_hlc → set deleted_at (null restores)
    block.place  : if op.hlc > row.place_hlc:
                     SERVER ONLY: if payload.parent_id is op.entity or a descendant of op.entity
                                  (walk parent chain, ≤ depth) → mark op 'rejected';
                                  emit corrective op {kind:'block.place', entity, payload: current place,
                                                      hlc: server.hlc.next(), device:'server'}
                                  and continue
                     set (page_id,parent_id,pos), place_hlc
    page.*       : same shape
  record op in `op` (status applied/noop/rejected)
```

Convergence argument: every field is an LWW register keyed by HLC, so any two replicas that have seen the same set of ops agree on every field. Structure validity is not guaranteed by LWW alone, but *all* ops flow through the server, which is a single sequential validator; any client-visible cycle is transient and is repaired by a corrective op whose HLC is strictly newer than the op that caused it (the server's HLC has already absorbed that op's HLC). This is the Figma model; Loro's tree exists precisely for the P2P case where no such validator exists, which you do not have.

Renderer rule (client): when materializing a page tree, if walking `parent_id` hits a cycle or a missing parent, render those blocks under an "Unplaced" pseudo-node at the page's end. In practice this appears only for the round-trip time of a genuinely concurrent A↔B move.

Delete-vs-move: independent fields; the block ends up tombstoned at its new location (restorable). Ancestor deleted vs descendant moved out: descendant survives (its parent is live). Ancestor deleted with descendants untouched: descendants stay attached and hidden; restoring the ancestor restores them — same UX as Kleppmann's TRASH.

Sibling order: `pos` via `fractional-indexing` (`generateKeyBetween(a, b)`). Concurrent inserts between the same neighbors get keys that may be equal or interleaved; equal keys are ordered by block id (deterministic). Rebalance: when a page's max key length > 40, the server emits `block.place` ops re-keying that sibling list (it is just LWW; happens rarely).

Text collision (v1): LWW by HLC. (v1.1): before a client applies a remote `block.text` to a block that has a *pending* local `block.text`, run `diff3/diff-match-patch(base = text as of last server-confirmed version (keep it in pending_op), mine, theirs)`; if it merges cleanly, emit a new `block.text` with the merged text (new HLC, so it wins everywhere) — else keep LWW and add a `props.conflict_copy` with the loser. This yields "both edits kept" for the common two-device case with zero CRDT.

### 6.5 Sync protocol (HTTP + WebSocket "poke"; Replicache pattern)
- `POST /sync/push` `{device, ops[]}` → server `applyOps` in a single transaction, assigns `server_seq`, returns `{accepted:[{id, server_seq}], rejected:[{id, reason}], corrections:[ops]}` and pokes all other devices over WS.
- `GET /sync/pull?since=<server_seq>&limit=5000` → `{ops[], cursor}` (ops with `status='applied'` only, includes server-authored ops). Client applies in order inside one transaction, advances `sync_state.server_cursor`, drops any `pending_op` whose id appears (already accepted).
- `GET /sync/snapshot` → streamed rows of the state tables (with their HLC columns) + `cursor`. Used for first install and for the "full pull" escape hatch (Logseq does this too).
- WS: `{type:'poke', seq}` only; presence/awareness later on the same socket. Push runs on a 300 ms debounce and on `online`/visibility events; pull on poke and on reconnect. Both are idempotent, so retries are safe. Everything works through a service worker/Background Sync as a bonus.
- Auth for a single user: a device token issued by the server (QR/pairing link, like Logseq's local-token PR). Later: multi-user = per-graph membership; no protocol change.
- Client crash safety: `pending_op` rows are written in the same SQLite transaction as the local state change, so nothing is ever lost between "applied locally" and "pushed".
- Oplog retention: server keeps everything (100k ops ≈ 20–40 MB). Optional GC: delete ops with `server_seq < min(device.acked_seq)` after a snapshot, since any newer device bootstraps from the snapshot.

### 6.6 Server-side writes (HTTP API, MCP)
```ts
// packages/server/src/api/blocks.ts
router.post('/blocks', async (req) => {
  const ops = plan.insertBlock(req.body);       // pure planner: turns intent into ops, using server HLC + device:'server'
  const res = await applyOps(ops, { source: 'api' });
  poke(); return res;
});
```
MCP tools are thin wrappers over the same planners. Because the server is the validator, API writes can never be "rejected" — they are applied in order like anyone else's. Reads for LLMs come from the state tables + FTS + embeddings.

### 6.7 Markdown files on disk
- **Files are never the sync medium.** They live only on the server's disk (`$DATA/pages/<name>.md`), produced and consumed by the server.
- Export (mirror out): on `applyOps` touching a page, debounce 500 ms, render the page tree to Logseq-flavoured markdown (`- ` bullets, 2-space/tab indent, `key:: value` property lines). Write **`id:: <uuid>`** on every block (loss-free round trip; Logseq itself only writes it for referenced blocks, which forces content-matching heuristics on import — avoid that). Write atomically (temp file + rename) and record `{path, content_hash}` in `mirror_file` so the watcher can ignore its own writes.
- Import (mirror in): `chokidar` watch; on change, parse → block list with ids (generate for blocks without `id::`, and immediately rewrite the file with ids) → diff against the current tree → emit `block.create/place/text/prop/delete` ops with the server HLC → `applyOps`. The diff is per block id, so a file edit becomes a handful of ops, not a page replace. The sync state cannot be corrupted because nothing ever bypasses the oplog.
- Conflict semantics: file edit vs device edit on the same block = LWW by HLC (file edit gets the HLC of the moment the watcher fires). Ping-pong is prevented by the content-hash echo check. Document the rule "the mirror is last-writer-wins; don't edit the same block in vim and on your phone simultaneously".
- One-shot import/export of a Logseq graph is the same code with the watcher off.

### 6.8 Embeddings (Ollama)
- `applyOps` enqueues `embed_dirty(block_id)` whenever `text` changes or a block is created/undeleted; `block.delete` deletes the embedding.
- A single server worker drains the queue with a concurrency of 1–2: `hash = sha256(model + text)`; skip if `embedding.content_hash == hash`; otherwise call Ollama `/api/embed`, upsert. Store vectors as BLOB (float32) and do brute-force cosine in JS for ≤ 200k blocks, or `sqlite-vec` if you want ANN. Nightly reconcile: enqueue any block whose hash ≠ stored hash.
- Embeddings are server-only state (not synced) — semantic search is an API/MCP call. This keeps client storage small and avoids syncing megabytes of vectors to phones.

### 6.9 Client runtime
- `worker/db.ts`: wa-sqlite + `OPFSCoopSyncVFS` (fallback `IDBBatchAtomicVFS`); all queries through the worker (Comlink). One writer tab elected with `navigator.locks`.
- Reactive UI: query invalidation by table (or TanStack DB collections fed from the worker) — no engine needed.
- Bundle: SQLite wasm ~1 MB raw (~400 KB gz) — the only wasm you ship in v1.

---

## 7. Simplest viable v1 → upgrade path

**v1 (weeks, not months):**
1. Schema + `applyOps` + HLC + fractional index + server cycle check + corrective ops.
2. `push/pull/snapshot` + WS poke + device token pairing.
3. wa-sqlite worker on the client, pending queue, `rebuild()` and a fast-check property test: N simulated devices, random ops (create/move/reorder/edit/delete) with random partitions; after full sync assert (a) all replicas' state tables are byte-identical, (b) no cycles, (c) replaying the server oplog from empty reproduces the state.
4. Server: API + MCP + markdown export/import (one-shot) + embeddings queue.

**v1.1:** 3-way text merge on collisions; continuous markdown mirror with watcher; op GC; presence.

**v2 (only if wanted):** per-block text CRDT for live co-editing. Add `block.text.crdt` ops carrying Loro (`LoroDoc` with a single `LoroText`; ~2–4 KB snapshot per block) or Yjs update bytes; the server keeps the plain text column updated from the CRDT (Node runs the same library). Because the oplog is extensible and clients that don't understand a kind just ignore it, there is **no data migration**; blocks without CRDT bytes keep LWW. Alternatively, switch wholesale to a Loro whole-graph doc by generating it from the state tables — ids are data, so nothing is lost. You are not painting yourself into a corner.

---

## 8. Alternatives and trade-offs

### A. "Start with Loro and never migrate" (strongest alternative)
Sketch: one `LoroDoc` per graph: `tree = doc.getTree('blocks')` (pages are root-level nodes, blocks nested; cross-page move = tree move), `node.data = {id, text: LoroText (via ensureMergeableText), props: LoroMap, deleted}`; `doc.subscribe` events drive a derived SQLite (state tables, FTS, refs, embed queue) on both client and server; persistence = periodic `snapshot` + appended `update` bytes in OPFS/SQLite (Loro's documented pattern), shallow snapshots to bound history; sync via `loro-websocket` (client) + `SimpleServer` extended with SQLite storage of updates; server API/MCP mutate the server's in-memory `LoroDoc` and broadcast; markdown import diffs into tree/text ops.

Pros: correct concurrent tree moves *and* character-level text merge from day one, real-time co-editing, history/version checkout for free, one dependency does the hard part, MIT throughout, very active maintainer.
Cons/risks: +1.07 MB gz wasm on mobile; the whole graph is an in-memory Loro doc on every device (Loro's LSM snapshot format supports lazy load, but 100k blocks × (map + text container) memory on a phone is unproven — you would need to measure early); two representations to keep consistent (Loro + SQLite); `loro-protocol`/`loro-websocket` are 0.x with a tiny community and explicitly no collection-level sync (fine for one-doc-per-graph, painful for doc-per-page); opaque state (debug via `doc.toJSON()`/`getDeepValueWithID`, not `SELECT`); the tree code has had at least one convergence bug fixed in 2026; E2EE experimental. Pick this if live multi-user collaboration is a first-class goal.

### B. Yjs (`Y.Map` of blocks + `Y.Text`) + Hocuspocus 4 + y-indexeddb
Pros: 63 KB, huge ecosystem, Hocuspocus is healthy, Tiptap/BlockNote bindings if you want rich text.
Cons: you still hand-roll tree semantics (LWW parent + fractional `ord` + cycle repair) — exactly the part that is hard — but now inside an opaque doc; Yjs 14 is imminent with breaking changes and `move` removed; y-indexeddb unmaintained; whole-doc-in-memory like Loro without Loro's tree. Only worth it if the editor is Tiptap/BlockNote-based and you want their collab plugins.

### C. Adopt a SQLite sync engine
- cr-sqlite: right model, stale packages → no.
- Evolu: closest ready-made match (SQLite + E2EE + relay), but no tree/text semantics and you inherit its framework; consider only if you also want its E2EE/owner model.
- PowerSync/Electric/Zero: need Postgres (+ a service); the home server becomes a Postgres box; whole-graph replication is not their sweet spot → no.

### D. Logseq-style server-ordered ops with client rebase
Same as the recommendation but *without* HLC: conflict = last-synced-wins, clients rewind pending ops and replay on every incoming batch. Slightly less code on the server, noticeably more on the client (inverse ops), and worse UX for offline edits (an older offline edit overwrites a newer online one). HLC LWW is ~50 extra lines and fixes that; keep HLC.

---

## 9. Risk list

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| Hand-rolled sync bug (lost update, divergence) | medium / high | Property-based simulation tests from day one; `rebuild()` parity check in CI; op status audit trail; "full pull" escape hatch. |
| Device clock badly wrong → LWW picks the wrong winner | low / medium | HLC drift guard (reject > 60 s ahead; warn user); HLC merges on every pull so all devices converge on the max clock. |
| Transient cycles / corrective ops confuse users | low / low | "Unplaced" pseudo-node; corrections arrive within one RTT; log every correction. |
| Fractional-index key growth / interleaving | low / low | Server-side re-key when max length > 40; interleaving is acceptable for outlines (Loro makes the same call). |
| Op log growth, slow bootstrap | medium / low | Snapshot endpoint; GC below min acked seq; snapshots are just table dumps. |
| Schema evolution | certain / medium | Additive-only ops; unknown `kind` ignored; `payload` JSON; server tolerates N−1 clients. |
| iOS storage eviction / private mode / backgrounding | medium / medium | Install-prompt + `persist()`; server is the truth; push within seconds; reopen DB on IOERR; IDB fallback. |
| Multi-tab SQLite contention | medium / low | Single writer worker, Web Locks election, `SQLITE_BUSY` retry. |
| Markdown mirror ping-pong or lossy round-trip | medium / medium | `id::` on every block; content-hash echo suppression; canonical renderer; mirror is opt-in; LWW documented. |
| Embeddings drift from text | low / low | Content-hash keyed; nightly reconcile. |
| Wanting real-time co-editing later | medium / low | Per-block CRDT op kind (v2) or whole-doc Loro generated from state; ids preserved. |
| Dependency rot | — | v1 depends only on SQLite (wasm + better-sqlite3 13.0.3 / `node:sqlite`), `fractional-indexing`, `ws`, `chokidar`, `fast-check`. |

---

## 10. Sources

CRDT libraries
- Loro releases: <https://github.com/loro-dev/loro/releases> · npm: <https://www.npmjs.com/package/loro-crdt> · tree docs (loro-docs `pages/docs/tutorial/tree.mdx`): <https://loro.dev/docs/tutorial/tree> · movable tree article: <https://loro.dev/blog/movable-tree> · shallow snapshots: <https://loro.dev/docs/concepts/shallow_snapshots> · encoding: <https://loro.dev/docs/tutorial/encoding> · persistence: <https://loro.dev/docs/tutorial/persistence> · sync: <https://loro.dev/docs/tutorial/sync> · native bench: <https://loro.dev/docs/performance/native>
- Loro protocol: <https://github.com/loro-dev/protocol> · spec `protocol.md` · blog: <https://loro.dev/blog/loro-protocol> · loro-extended: <https://github.com/SchoolAI/loro-extended>
- Kleppmann et al., move op for replicated trees: <https://martin.kleppmann.com/papers/move-op.pdf> · JSON CRDT move (2024): <https://martin.kleppmann.com/2024/04/22/json-crdt-move.html> · Evan Wallace mutable tree: <https://madebyevan.com/algos/crdt-mutable-tree-hierarchy/>
- Yjs: <https://github.com/yjs/yjs> · npm versions: <https://www.npmjs.com/package/yjs?activeTab=versions> · Yjs 14 move removal: <https://www.bartoszsypytkowski.com/replacing-yjs-move-feature/> · FOSDEM 2026 Yjs 14 talk: <https://fosdem.org/2026/schedule/event/8VKQXR-blocknote-yjs-prosemirror/> · y-prosemirror: <https://github.com/yjs/y-prosemirror>
- Automerge 3: <https://automerge.org/blog/automerge-3/> · repo: <https://github.com/automerge/automerge> · issues #352, #1242 · automerge-repo: <https://github.com/automerge/automerge-repo>
- Diamond types: <https://github.com/josephg/diamond-types>

Sync servers / engines
- Hocuspocus 4: <https://tiptap.dev/blog/release-notes/hocuspocus-4-stable-release> · <https://github.com/ueberdosis/hocuspocus> · y-websocket: <https://github.com/yjs/y-websocket> · y-sweet: <https://github.com/jamsocket/y-sweet> · partyserver: <https://github.com/cloudflare/partykit>
- cr-sqlite: <https://github.com/vlcn-io/cr-sqlite> (releases, commits) · Evolu: <https://www.evolu.dev/> · relay docs: <https://www.evolu.dev/docs/relay> · TinyBase MergeableStore: <https://tinybase.org/guides/synchronization/using-a-mergeablestore/>
- ElectricSQL: <https://electric-sql.com/> · PowerSync vs Electric: <https://powersync.com/blog/electricsql-vs-powersync> · Zero 1.0: <https://www.infoq.com/news/2026/06/zero-version-1/> · Zero self-host: <https://zero.rocicorp.dev/docs/self-host> · Triplit: <https://github.com/aspen-cloud/triplit> · InstantDB: <https://github.com/instantdb/instant> · Jazz: <https://jazz.tools/blog/what-is-jazz>
- Actual Budget CRDT: <https://archive.jlongster.com/using-crdts-in-the-wild> · annotated example: <https://github.com/clintharris/crdt-example-app_annotated>
- Local-first 2026 survey: <https://verity.salient.community/research/local-first-software-in-2026.html>

Client storage
- SQLite wasm persistence: <https://sqlite.org/wasm/doc/trunk/persistence.md> · npm: <https://www.npmjs.com/package/@sqlite.org/sqlite-wasm> · wa-sqlite: <https://github.com/rhashimoto/wa-sqlite> · PowerSync May 2026 state of web persistence: <https://powersync.com/blog/sqlite-persistence-on-the-web> · OPFS clearing thread: <https://sqlite.org/forum/info/542fba6a46cec787>
- WebKit storage policy (Safari 17): <https://webkit.org/blog/14403/updates-to-storage-policy/> · ITP 7-day rule & home-screen exemption: <https://webkit.org/tracking-prevention/> · Apple forum on PWA persistence: <https://developer.apple.com/forums/thread/710157> · Safari 13.1 announcement coverage: <https://mjtsai.com/blog/2020/03/26/safari-13-1-third-party-cookie-blocking-and-7-day-script-writeable-storage/>
- MDN BCD `FileSystemSyncAccessHandle`: <https://github.com/mdn/browser-compat-data/blob/main/api/FileSystemSyncAccessHandle.json>
- Dexie: <https://github.com/dexie/Dexie.js> · fractional-indexing: <https://www.npmjs.com/package/fractional-indexing>

Comparable apps
- Logseq DB docs: <https://github.com/logseq/docs/blob/master/db-version.md> · DB worker & sync (DeepWiki): <https://deepwiki.com/logseq/logseq/4.1-database-worker-and-synchronization> · `deps/db-sync` README (Node adapter, SQLite driver) · self-host PRs #12919 (closed) / #13117 (open): <https://github.com/logseq/logseq/pull/13117> · 2.0 beta coverage: <https://kompozy.io/news/logseq-2-0-db-version-beta>
- SilverBullet sync: <https://silverbullet.md/Sync> · CRDT issue #1728: <https://github.com/silverbulletmd/silverbullet/issues/1728>
- SiYuan dejavu: <https://github.com/siyuan-note/dejavu>
- Anytype any-sync: <https://github.com/anyproto/any-sync>
- AFFiNE real-time sync (DeepWiki): <https://deepwiki.com/toeverything/AFFiNE/3.5-real-time-synchronization>
- Obsidian Sync conflicts: <https://deepwiki.com/obsidianmd/obsidian-help/2.3-synchronization-and-conflict-resolution> · <https://obsyncian.com/how-sync-works>
- Joplin sync spec: <https://joplinapp.org/help/dev/spec/sync/> · conflicts: <https://joplinapp.org/help/apps/conflict/>
