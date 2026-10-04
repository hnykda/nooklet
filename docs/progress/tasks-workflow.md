# B-608 (task workflow, LATER/NOW) + B-610 (word-count 500) — progress

Branch: `worktree-agent-a617a1823cc1e0f30` (based on main `07720d1`). Not merged into main.

## What Logseq does (settled from source, file graphs, tag 0.10.9)

Sources (fetched 2026-10-03; `master` is now the DB version, whose `cycle-todo!` no longer takes a
workflow, so the file-graph release the owner uses is the reference):

- `src/main/frontend/util/marker.cljs` `cycle-marker-state`:
  https://github.com/logseq/logseq/blob/0.10.9/src/main/frontend/util/marker.cljs
  ```clojure
  (case marker "TODO" "DOING"  "DOING" "DONE"  "LATER" "NOW"  "NOW" "DONE"  "DONE" nil
    (if (= :now preferred-workflow) "LATER" "TODO"))
  ```
- `src/main/frontend/handler/editor.cljs` `cycle-todo!` / `set-marker` pass
  `(state/get-preferred-workflow)` into it; `uncheck` (checkbox on a DONE block) writes
  `LATER` under `:now`, else `TODO`; `update-timestamps-content!` (repeating task completed) maps
  `DOING→TODO`, `NOW→LATER`, any other marker kept.
  https://github.com/logseq/logseq/blob/0.10.9/src/main/frontend/handler/editor.cljs
