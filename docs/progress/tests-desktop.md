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
- **B-333** (core tests) — commit "test(core): tokenizer budget in CPU time, property-test timeouts
  as hang guards (B-333)". Reproduced 3 of 4 with core niced under 140 busy loops.
  `tokens.test.ts`: CPU-time budget + new line-length scaling check (verified against injected
  quadratics); `sync.property.test.ts`: 120 s timeouts, numRuns unchanged. Probe
  `tools/probes/cpu-vs-wall-under-load.ts`. Core 399/399 idle and 3x under load.
- **B-371** — commit "docs(web): EditorSelection's text is the editing buffer, not the content
  (B-371)". Comment only in `apps/web/src/commands/hosts/editor-host.ts`.
- **B-337** — commit "fix(desktop): the sidecar build always builds the web client (B-337)".
  `apps/desktop/build-sidecar.mjs` step 5; probe `tools/probes/sidecar-web-freshness.mjs` (STALE at
  base, fresh after). The sidecar's Node runtime was copied from the main checkout's
  `apps/desktop/.cache` (ignored build cache) to avoid a download.

- **B-336** — commit "fix(desktop): a user's plugin can import the host modules in the sidecar
  (B-336)". `plugins/bundled.ts#packageHostModules`, `plugins/bundler.ts#hostAliasMap` prefers
  `$NOOKLET_HOST_MODULES_DIR`, `build-sidecar.mjs` step 7 + banner; tests in `bundled.test.ts`;
  probe `sidecar-user-plugin.mjs` 200/exit 0 (control without host-modules: 404). Sidecar started
  by hand on scratch `NOOKLET_DATA` (script `sidecar-manual.sh` in scratch): user op, OpError, client
  bundle, built-ins all fine. Server unit 669/669. New open bug B-402 (op without `annotations`
  crashes server at startup, dev and sidecar).

- **B-402** (new, fixed) — commit "fix(server): a plugin op missing required fields is that
  plugin's error, not a crash at startup (B-402)". `plugins/ops-bridge.ts#assertCompleteOpDef`;
  test in `host.test.ts`; server unit 670/670; checked in dev and in a rebuilt sidecar.

## 2. In flight

- Final verification (session 2, after a cut-off). Done so far: typecheck green; biome clean on all
  21 changed source files; `pnpm -r test` core 399, plugin-api 17, server 670, web 1126 — all passed.
- The first session's full e2e run (`e2e-full.txt` in scratch) was cut off at 246/527 with one
  failure, `page-title-fit.spec.ts` "Enter in the title renames…" on "Loading…" with the indicator
  "synced". Its trace is a whole-machine stall, not the app: the 10 s `toBeVisible` ran 23.9 s of
  the runner's own monotonic clock and the screencast has no frame between 211.6 s and 235.3 s.
- Now: the full e2e suite in four alphabetical chunks (the tool's 10 min limit), port 6402.

## 3. Next steps

1. Full e2e in chunks; rerun any failure once (load first), investigate only a repeat.
2. Return summary.
