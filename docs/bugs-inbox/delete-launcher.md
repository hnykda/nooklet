# Bug inbox — delete-launcher (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-490..B-499.

---

### B-491 · `window.confirm()` is always "Cancel" and `window.alert()` shows nothing in the desktop app
**Status:** open · **Severity:** high · **Found:** 2026-09-13, delete-launcher (choosing how to
confirm a page delete) · **Test:** none yet; probe `tools/probes/wkwebview-confirm.swift`

The desktop app is a WKWebView through wry 0.55.1, whose `WKUIDelegate`
(`wry-0.55.1/src/wkwebview/class/wry_web_view_ui_delegate.rs`) implements the file-upload panel,
media-capture permission and new windows — and none of the JavaScript panel methods
(`webView:runJavaScriptConfirmPanelWithMessage:…`, `…AlertPanel…`, `…TextInputPanel…`). WebKit then
answers without showing anything. The probe builds exactly that (a UI delegate with no panel
methods) and prints `confirm returned false after 0 ms` / `alert returned undefined after 1 ms`.

What that breaks in the app today, found by grep, none of it verified in a built app:

- History view: "Undo" and "Restore this version" both open with `window.confirm`
  (`views/HistoryView.tsx`) — on the desktop app they silently do nothing.
- Every failure reported through `window.alert` is invisible there: "Turn into page / Move to page /
  Merge page failed" (`app/refactor-host.tsx`), "Rename failed" (`views/PageView.tsx`), "Could not
  clear the local copy" (`views/GraphMismatchView.tsx`). The action fails with no word.

Chromium (the e2e suite) shows real dialogs, which is why no test noticed. Fix direction: an
in-page dialog. `apps/web/src/app/confirm-dialog.tsx` (added for Delete page on this branch) is a
drop-in for the confirms; the alerts want the same or an inline error line. Not done here — those
call sites belong to other workstreams.

---

### B-430 (existing)

