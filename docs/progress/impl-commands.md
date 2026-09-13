# M8 impl-commands — the dead commands: progress

Brief (coordinator, 2026-09-13): B-97 Collapse all / Expand all (current page and zoomed subtree,
through `collapsed`); B-105 argument-only commands in the palette; B-98 "Open plugin manager"
(plain list of installed plugins from what the server exposes, or remove the command); B-106
comment/spec drift; exposure-audit item 6 — "Open on shelf" as a palette command, a context-menu
entry, and Shift+Enter on a palette page row. Branch `m8/impl-commands` from `da85cfb`. Bugs go
to `docs/bugs-inbox/impl-commands.md` (never `docs/BUGS.md`). e2e port 6402.

## 1. Done

- `6492a0b` this file + inbox, entries logged before fixing.
- `390a763` B-105: `Command.requiresArgs` (spec R1a), palette filter, `nav.openPage` /
  `nav.revealBlock` flagged; `CommandPalette.test.tsx` + `registrations/palette-rows.test.ts`
  (both fail without the fix).
- `0e42a75` B-97: `editor/collapse-all.ts`
  (+ test), `editor/outline-registry.ts` (+ test), cases in `BlockTree.tsx`, no-op host hands
  page-scoped ids to mounted outlines (`app/editor-host.ts`), `keydown.ts` union. e2e
  `e2e/tests/commands.spec.ts` 4/4 on 6402, and 4/4 FAIL against da85cfb's files (verified).
  Neighbours on 6402: commands+views+selection+context-menu+journals = 69 passed, 1 skipped
  (pre-existing fixme).

- `b9c4b48` B-98: `views/PluginsSection.tsx`,
  `data/plugins.ts`, one-line hookup in `SettingsPanel.tsx`, `AppDeps.openPluginManager` wired in
  `CommandLayer.tsx`; spec R52. e2e commands.spec (5) + settings.spec (8) = 13 passed on 6402.

- `0cbf5bd` B-160 / audit item 6:
  `commands/registrations/shelf.ts` (+ test), `app/shelf-host.ts`, hookups in
  `registrations/index.ts`, `CommandLayer.tsx`, `BlockContextMenu.tsx` ENTRIES, palette
  Shift+Enter/Shift+click + `.cmd-hint` (`commands/styles.css`); spec R32a/R43a + table rows;
  `context-menu.spec.ts` pinned list. e2e on 6402: commands+context-menu+shelf = 27 passed,
  1 skipped (pre-existing fixme); views+navigation+pages = 50 passed.

- `1c1be0c` B-106: `registrations/spec-tables.test.ts` (fails 2/4
  on da85cfb's spec, verified), eight missing rows + rules, R54 slash table, DiagnosticsPanel
  comment, wiki generator (optional hosts, requiresArgs section) + regenerated wiki page.

- Final sweep (commit after 1c1be0c, "test(probe): …"): web unit 724/724 (a first run had 2
  failures in `page-title.test.ts` / `render-seams.test.tsx`, not touched here, both passing alone
  and on the rerun); `pnpm -r typecheck` clean; e2e on 6402 over 19 specs (commands, context-menu,
  shelf, shelf-outline, views, settings, selection, journals, editing, focus, navigation, pages,
  help, popups, phone, refactor, templates, remote-device, a-fresh-journal): 207 passed, 1
  skipped, 2 failed — `editing.spec.ts:55` passed on rerun (load); `views.spec.ts:461` fails also
  with this branch's web sources reverted to da85cfb → logged B-161. Real-graph probe
  `tools/probes/collapse-all-real-graph.mjs` + `nooklet verify` OK (numbers in the B-97 entry).

## 2. In flight

- Nothing. Task complete; report delivered.

## 3. Next steps, in order

- None for this brief. Left for the owner/coordinator: see "Open" below.

## 3a. Open

- "Collapse all", "Expand all", "Open this page on shelf" and (pre-existing) "Merge this page
  into…" are listed off a page route and do nothing there: `WhenContext` is a closed set with no
  route/outline variable. Adding one is a spec change (R6/R7, `types.ts`, every full context
  literal in tests) — an owner decision.
- `spec-tables.test.ts` fails whenever a branch adds a command without a spec row. Branches merged
  after this one that add commands will need a row each.
- B-161 (palette focus e2e) needs someone to look at focus return after the palette closes.

## 4. Decisions

- The worktree was created at 41666ee (88 commits behind da85cfb); the branch was reset to
  da85cfb before any work.
- B-105: hide (`requiresArgs`) rather than prompt for the argument — "Switch page" already is the
  human form of `nav.openPage`, and "reveal a block" has no sensible no-argument meaning.
- B-97: ops only for blocks with children whose flag changes (no `collapsed:: true` on leaves in
  the mirror). Zoomed: Collapse all keeps the root open; Expand all opens it. Nothing focused →
  every mounted editable tree (journal stream: all loaded days); focused → that tree only.
- B-98: a read-only list, not a manager (the brief's "render a plain list"). `/api/v1/plugins`
  is left as is (active only) because it is the discovery route a client plugin host (B-103,
  possibly another branch) reads; the section says disabled plugins are not shown.
- `when: "true"` kept for both (R26). Off a page (e.g. `/search`) the rows still show and do
  nothing — `WhenContext` cannot see the route (same limitation `edit.mergePage` documents). A
  context variable for "an outline is on screen" is a spec change left for the owner.

## 5. How to resume

Read this file and `docs/bugs-inbox/impl-commands.md`; `git log --oneline da85cfb..` on
`m8/impl-commands` shows what landed.
