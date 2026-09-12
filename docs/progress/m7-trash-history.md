# M7 progress: trash/restore, history viewer, orphan-asset GC (research/13 §4.2 items 8 and 10a)

Owner agent's working record. Updated after every meaningful step so a restart can resume from
"Next steps". Read this first if it already exists.

## Done

- (uncommitted, green) Server ops `trash.list`, `trash.restore`, `page.history` in
  `packages/server/src/ops/{trash-list,trash-restore,page-history}.ts` with HTTP tests
  (26 tests), registered in `ops/index.ts`, MCP pin list updated in `mcp/server.test.ts`.
- (uncommitted, green) Orphan-asset GC: `packages/server/src/gc.ts` (`planAssetGc`, second phase
  of `runGc`, `DEFAULT_ASSET_GRACE_DAYS = 7`), 9 new tests in `gc.test.ts`, `--asset-grace <days>`
  in `cli.ts`'s `gc` case.
- (uncommitted) Web data layer `apps/web/src/data/history.ts` (own `stamped` bus, `useTrash`,
  `usePageHistory`, `restoreFromTrash`, `undoBatch`), text helpers `views/historyText.ts` + test.

## In flight

- `apps/web/src/views/TrashView.tsx` + `trash.css`: not started.
- `apps/web/src/views/HistoryView.tsx` + `history.css`: not started.
- `apps/web/src/App.tsx` route lines, `shell/Sidebar.tsx` Trash entry: not started.
- `e2e/tests/{trash,history}.spec.ts`: not started.
- Docs: ADR 019 (number confirmed free), `docs/spec/mcp-tools.md` (§4.2 rows + §4.3.24–26 + fix
  the "trash.* … expose.mcp: false" sentence), `docs/OPERATIONS.md` §6 asset GC, `docs/BUGS.md`
  B-85 (core `applyPageDelete(null)` ignores the live-name unique index) and B-86 (deduped
  re-upload of an orphaned asset records nothing, so asset GC can collect it inside the offline
  window): not started.

## Next steps (in order, one commit each)

1. Commit server trash ops (+ index.ts, mcp pin) — `feat(ops): trash.list and trash.restore`.
2. Commit `page.history` — `feat(ops): page.history`.
3. Commit asset GC — `feat(gc): orphan-asset GC with a 7-day grace`.
4. TrashView + route + sidebar entry + `e2e/tests/trash.spec.ts` → commit.
5. HistoryView + route + `e2e/tests/history.spec.ts` → commit.
6. ADR 019, spec, OPERATIONS, BUGS → commit.
7. Verify on the real-graph copy (see below); full e2e on port 6354; `pnpm -r typecheck`,
   `pnpm -r test`, biome. Report.

## Decisions (why, in short — ADR 019 has the full text)

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
  expiry. A `changes` row for the asset newer than the cutoff also extends grace (hook for B-86).
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
