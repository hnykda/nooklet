# @nooklet/web

M2 client foundation: Vite 8 + SolidJS 1.9 app shell, a SQLite-WASM/OPFS replica running in a
worker, the sync client (ADR 003), a `platform` adapter (ADR 005), and the one reactive data seam
every other client feature (editor, views, command palette) is meant to build on. This package
does **not** implement the editor, page/journal views, search UI, or the command palette — see the
`TODO(views)` markers in `src/routes/*.tsx`.

## Architecture at a glance

```
main.tsx ─┬─ App.tsx (router: /journals, /page/:id, /search — TODO(views) placeholders)
          │     └─ shell/AppShell.tsx (fixed shell, single scroll container, --kb, safe areas)
          │
          ├─ data/store.ts  ◄── THE SEAM: usePageTree/useJournalStream/applyOps/useSyncStatus
          │     └─ db/client.ts (Comlink.wrap, platform.lifecycle wiring)
          │           │  postMessage (async, structured-clone)
          │           ▼
          │     db/db.worker.ts  (Worker, WebWorker lib)
          │           └─ db/worker-core.ts: WorkerDb (SqlDriver-only, testable in Node)
          │                 ├─ db/sqlite-wasm-driver.ts (OPFS sahpool SqlDriver, browser-only)
          │                 └─ sync/sync-client.ts: SyncClient (SqlDriver + SyncTransport, testable)
          │                       └─ sync/http-transport.ts (fetch + WebSocket, browser-only)
          │
          └─ platform/index.ts (storage/haptics/share/deepLinks/lifecycle/keyboard adapter)
```

## The worker/driver boundary decision

