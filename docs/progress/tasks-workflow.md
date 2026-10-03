# B-608 (task workflow, LATER/NOW) + B-610 (word-count 500) — progress

Branch: `worktree-agent-a617a1823cc1e0f30` (based on main `4c28fad`). Not merged into main.

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

## Status

(in progress — updated as steps land)

## BUGS.md updates to fold in

(filled at the end)
