# M9 progress — clipboard-sync

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Brief: B-245 (Cmd/Ctrl+X on a block selection → `block.cutSelection`, spec row), B-233
(`editing.spec.ts` Enter test fails after `a-fresh-journal.spec.ts`), B-247 (an edit queued behind
a busy replica worker is lost on reload: measure the window, make pending edits survive a reload,
proposal if it needs a design decision).

Branch `m9/clipboard-sync`, worktree `<repo>/.claude/worktrees/wf_e473942f-106-9`,
based on `cf08d19`. E2E port 6402. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/clipboard-sync/`
(`NOOKLET_DATA=<scratch>/data`; `bin/e2e.sh <repeat> <specs…>` runs Playwright on 6402). Bug
entries: `docs/bugs-inbox/clipboard-sync.md` (new numbers B-300..B-309).

## 1. Done (committed)

- B-233 — test fix: `e2e/tests/editing.spec.ts` counts rows relative to the start;
  `e2e/tests/a-fresh-journal.spec.ts` waits for the server to hold its two blocks. Cause: a race
  between the push debounce and the test's browser context closing (see inbox entry). Commit
  `281059d`.

- B-245 — `block.cutSelection`: new `apps/web/src/editor/selection-clipboard.ts` (+test), hookup in
  `BlockTree.tsx` (copy case now calls the shared function; new cut case), `keydown.ts` union,
  `commands/registrations/structural.ts` (Cmd/Ctrl+X), spec row + R31 paragraph, e2e test in
  `selection.spec.ts`. Unit web 1006/1006; e2e selection.spec 19/19; the new test fails with the
  registration removed. Logged B-300 (Backspace/Cmd+X in the page title act on a standing block
  selection) in passing. Commit `f1c1851`.

- B-247 measured (`tools/probes/replica-busy-window.mjs`, numbers in the inbox entry): even an
  idle-ish worker loses an edit reloaded 100–300 ms after typing; logged B-301 (an op durable in
  the replica is never pushed after a reload until the next local write). Commit `888b5e2`.

- B-301 + B-247 fixed — `sync/sync-client.ts#pushIfPending` (connectLive + onOpen);
  `db/unapplied-ops.ts` (+test), `db/client.ts` hookup, `WorkerApi.replayLocalOps` in
  `worker-api.ts`/`db.worker.ts`/`worker-core.ts` (+test), `fake-worker.ts`,
  `db/client-unapplied.test.ts`, `e2e/tests/reload-durability.spec.ts`, proposal
  `docs/proposals/002-pending-edits-durability.md`. E2E reload-durability 15/15 (repeat 5);
  attribution: journal disabled → B-247 tests 4/4 red. Commit `d218e7d`.
  Unit: full web suite 1021/1021 (at load average ~20; at 65–72 it had 7 timeouts in
  `SearchView.test.tsx`, `page-title.test.ts`, `render-seams.test.tsx`, identical with the original
  `db/client.ts`). E2E a-fresh-journal + editing + reload-durability + selection: 27/27.
  (`--repeat-each` is not valid for editing/selection: fixed page names and today's journal carry
  state between repeats.)

- Real-graph check: probe re-run on the fixed build — nothing lost or unpushed at any delay;
  `nooklet verify` OK (20,466 ops). Probe server stopped. B-300 left unfixed with three candidate
  fixes written into its entry (each changes how keys resolve app-wide — owner/coordinator call).
  Logged B-302 (typing on a 201-block page blocks the worker 0.1–1.6 s per stretch, loaded
  machine, needs-repro). Commit `2ef86e7`.

- Full e2e (chromium, port 6402), in four chunks because one run exceeds a 10-minute foreground
  call; each chunk led by `a-fresh-journal.spec.ts` so today's journal starts as in a full run
  (`<scratch>/bin/e2e-chunk.sh <0..3>`): 120 passed + 1 skipped / 82 passed / 121 passed /
  122 passed + 1 failed + 1 skipped. Unique tests: 442 passed, 1 failed, 2 skipped. The failure
  was `views.spec.ts` "opening the palette while editing and closing it hands focus back to the
  editor" (the known load-flaky B-161 test); `views.spec.ts` rerun alone: 29/29.

## 2. In flight

(nothing)

## 3. Next steps

Task complete on this branch. Left for outside it:

1. Coordinator: fold `docs/bugs-inbox/clipboard-sync.md` into `docs/BUGS.md` (B-233, B-245, B-247
   fixed; B-301 fixed; B-300 open; B-302 needs-repro).
2. After merge: `node docs/wiki/tools/generate-shortcuts.mjs` (new Cmd/Ctrl+X row).
3. Owner: proposal 002 — keep option B or schedule C; B-300's fix (three candidates in its entry).
4. Unverified: WebKit/WKWebView and Capacitor behaviour of the unapplied-ops copy (proposal §4).

## 4. Decisions

- B-233: fixed the tests, not the product (the product's Enter is correct).
- B-245: the cut deletes only after the clipboard write resolved (no clipboard → no delete). Not
  wired through `resolveCommand`, same as copy (spec note 11). Wiki shortcut page not regenerated
  (generated file; regenerate after merge).
- B-247: implemented proposal 002's option B (localStorage copy until the worker answers, Web Lock
  per page load for liveness, replay skipping recorded op ids). Option C (writes on the main
  thread) is left to the owner.
- B-301: push on connectLive/onOpen when the outbox is non-empty, in `SyncClient` (not only
  `WorkerDb.start`), so reconnects after a server outage are covered too.

## 5. Environment notes

- Real-graph copy: `<scratch>/graph/graph.sqlite` (sqlite3 .backup of the owner's graph, 952 pages,
  18,628 blocks, op max seq 20,411). Served by `<scratch>/bin/serve-real.sh` on port 16402 (log
  `<scratch>/server.log`); kill with `lsof -ti :16402 | xargs kill` when done (stopped).

## 6. Adversarial verify pass (2026-09-13, second agent)

Scratch `.../scratchpad/m9/clipboard-sync-verify/` (`bin/e2e.sh <specs…>`, port 6402; real-graph
copy in `graph/`, served on 16403 while probing, stopped).

- Re-ran: web unit 1021/1021; typecheck + biome clean; e2e a-fresh-journal + editing +
  reload-durability + selection 27/27.
- Found and fixed **B-303** (a cut straight after typing copied the last-fetched text and deleted
  the block with the new text): `BlockTree.tsx#unansweredText`, test in `selection.spec.ts`,
  real-graph before/after with `tools/probes/cut-just-typed.mjs`. Commits `7bc3cd2`, `771dfa9`,
  `eea8eeb`. After the fix: 100/100 on 16 editor/undo/sync specs; web unit 1021/1021; verify OK.
- Added palette evidence to **B-300** (`59cf6c1`), not fixed (owner decision stands).
- Checked and fine (throwaway specs, not kept): cut/undo/redo of a subtree with property lines,
  a marker and Czech text; Cmd+X on text inside the editor still cuts text; Enter + typing + Tab
  behind a busy worker survive a reload; a cut behind a busy worker stays cut after a reload; a
  follower tab's edit behind a busy worker survives its reload and reaches the leader; a leader
  reload with a follower open keeps its edit; a selection in one journal day does not capture
  Cmd+X in another day's editor.
- Next: full e2e in four chunks on the verified tree (in flight when this was written).
