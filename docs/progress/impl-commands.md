# M8 impl-commands — the dead commands: progress

Brief (coordinator, 2026-09-13): B-97 Collapse all / Expand all (current page and zoomed subtree,
through `collapsed`); B-105 argument-only commands in the palette; B-98 "Open plugin manager"
(plain list of installed plugins from what the server exposes, or remove the command); B-106
comment/spec drift; exposure-audit item 6 — "Open on shelf" as a palette command, a context-menu
entry, and Shift+Enter on a palette page row. Branch `m8/impl-commands` from `da85cfb`. Bugs go
to `docs/bugs-inbox/impl-commands.md` (never `docs/BUGS.md`). e2e port 6402.

## 1. Done

- (nothing committed yet)

## 2. In flight

- Inbox + this file written; starting B-105.

## 3. Next steps, in order

1. B-105: `Command.requiresArgs`; palette never lists such commands; `nav.openPage` /
   `nav.revealBlock` set it; unit tests; spec R1/Interfaces.
2. B-97: pure `editor/collapse-all.ts` (ops for every block with children under the page or zoom
   root) + unit tests; BlockTree cases; outline registry so the palette works with nothing focused;
   e2e `e2e/tests/commands.spec.ts`.
3. B-98: settings "Plugins" section from `GET /api/v1/plugins`; `app.openPluginManager` opens it.
4. Audit item 6 (B-160): `block.openOnShelf`, a page-on-shelf command, context-menu entry,
   Shift+Enter on a palette page row.
5. B-106: spec tables vs registrations test; fix the tables; DiagnosticsPanel comment.

## 4. Decisions

- The worktree was created at 41666ee (88 commits behind da85cfb); the branch was reset to
  da85cfb before any work.

## 5. How to resume

Read this file and `docs/bugs-inbox/impl-commands.md`; `git log --oneline da85cfb..` on
`m8/impl-commands` shows what landed.