`@nooklet/core`'s `SqlDriver` is deliberately synchronous (it mirrors `better-sqlite3`/`node:sqlite`
so `applyOps`/`rebuild` can be simple, testable, transactional code). A worker boundary is async.
**Resolution: the worker imports `@nooklet/core` directly and runs `applyOps`/`rebuild`/plain
queries inside itself, against a real (synchronous) `SqlDriver`.** Only the RPC surface the worker
exposes to the main thread (`db/worker-api.ts`'s `WorkerApi`) is async — that's the one place the
sync/async boundary is actually crossed, and it's exactly what
[Comlink](https://github.com/GoogleChromeLabs/comlink) (1.1 kB gz) is for: proxy generation,
structured-clone marshalling, one `Promise` per call. A hand-rolled `postMessage` protocol was
considered and rejected — it would just reimplement Comlink, at higher risk, for a dependency this
small.

This split also gives the crucial testability property: `db/worker-core.ts`'s `WorkerDb` class and
`sync/sync-client.ts`'s `SyncClient` class only ever talk to a `SqlDriver` interface. In production
that's `db/sqlite-wasm-driver.ts` (OPFS `opfs-sahpool`, browser-only, **not unit tested** — see
below). In tests it's `@nooklet/core`'s own `createNodeSqliteDriver` (real SQLite, in-memory or
file-backed) — the exact same substitution the task asked for, and it's why `worker-core.test.ts`
and `sync-client.test.ts` can test 100% of the logic with zero browser, zero Worker, zero OPFS.

**Why `opfs-sahpool` and not the `opfs` VFS**: research/08-mobile.md §1.3 and
research/03-sync.md §6.9 are explicit that the SharedArrayBuffer-based `opfs` VFS needs COOP/COEP
response headers (a deployment burden for every self-hosted install) and cannot run inside a
Capacitor/Tauri custom-scheme webview at all (no cross-origin isolation there). `opfs-sahpool`
needs neither, at the cost of "one connection per database file" — which is exactly why
`db.worker.ts` does leader election with `navigator.locks` before ever opening the database.

## The reactive data seam (`src/data/store.ts`)

This is the API surface the views/editor/command-palette agents should build against. Do not
import `src/db/client.ts` directly from view code — always go through `store.ts`.

```ts
import { usePageTree, useJournalStream, applyOps, useSyncStatus } from "./data/store.js";

// "give me this page's block tree" — a Solid Resource<PageTreeResult | undefined>
const tree = usePageTree(() => pageId());

// "give me the journal stream" — today (virtual if empty) + earlier non-empty days
const stream = useJournalStream(() => ({ today: todayJournalDay(), maxDays: 14 }));

// "apply these ops" — the ONLY way to mutate local state; builds ops with
// makeOp(client.nextHlc-equivalent, ...) — see db/worker-api.ts's WorkerApi.applyLocalOps doc
await applyOps([op1, op2]);

// optional: a live sync status signal for a status indicator
const status = useSyncStatus();
```

**Invalidation model** (kept deliberately simple): the worker fires one
`{ tables: ("page"|"block"|"block_prop"|"page_prop")[], pageIds: string[] }` event per write —
local, pulled, corrected, or bootstrapped (`db/worker-core.ts#notifyFromOps`). `store.ts` keeps one
Solid signal per table name and one per page id, and bumps whichever ones a given event names.
`usePageTree`/`useJournalStream` read (and thus subscribe to) exactly the signals their data
depends on inside their `createResource` source function, so they refetch automatically and only
on a relevant change — editing page A never refetches page B's tree. If you need a new kind of
read (search, references, tasks — all later milestones), add a new `use*` function here following
the same pattern rather than reaching for `db/client.ts#query` directly from a component.

## The sync loop (ADR 003 / research/03-sync.md §6.5)

`sync/sync-client.ts`'s `SyncClient` owns:

- **`applyLocal(ops)`** — apply to local state AND insert into `pending_op`, in one
  `driver.transaction()`. This is the only place ops are queued; crash-safety is proven in
  `sync-client.test.ts` by closing and reopening a real on-disk SQLite file between two
  `SyncClient` instances and asserting the queued op (and the persisted `device_id`) survive.
- **`flush()`** — drains `pending_op` to `POST /sync/push` in batches (debounced 300ms via
  `schedulePush()`, and called immediately on `online`/`visible`/`resume` through
  `platform.lifecycle` → `db/client.ts#initDb` → `WorkerDb#notifyLifecycle`). Removes rows the
  server decided on (accepted or rejected — the server is the sole structural arbiter either way)
  and applies any `corrections` it returns.
- **`pull()`** — pages `GET /sync/pull?since=cursor` until caught up, applying via
  `@nooklet/core`'s `applyOps` (idempotent — an already-seen op id is a no-op) and dropping any
  `pending_op` row that comes back from the server.
- **`bootstrap()`** — for a fresh replica, `GET /sync/snapshot` and inserts the rows directly
  (they already carry final per-field HLCs).
- **`connectLive()`** — wires the WebSocket poke (and reconnects) to `pull()`.
- HLC drift (ADR 003: "device clocks more than 60s ahead are rejected with a visible error") is
  checked *before* any state is written for a batch (both in `pull()` and for push corrections),
  so a drifted remote clock rejects the whole batch cleanly instead of partially applying it — see
  the dedicated drift test in `sync-client.test.ts`.

`sync/http-transport.ts` is the real fetch+WebSocket implementation, matching the protocol both
this package and the concurrently-developed `packages/server` sync endpoints target. It is thin by
design and **not unit tested** — see manual verification below.

## `platform` adapter (ADR 005)

`src/platform/`: one `Platform` interface (`types.ts`), one implementation today (`web.ts`,
exported as the `platform` singleton from `index.ts`). Every caller imports the interface + the
singleton, never `web.ts` directly — dropping in `capacitor.ts` later (native SQLite, exact
keyboard events, share-sheet receiving, `nooklet://` deep links) means implementing that file and
branching in `index.ts`, with zero changes anywhere else.

`keyboard.ts` splits the `--kb` inset math into a pure, unit-tested function
(`computeKeyboardInset`, see `keyboard.test.ts` for the 80px dead-band / iOS-26-residue /
offsetTop/rounding cases) and a DOM-wiring function that needs a real browser.

## What's stubbed for other agents

- **Views**: `src/routes/{Journals,Page,Search}Route.tsx` are placeholders marked `TODO(views)`,
  each demonstrating the one `data/store.ts` call the real view would use. Do not build on these
  directly — replace their contents.
- **Editor**: no CodeMirror surface exists; `data/tree.ts#buildBlockTree` gives the editor agent a
  ready-made nested block tree (pure, unit-tested) to render from `usePageTree`'s result.
- **Command palette / keybindings**: not started; `src/routes/SearchRoute.tsx` notes where it
  would eventually hang the palette trigger.
- **Server sync endpoints**: `sync/http-transport.ts` and `sync/types.ts` are written against
  ADR 003 / research/03-sync.md §6.5's protocol exactly, since `packages/server`'s `/sync/*` routes
  are being built concurrently against the same spec. If the real endpoints' response shapes end
  up differing, only `sync/types.ts` and `sync/http-transport.ts` need to change — every other file
  in `src/sync/` is written against the `SyncTransport` interface, not the wire format.

## Needs manual browser verification

Nothing here can be unit-tested in Node; each is structured so the surrounding logic *is* tested
(see "worker/driver boundary" above) and only the browser-specific glue is unverified:

1. `db/sqlite-wasm-driver.ts` — the actual `@sqlite.org/sqlite-wasm` OPFS `opfs-sahpool` calls
   (`installOpfsSAHPoolVfs`, `OpfsSAHPoolDb`, `exec`/`changes`/`selectValue`). The driver's *shape*
   (transaction/savepoint depth counter, `run`/`all`/`get`) mirrors `@nooklet/core`'s
   `createNodeSqliteDriver` exactly, which is tested; only the sqlite-wasm API surface itself is
   unverified.
2. `db/db.worker.ts`'s leader election (`navigator.locks`) — verify a second tab actually blocks
   rather than erroring, and that closing the leader tab releases the lock for another tab to pick
   up. **Known gap, not a bug**: a non-leader tab currently just waits forever rather than proxying
   its calls to the leader over `BroadcastChannel`; multi-tab-at-once is out of this milestone's
   scope (single tab is the primary target) and is left as a documented follow-up.
3. `platform/keyboard.ts#createWebKeyboardWatcher` — real `visualViewport` behavior on iOS Safari
   26.x specifically (the ~24px post-dismiss residue and the `position:fixed` jitter bug the dead
   band and post-blur re-measure exist to absorb, research/08-mobile.md §1.5).
4. `sync/http-transport.ts` end-to-end against the real `/sync/push|pull|snapshot|live` server
   once `packages/server`'s implementation lands.
5. PWA install/offline behavior (`vite-plugin-pwa`'s generated service worker, `public/manifest.webmanifest`)
   across Safari iOS / Chrome Android / desktop — see research/08-mobile.md §1 for the capability
   matrix (no install prompt on iOS, no background sync anywhere, etc.) this app already designs
   around rather than assumes away.
6. `navigator.storage.persist()`/`estimate()` (`platform/web.ts`) — heuristic grants, best
   verified by hand per browser.
7. Real PNG icons: `public/icon.svg` is a placeholder; the manifest references only an SVG "any"
   icon today. A design pass should add proper 192/512/maskable PNGs.

## Scripts

- `pnpm --filter @nooklet/web dev` — Vite dev server.
- `pnpm --filter @nooklet/web build` — production build (also runs the PWA service-worker
  generation step).
- `pnpm --filter @nooklet/web preview` — preview the production build.
- `pnpm --filter @nooklet/web test` — Vitest (node environment; no browser tests in this package).
- `pnpm --filter @nooklet/web typecheck` — runs `tsc --noEmit` twice: once for the main app
  (`tsconfig.json`, DOM lib) and once for `db/db.worker.ts` (`tsconfig.worker.json`, WebWorker
  lib) — the two libs can't coexist in one `tsconfig` (both declare an incompatible global `self`),
  so the worker entry point is excluded from the main project and typechecked separately. Every
  other file under `src/db/` has no DOM/WebWorker-specific globals of its own and is typechecked by
  both projects.
