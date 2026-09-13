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

- B-98 (commit after 0e42a75, "fix(web): Open plugin manager…"): `views/PluginsSection.tsx`,
  `data/plugins.ts`, one-line hookup in `SettingsPanel.tsx`, `AppDeps.openPluginManager` wired in
  `CommandLayer.tsx`; spec R52. e2e commands.spec (5) + settings.spec (8) = 13 passed on 6402.

## 2. In flight

- Nothing uncommitted after the B-98 commit.

## 3. Next steps, in order

1. Audit item 6 (B-160): `block.openOnShelf` (focused/selected block), a current-page-on-shelf
   command (area must be a core area — `page.` throws at boot, B-87), context-menu entry,
   Shift+Enter on a palette page row; update `context-menu.spec.ts`'s pinned label list.
2. B-106: a test that diffs the spec's E-tables against the registrations; fix the tables;
   DiagnosticsPanel's `app.diagnostics` comment.
3. Final: full related e2e, `pnpm -r test`, typecheck, report.

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