- `src/main/frontend/state.cljs` `get-preferred-workflow`: config value matching `/now|NOW/` → `:now`,
  any other value → `:todo`; **absent → `:now`** (Logseq's own default).
- `src/main/frontend/components/block.cljs` `marker-switch`: the small button next to the marker
  toggles `NOW↔LATER` and `TODO↔DOING` (workflow-independent).
- `src/main/frontend/commands.cljs` `get-preferred-workflow`: slash menu lists all four of
  LATER/NOW/TODO/DOING, the preferred pair first.

Answers to the four questions:

1. Plain block starts at `LATER` under `:now`, `TODO` under `:todo`.
2. The cycle is keyed on the *current* marker, not the workflow: `TODO→DOING→DONE` and
   `LATER→NOW→DONE` under either workflow. Only the start (from nil, and from WAITING/CANCELED or
   any non-cycle marker — the `case` default) depends on the workflow.
3. `DONE → nil` (both workflows).
4. `NOW→LATER` is the marker-switch button, not Mod+Enter (Mod+Enter on NOW goes to DONE). nooklet
   has no marker-switch button; the palette/slash `Mark LATER` covers it.

`done::` on DONE→none: Logseq file graphs keep no `done` property at all (completion leaves only a
LOGBOOK entry when time tracking is on, and cycling DONE→nil removes nothing). nooklet's `done::` is
its own (ADR 011/R35); Logseq does not clearly differ (it never deletes the logbook either), so it is
**left as is** — not changed.

## Decisions

- Setting stored like the journal title format (ADR 018), the closest precedent: the server keeps a
  graph-level *suggestion* in the `setting` table (`task.preferred_workflow`, written by the Logseq
  importer from `:preferred-workflow`), `/api/session` hands it out, and the reader's explicit choice
  in Settings is kept in localStorage keyed by graph. Not synced across devices: `setting` writes have
  no op kind yet (sql-schema.md rule 25), and adding one is out of scope.
- No setting at all (the owner's already-imported graph): the server infers from the graph's markers —
  more LATER+NOW than TODO+DOING → `now`, else `todo`. Owner graph: 72 LATER + 5 NOW vs 0 → `now`.
  An empty graph stays `todo` (nooklet's previous behaviour) even though Logseq's own default is
  `:now` — deliberate, so a fresh nooklet graph behaves as it always has; flip if the owner wants.
- WAITING/CANCELED + Mod+Enter → workflow start marker (Logseq), was → none.
- Repeating task completion resets `NOW/LATER → LATER`, else `TODO` (Logseq); was always TODO.
- Checkbox uncheck (DONE → open) → workflow start marker (Logseq `uncheck`); was always TODO.

## Status: done (all three fixed, tested), branch not merged

Commits: `4250be9` (B-608 + B-610 code and unit tests), `602a347` (e2e), `dfb07d5` (merge of
main, for B-617), `81fb0cb` (B-617), and a last commit with the e2e made order-independent and this
file.

What changed (B-608):
- `packages/core/src/task-workflow.ts`: `cycleTaskMarker`, `workflowStartMarker`,
  `repeatReopenMarker`, `parseTaskWorkflow`, `inferTaskWorkflow`.
- Editor Mod+Enter / marker checkbox (`apps/web/src/editor/task.ts`, `BlockTree.tsx`), Tasks view
  checkbox (`TasksView.tsx`), registry `task.cycle`/`task.toggleDone` (`registrations/task.ts`)
  all take the workflow; new commands `task.setMarkerLater`, `task.setMarkerNow`.
- Slash menu: `DOING`, `LATER`, `NOW` rows appended; under `now` the first row is `LATER / task`
  and the tail is NOW, TODO, DOING (`slash/items.ts#slashItemsFor`). Spec R34/R54 amended, wiki
  shortcut page regenerated.
- Keyboard toolbar's task button is `task.toggleDone` (enabled only on a task): its un-tick now
  writes LATER under `now`. It still does not create a task on a plain block (unchanged).
- Server: importer reads `:preferred-workflow` into `setting` `task.preferred_workflow`;
  `/api/session` returns `taskWorkflow` (recorded, else inferred). Client:
  `apps/web/src/data/task-workflow.ts` (stored choice > suggestion > local inference),
  signal in `apps/web/src/commands/task-workflow.ts`; Settings → Tasks → Task workflow.
- Tasks view, agenda and ```query``` NOW/LATER handling: unchanged code (they already treat
  LATER/NOW as open); their e2e specs pass.

B-610: `plugins/word-count/src/server.ts` rpc `count` returns `null` for a missing page instead of
throwing (the HTTP/MCP `page.wordcount` op still answers 404 `not_found`); `client.ts` clears the
status item on `null`.

B-617 (added mid-task by the coordinator): `OpRegistry` was shared by every graph a process hosts,
so the second graph's word-count activation threw. `OpRegistry.forkCore()` gives each graph
(`graphs/registry.ts#open`) the shared core ops plus room for its own plugin ops — like every other
plugin registry, which already keys on `ServerContext`. mermaid (client-only) and daily-summary
(a job, per-ctx) were never affected; the new test checks all three are active in both graphs.

Verification (2026-10-03, after merging main):
- `pnpm -r test`: core 434, plugin-api 17, server 797, web 1440 — all pass.
- `pnpm -r typecheck`: clean.
- `pnpm exec biome check . --diagnostic-level=error`: errors only in `tools/probes/sweep-core/
  search-trash.mjs` and `tools/probes/sweep-devices/*` (came from main, not touched here).
- e2e (`NOOKLET_E2E_PORT=6325`): tasks, tasks-view-dates, journal-agenda, query, query-task-tag,
  query-limits, task-marker-keys, popups, settings, plugins, page-delete, views, task-workflow —
  144 passed. Full e2e suite not run.
- Tests that fail without the fix (checked): B-610 server test (500) and e2e (500 seen); B-617
  mount test (`failed to activate: op "page.wordcount" is already registered`). B-608 e2e on the
  old build was not re-run; the old `nextCycleMarker` returned null for LATER by construction.

Still unverified:
- Not tried against a copy of the owner's real graph; the inference was checked with fixtures
  (importer test: LATER/NOW-only graph → `now`).
- The e2e sets the workflow through Settings; the server's inference is covered only by unit tests,
  because the shared e2e server's dominant pair depends on what other specs seeded.
- Inference is live: a graph with no setting can flip when its TODO+DOING count overtakes
  LATER+NOW. The owner's graph (77 vs 0) won't flip in practice.

## BUGS.md updates to fold in

- **B-608** → Fixed (2026-10-03, `4250be9`). Tests: `packages/core/src/task-workflow.test.ts`,
  `apps/web/src/editor/task.test.ts` "under the `now` workflow (B-608)",
  `apps/web/src/commands/registrations/index.test.ts` "follow the graph's task workflow (B-608)",
  `SlashMenu.test.tsx` "LATER first under `now`", `importer/logseq.test.ts` "task workflow
  (B-608)", `http/host-guard.test.ts` "task workflow", e2e `e2e/tests/task-workflow.spec.ts`.
  Logseq ref: 0.10.9 `util/marker.cljs#cycle-marker-state`. Also changed to match Logseq:
  WAITING/CANCELED + Mod+Enter → start marker (was none); un-tick DONE → start marker; a repeating
  LATER/NOW task reopens as LATER. `done::` on DONE→none left as is (Logseq has no such property
  and removes nothing on that step either).
- **B-610** → Fixed (2026-10-03, `4250be9`). Tests: `packages/server/src/plugins/built-ins.test.ts`
  "the status bar's rpc answers null, not a 500, for a page just deleted (B-610)"; e2e
  `plugins.spec.ts` "deleting the open page asks word count about it without a 500 (B-610)".
- **B-617** → Fixed (2026-10-03, `81fb0cb`). Test: `packages/server/src/graphs/mount.test.ts`
  "activates every built-in plugin in each graph … (B-617)".
- New, not fixed (observed in passing): plugin `rpc.expose` routes turn any thrown error into an
  unhandled 500 (`plugins/server-context.ts`), unlike `ops.register`, which maps an `OpError` to
  its status. B-610 was fixed in the plugin; another plugin throwing `OpError` from rpc would 500
  the same way. Severity low.
