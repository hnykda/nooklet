# Progress: delete-launcher (M11)

Branch `m11/delete-launcher` from `52e5d20`. Two owner-approved items:
(1) "Delete page" from the web UI (page "…" menu + palette), confirm, trash, navigate to journal;
(2) B-430: the desktop launcher shows the bundled server's real exit reason.

## Done

- `5c064aa` probe `tools/probes/wkwebview-confirm.swift`: `confirm returned false after 0 ms`,
  `alert returned undefined` in a WKWebView whose UI delegate lacks the panel methods (wry 0.55.1's
  shape) — B-491 in the inbox. Delete page therefore uses an in-page dialog, not `window.confirm`.
- `a52783d` B-430 + B-490: launcher page moved to tracked `apps/desktop/launcher/`
  (`index.html` + pure `status.js`), `frontendDist` → `../launcher`; `main.rs` pipes stderr,
  `watch_startup`, `server_status` command; `serde` dep (+ `serde_json` dev). Tests: `cargo test`
  6/6, `pnpm --filter @nooklet/desktop test` 4/4, `e2e/tests/desktop-launcher.spec.ts` 4/4.
- `ef642fe` Delete page: `app/confirm-dialog.tsx` (+css), `data/page-delete.ts` (server
  `page.delete` dry run + real, forceSync around), `app/page-delete.ts` flow (+ test, 7),
  `app.deletePage` in `commands/registrations/page-actions.ts` (remoteInvocable false; tests
  updated), menu item in `views/PageActions.tsx` (hidden on journals via `journal` prop from
  `PageView.tsx`), host in `app/page-actions-host.ts` (`navigate` dep from `CommandLayer.tsx`),
  spec row + R52b. Tests: web unit 1145/1145, `e2e/tests/page-delete.spec.ts` 3/3,
  `pnpm -r typecheck` clean.
- `5d4c4d3` B-492: the dialog no longer prints `backlinks_affected` (98 for a page 3 blocks link to
  on the real graph — it counts `path_ref`, i.e. child blocks too); logged for the op's owners.
- Real-graph copy (`<scratch>/real-graph.sh`, port 16415, own listener checked): "Balení" deleted
  through the UI — dialog, /journals, All pages 0 rows, Trash row "23 blocks … api", Restore
  "Restored "Balení" and 23 blocks with it", 23 rows back; `nooklet verify` exact, 20,494 ops.
- Full e2e on 6415 in two halves: 247 passed + 1 skipped, 294 passed + 1 skipped, 0 failed.

## Status: complete. Final report delivered to the coordinator.

Left for others (logged, not done): B-491 (HistoryView's two `window.confirm`s and four
`window.alert`s are dead in the desktop app — `app/confirm-dialog.tsx` is the drop-in), B-492
(`backlinkCount`). The stale untracked `apps/desktop/dist/` in the main checkout can be deleted.
Not verified: a built desktop app (`server_status` inside WKWebView; the real schema-too-new
launch).

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
  identity). The UI hides Delete on a journal page.
- Port 6415 was in use by another worktree's e2e run once (wf_975bcd44-fae-5); waited, reran.
- **Incident, ~17:52 2026-09-13:** my real-graph script started a server on 6416 without checking
  the port; another agent's nooklet server (a real-graph copy — it had "Balení", 23 rows) already
  listened there, so my server died with EADDRINUSE and my Playwright probe drove THEIR server (it
  only opened a page and the "…" menu; the Delete item was not in their build, so nothing was
  written). Then the script's `pkill -f -- "--port 6416"` killed their server. Nothing listens on
  6416 since. Reported to the coordinator. Scripts now refuse a busy port, check the listener's
  command line names my data dir, and kill by PID only.

- Decisions: delete goes through the server op (one instant for trash.restore, attribution,
  journal guard) like `page-rename.ts`; the dialog focuses the destructive button (undoable via
  Trash); no post-delete toast (the dialog already says where it goes) — possible follow-up.
  A `read-only:: true` page can still be deleted (the server op does not check it either).
