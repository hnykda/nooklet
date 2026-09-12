# M7 progress: trash/restore, history viewer, orphan-asset GC (research/13 §4.2 items 8 and 10a)

Owner agent's working record. Updated after every meaningful step so a restart can resume from
"Next steps". Read this first if it already exists.

## Done

- `40c054b` feat(ops): `trash.list` + `trash.restore` (+ 19 HTTP tests, `ops/index.ts`
  registration, MCP pin list).
- `fe1a197` feat(ops): `page.history` (+ 7 HTTP tests).
- `163d3b9` feat(gc): orphan-asset GC (`planAssetGc`, second phase of `runGc`,
  `DEFAULT_ASSET_GRACE_DAYS = 7`, `--asset-grace <days>` in `cli.ts`; 9 tests).
- Commits go through a PRIVATE git index (`<scratch>/commit-mine.sh` + `craft-shared.mjs`):
  other agents' ops are still untracked, so the shared `ops/index.ts` / `mcp/server.test.ts` are
  committed as "HEAD + only my hunks". After each commit: `git reset -q -- <paths>` so the shared
  index does not hold stale blobs that a bare `git commit` would revert.
- (uncommitted) Web data layer `apps/web/src/data/history.ts` (own `stamped` bus, `useTrash`,
  `usePageHistory`, `restoreFromTrash`, `undoBatch`), text helpers `views/historyText.ts` + test.

## In flight

- Written, uncommitted, being typechecked/e2e'd: `apps/web/src/views/TrashView.tsx` +
  `trash.css`, `views/HistoryView.tsx` + `history.css`, `views/historyText.ts` (+ test),
  `data/history.ts`, route lines in `App.tsx` (`/trash`, `/history/*name`), `Trash` entry in
  `shell/Sidebar.tsx`, `e2e/tests/trash.spec.ts`, `e2e/tests/history.spec.ts`.
- Commit helper is now `<scratch>/th-commit.sh` + `th-craft.mjs` (unique names: the scratchpad
  is shared and `commit-mine.sh` was overwritten by another agent).
- Docs written, uncommitted: `docs/adr/022-trash-history-retention.md` (019 was taken by
  templates after my first check — renamed), `docs/spec/mcp-tools.md` (§4.2 rows 30–32,
  §4.3.29–31, the "trash.* … expose.mcp: false" sentence fixed), `docs/OPERATIONS.md` §6.1,
  `docs/BUGS.md` B-90 (core `applyPageDelete(null)` ignores the live-name unique index) and B-91
  (deduped re-upload of an orphaned asset records nothing). Bug numbers moved twice (85/86 →
  89/90 → 90/91) as other agents logged theirs; every reference in my files was re-numbered.
- First e2e run of my two specs: 8/9 — the one failure was cross-spec trash pollution (one server
  per `playwright test` run, history.spec runs first); trash.spec now scopes rows to its page.
  Second run in progress.
- **Real-graph verification done** (`<scratch>/th-real-graph.sh`, copy of the 952-page graph,
  server on 6355): page "TODO" (111 blocks, Czech text) `page.delete` → `page.read` not_found →
  `trash.list` shows it with actor → `trash.restore {page}` un-deleted 112 entities → tree
  byte-identical to before; then `block.delete` of its first subtree (3 blocks) → one trash
  entry → `trash.restore {id}` → identical again; `page.history` reads 5 batches in words back to
  the import. `pnpm nooklet verify` OK, 20,641 ops replayed. `gc --dry-run`: 0 asset rows on the
  real graph (nothing to collect), op-log half refused (no device synced on the copy) — the asset
  half ran anyway, as designed.
- `pnpm -r typecheck` clean (repo-wide, at this moment); `pnpm -r test` 1,538 passing
  (330 + 17 + 512 + 679).

## Next steps (in order, one commit each)

1. Commit server trash ops (+ index.ts, mcp pin) — `feat(ops): trash.list and trash.restore`.
2. Commit `page.history` — `feat(ops): page.history`.
3. Commit asset GC — `feat(gc): orphan-asset GC with a 7-day grace`.
4. TrashView + route + sidebar entry + `e2e/tests/trash.spec.ts` → commit.
5. HistoryView + route + `e2e/tests/history.spec.ts` → commit.
6. ADR 022, spec, OPERATIONS, BUGS → commit.
7. Verify on the real-graph copy (see below); full e2e on port 6354; `pnpm -r typecheck`,
   `pnpm -r test`, biome. Report.

## Decisions (why, in short — ADR 022 has the full text)

- **Retention: none. The trash never expires.** `nooklet gc` never hard-deletes `page`/`block`
  tombstones (it never did; `gc.ts` only trims the `op` table). A purge would break `verify`'s
  replay parity, dangle `((refs))`, and make a late-syncing device's edit to a purged block
  undefined. The old "restorable for 30 days" wording was already struck (B-56); descriptions now
  say "no expiry".
- **What comes back with a restore:** the entities tombstoned at the same `deleted_at` instant
  as the target (every deleter — editor, `block.delete`, `page.delete` — stamps one `now` per
  action), plus never-tombstoned blocks hidden under it, plus (for a block) its tombstoned
  ancestors so it is visible. Same-millisecond separate actions merge — documented limitation.
- **"Restore this version" in the History view = `batch.undo` of every newer batch on that page,
  newest first, from the client, after a confirm.** Not atomic across batches; a batch that also
  touched another page reverts there too; each undo is its own audited batch (so the walk is
  undoable). No server-side compound op — it would re-implement `batch.undo` for no atomicity
  gain.
- **Asset orphan = no reference from any block/property, live OR tombstoned**, and older than the
  grace (7 days, `--asset-grace`). Trash-only references keep the asset because the trash has no
  expiry. A `changes` row for the asset newer than the cutoff also extends grace (hook for B-91).
- Route for history is `/history/*name`, not `/page/*name/history` — the page route is a splat,
  so `/page/X/history` would resolve as page "X/history".

## How to resume

- e2e: `cd e2e && NOOKLET_E2E_PORT=6354 pnpm exec playwright test tests/trash.spec.ts tests/history.spec.ts`
  (always port 6354; full suite: drop the file args).
- Unit: `cd packages/server && pnpm exec vitest run src/gc.test.ts src/ops/trash-restore.http.test.ts src/ops/trash-list.http.test.ts src/ops/page-history.http.test.ts src/mcp/server.test.ts`.
- Graph copy for verification (never open `~/.nooklet/default` with a `nooklet` command):
  scratch = `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/graph-copy`,
  `sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph.sqlite'"`, then
  `pnpm nooklet serve --data <scratch> --port 6355`, delete/restore through the API, then
  `pnpm nooklet verify --data <scratch>`.
- Commit with `git commit -m … -- <my paths>` (never `git add -A`); every message ends with the
  Co-Authored-By / Claude-Session trailer from the brief.
