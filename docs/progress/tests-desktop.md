# M10 progress — tests-desktop (B-292, B-323, B-333, B-335, B-356, B-371, B-336, B-337)

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Branch `m10/tests-desktop`, worktree `<repo>/.claude/worktrees/wf_ced35de1-fb8-4`,
based on `70c9bb9`. E2E port 6402. Bug entries go to `docs/bugs-inbox/tests-desktop.md` (new
numbers B-400..B-409), never `docs/BUGS.md`. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m10/tests-desktop/`
(`burn.sh N` / `unburn.sh` start and stop N busy node loops for "under load" runs; the machine
has 14 cores).

Brief: flaky/order-dependent tests — find the real cause, fix test or product, prove under
artificial CPU load with `--repeat-each`: B-292, B-323, B-333, B-335, B-356. Comment fix B-371.
Desktop sidecar: B-336 (user plugins cannot import `@nooklet/plugin-api`/`zod`), B-337
(`build-sidecar.mjs` ships stale `apps/web/dist`). Verify the sidecar by building and starting it
with a scratch `NOOKLET_DATA` (not the full Tauri app).

## 1. Done (committed)

- **B-292, B-335, B-356** (e2e harness) — commit "test(e2e): editing, page-icons and references
  specs survive --repeat-each and load (B-292, B-335, B-356)". New `e2e/helpers/api.ts#runName`;
  `helpers/editor.ts#openJournal` seeds today via API and scopes to `.journal-day-today`;
  `editing.spec.ts` uses the shared helpers; `page-icons.spec.ts` delays pushes and polls the
  server; `references.spec.ts` names per repeat. Probe `tools/probes/open-journal-slow-snapshot.spec.ts`.
  Proof numbers in the inbox entries (96 passed under 56 busy loops, `--repeat-each=8`).
- **B-323** (product) — commit "fix(web): top up the OPFS file pool on every start (B-323)".
  Root cause: sqlite-wasm adds pool capacity only when the pool is empty; a first start torn down
  during `addCapacity` leaves 1..5 files forever → "SAH pool is full" → SQLITE_CANTOPEN in
  `ensureSchema` → worker never starts → "Loading…". Fix `reserveMinimumCapacity(6)` in
  `apps/web/src/db/sqlite-wasm-driver.ts`; regression `e2e/tests/opfs-pool.spec.ts`; probe
  `tools/probes/page-boot-under-load.spec.ts`. New open bugs logged: B-400 (worker init failure →
  eternal "Loading…"), B-401 (workbox runtimeCaching regexes never match). Web unit 1126/1126.

## 2. In flight

- nothing (between steps).

## 3. Next steps

1. B-333 — core timing/property tests.
2. B-371 — comment.
3. B-337, B-336 — sidecar build + user plugin host modules; verify with a built sidecar.
