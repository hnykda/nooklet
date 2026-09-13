# Progress: delete-launcher (M11)

Branch `m11/delete-launcher` from `52e5d20`. Two owner-approved items:
(1) "Delete page" from the web UI (page "…" menu + palette), confirm, trash, navigate to journal;
(2) B-430: the desktop launcher shows the bundled server's real exit reason.

## Done

- probe `tools/probes/wkwebview-confirm.swift`: `confirm returned false after 0 ms`, `alert returned undefined` — B-491 in the inbox. Delete page therefore uses an in-page dialog, not `window.confirm`.

## Findings so far

- `apps/desktop/dist/index.html` (Tauri's `frontendDist`, the launcher page) is NOT in git:
  `.gitignore`'s `dist/` swallows it. It exists only in the owner's main checkout. A fresh
  worktree's `cargo check` fails: "The `frontendDist` configuration is set to `"../dist"` but this
  path doesn't exist" (seen 2026-09-13). Logged as B-490; fix = move it to a tracked
  `apps/desktop/launcher/`.
- `cargo check` also needs `apps/desktop/sidecar/` to exist (build output, gitignored): create an
  empty one for checking. Use `CARGO_TARGET_DIR=<scratch>/target` to keep the worktree small.
- wry 0.55.1's `WKUIDelegate` implements no `runJavaScriptConfirmPanel…` method, and WebKit then
  treats `confirm()` as Cancel — so `window.confirm` may be always-false in the desktop app
  (HistoryView's Undo/Restore would be dead there). Being probed (`tools/probes/`), not assumed.
- Server `page.delete` refuses journal pages (`invalid`): PLAN §8 + ADR 018, the day is the
  identity. The UI hides Delete on a journal page.

## Next steps

1. Probe WKWebView confirm(). 2. Launcher moved + status IPC + tests. 3. Delete page.
