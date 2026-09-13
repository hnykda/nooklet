# Progress: delete-launcher (M11)

Branch `m11/delete-launcher` from `52e5d20`. Two owner-approved items:
(1) "Delete page" from the web UI (page "…" menu + palette), confirm, trash, navigate to journal;
(2) B-430: the desktop launcher shows the bundled server's real exit reason.

## Done

- `5c064aa` probe `tools/probes/wkwebview-confirm.swift`: `confirm returned false after 0 ms`,
  `alert returned undefined` in a WKWebView whose UI delegate lacks the panel methods (wry 0.55.1's
  shape) — B-491 in the inbox. Delete page therefore uses an in-page dialog, not `window.confirm`.
- (this commit) B-430 + B-490: launcher page moved to tracked `apps/desktop/launcher/`
  (`index.html` + pure `status.js`), `frontendDist` → `../launcher`; `main.rs` pipes stderr,
  `watch_startup`, `server_status` command; `serde` dep (+ `serde_json` dev). Tests: `cargo test`
  6/6, `pnpm --filter @nooklet/desktop test` 4/4, `e2e/tests/desktop-launcher.spec.ts` 4/4.

## Findings / decisions

- `apps/desktop/dist/index.html` was never in git (`.gitignore` `dist/`); a fresh worktree's
  `cargo check` failed on `frontendDist` (B-490).
- `cargo check` needs `apps/desktop/sidecar/` to exist: `mkdir -p apps/desktop/sidecar` (gitignored).
  Use `CARGO_TARGET_DIR=<scratch>/target` to keep the worktree small. `rustfmt` is not installed
  for the toolchain; not installed here, so main.rs is hand-formatted.
- Server messages verified by running `nooklet serve` (`<scratch>/exit-messages.sh`): schema
  `nooklet: database schema version 99 is newer than this build supports (6); upgrade nooklet`,
  exit 1; port taken → Node's unhandled `Error: listen EADDRINUSE …` stack, exit 1.
- Tauri 2.11.5 `webview/mod.rs`: app commands without an app manifest are allowed from local origins
  (tauri://localhost, the launcher) and refused from remote ones (the server's http page).
- Server `page.delete` refuses journal pages (`invalid`): PLAN §8 + ADR 018 (the day is the
  identity; an emptied day just is not listed). The UI hides Delete on a journal page.
- Port 6415 was in use by another worktree's e2e run once (wf_975bcd44-fae-5); waited, reran.

## Next steps

1. Delete page: `app/confirm-dialog.tsx` (in-page), `app.deletePage` command in
   `commands/registrations/page-actions.ts` (+ host method, fake, unit tests), menu item in
   `views/PageActions.tsx` (hidden on journals: `journal` prop from `PageView.tsx`), host in
   `app/page-actions-host.ts` (forceSync → `page.delete` → forceSync → navigate `/journals`),
   `navigate` dep in `CommandLayer.tsx`.
2. `e2e/tests/page-delete.spec.ts`: delete → confirm → gone from All pages + search → Trash lists
   → Restore → blocks back.
3. Spec row in `docs/spec/commands-and-keymap.md`.