**Fixed 2026-09-13.** `apps/desktop/src-tauri/src/main.rs` pipes the bundled server's stderr
(still echoed to the app's own stderr), keeps its last 40 lines, and watches the child
(`watch_startup`): it answers → `ready`; it exits first → `exited` with the code, the tail, and a
reason read from the server's own words (`schema_too_new` for "is newer than this build supports",
`port_in_use` for Node's `EADDRINUSE`, both captured by running `nooklet serve` for real); still
silent after 30 s → `timed_out`, and watched on. A reused external server is `external`; a sidecar
that could not be launched is `spawn_failed`. The launcher page asks through a Tauri command,
`server_status` (local pages only — Tauri refuses app commands from the server's remote origin
without a capability), and `apps/desktop/launcher/status.js` turns it into words: "This graph needs
a newer version of nooklet … Update the app, then open it again", the server's output verbatim
underneath, and `pnpm nooklet serve` only for `external` or when there is no app to ask. While the
server is starting the page now says "Starting nooklet…" rather than flashing the "couldn't reach"
help for the second a normal launch takes.

Tests: `cargo test` in `apps/desktop/src-tauri` (6) — `a_child_that_exits_during_startup_is_reported_with_its_stderr`
spawns a child that prints the real message and exits 1, and fails if stderr is not captured or the
exit is not noticed; `every_status_serializes_to_the_shape_the_launcher_reads` pins the JSON against
`apps/desktop/test/server-status.json`; `apps/desktop/test/launcher-status.test.mjs` (4, `node
--test`, now `pnpm -r test` for `@nooklet/desktop`) renders the same fixtures; `e2e/tests/desktop-launcher.spec.ts`
(4) loads the page in Chromium with a stubbed `__TAURI_INTERNALS__`. Not verified: a built app
(`tauri build` was out of bounds) — `server_status` reaching the launcher inside WKWebView, and the
schema message appearing when the real app opens a too-new graph, are reasoned from Tauri 2.11.5's
source (`webview/mod.rs`: app commands from a local origin pass without an app manifest), not seen.

---

### B-490 · The desktop app's launcher page was never committed — `apps/desktop/dist/` is gitignored
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, delete-launcher (B-430) ·
**Test:** `cargo check` in a fresh worktree (the build script fails without it); no automated test

`tauri.conf.json`'s `frontendDist` was `../dist`, and `.gitignore`'s `dist/` matches
`apps/desktop/dist/` — so the hand-written launcher page (`index.html`, the "Couldn't reach the
nooklet server" screen) existed only in the owner's main checkout (dated Sep 11) and in no commit.
A fresh checkout cannot compile the app: `cargo check` there fails in `tauri::generate_context!()`
with "The `frontendDist` configuration is set to `"../dist"` but this path doesn't exist" (seen in
this worktree before any change). The release workflow (`.github/workflows/release.yml`) checks out
clean and runs `tauri-action`, so it should fail the same way — reasoned, not run.

Fixed by moving the page to a tracked `apps/desktop/launcher/` (a hand-written page is not build
output; `dist` invited exactly this) and pointing `frontendDist` there; `cargo check` and
`cargo test` pass in this worktree. The stale untracked `apps/desktop/dist/` in the main checkout is
now unused and can be deleted. `cargo check` also needs `apps/desktop/sidecar/` to exist — that one
IS build output (`pnpm --filter @nooklet/desktop run sidecar`), so a bare `mkdir` is enough to check.

---

### B-492 · `page.delete`'s `backlinks_affected` counts every block under a linking block, not the links
**Status:** open · **Severity:** low · **Found:** 2026-09-13, delete-launcher (Delete page on a copy
of the owner's graph) · **Test:** none yet

`ops/resolve.ts#backlinkCount` counts `path_ref` rows from other pages, and `path_ref` holds a row
for every descendant of a block that references the page. On a copy of the owner's graph, page
"Balení": 3 blocks on 3 pages link to it (`ref`), and `page.delete {dry_run: true}` reports
`backlinks_affected: 98`. The MCP spec (§4.3.16) documents the field only by example
(`"backlinks_affected": 3`), and an agent reading 98 would reasonably tell the person "98 links
will break". `backlinkCount` has other callers, so the fix (count `ref` rows, or distinct linking
blocks) should be checked against each of them; not changed here. The web app's Delete page dialog
does not print the number for this reason (`apps/web/src/app/page-delete.ts`).

---

### B-493 · The palette's highlight follows a pointer that never moved, so Enter can run a row the keyboard never chose
**Status:** open · **Severity:** low · **Found:** 2026-09-13, verifying delete-launcher (its e2e
test "Cancel, Escape and the backdrop delete nothing; from the palette, Enter confirms" failed 2 of
2 runs) · **Test:** none for the palette; `e2e/tests/page-delete.spec.ts`'s `runFromPalette` now
moves the pointer away and uses commands mode

Leave the mouse resting over the middle of the window (here: where the delete dialog's Cancel was
just clicked), press Cmd/Ctrl+Shift+P and type. Each palette row has `onMouseEnter={() =>
setHighlight(i())}` (`commands/palette/CommandPalette.tsx`); when the rows render or re-sort under
the stationary pointer, Chromium fires `mouseenter` on the row that lands there, and the highlight
jumps to it. In the failing run the query "Delete page" listed the command "Delete page…" first
and the page "Delete Zebra Page" second, and the second row — under the pointer — was highlighted;
Enter would have opened that page. Reproduced on purpose too: pointer at (640, 195), palette opened
from the keyboard, "Probe Yak Pointer" typed → rows `Probe Yak Pointer`, `Probe Yak Pointer Other`,
highlight on the second.

The test passed for its author (3/3, and in the full run) and failed for the verifier (2/2, same
code, same port). Why is not established — presumably when the page rows arrive relative to
Chromium's synthetic `mouseenter` under a still pointer; not verified. Fix direction (not done — the palette is not
this branch's): take the highlight on `mousemove`, not `mouseenter`, as editors' pickers commonly
do, so only a pointer that actually moves steals it.
