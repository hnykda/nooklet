# Progress: desktop B-786 (delete a This-Mac graph) and B-787 (list a server's graphs)

Branch: this worktree's branch, based on `main` at `81d8a618`. Not merged, not pushed.
Background: ADR 032 (amended 2026-10-05 for these two), `docs/progress/desktop-graphs.md`, B-712
(removal dialog), B-713 (retire).

## Status

- [x] Read ADR 032, desktop-graphs progress, B-786/B-787/B-712/B-713, `main.rs`, `graph_list.rs`,
      `connect.rs`, the web desktop menu/add form, `connect-graph.ts#listServerGraphs`, the server's
      `/graphs` routes, `GraphRegistry#retire` and the pairing/token ops.
- [x] Rust: `mac_delete.rs` (checks, folder validation, retire on server / CLI, Trash),
      `delete-mac-graph` request in `main.rs`.
- [x] Rust: `connect.rs#list_server_graphs`, `list-server-graphs` request; `Http::call` (GET/DELETE).
- [x] Web: `macDeletionDialog`, `canDeleteMacGraph`, Delete on the menu's This-Mac rows; the add
      form's "Show graphs on this server (root token)"; `deleteMac` / `listServerGraphs` flags.
- [x] Tests: cargo, web unit, e2e (`desktop-graphs.spec.ts`, 12 passed on port 6530).
- [x] Docs: BUGS (B-786, B-787 fixed; B-880 logged), ADR 032 amendment, getting-started, features.
- [x] Committed `56e86713`; full verification below.
- [ ] The owner's check in the real app (below). Nothing else in flight.

## Decisions

- **Delete = retire, then Trash.** The bundled server holds an opened graph's SQLite file, mirror,
  indexer and sockets (ADR 025's lazy registry), so the shell never moves `graphs/<id>` itself: it
  calls `DELETE http://127.0.0.1:<port>/graphs/<id>` with `<data>/root.token` (B-713's retire,
  which closes all of that, then moves the folder to `graphs-retired/<id>-<time>`), and moves THAT
  folder to the Trash. No server listening: `nooklet graph retire <id>` (bundled CLI; it refuses
  while `serve.pid` names a live server). The CLI's stdout (verified 2026-10-05 by running it) ends
  `nooklet graph unretire <name> (add --as …)`; the name is read from there.
- **Trash through `NSFileManager`** (`trash` 5.2.9, `DeleteMethod::NsFileManager`), not the crate's
  default Finder/AppleScript method, which needs an Automation permission prompt. Cost: Finder may
  not offer "Put Back"; the dialog says to drag the folder back and rename it.
- **Refused:** the open graph; `default` (CLI, MCP, launcher and the bare-address redirect all open
  it; the server wants `--force` for it); the last graph on this Mac; a symlink or a path outside
  `graphs/`; any request whose window is not on the bundled server's origin (the typed
  confirmation is page-side; a server graph's page is that server's code).
- **B-787: no device token is minted.** Read the server: `POST /graphs` mints an admin token only
  for a graph it creates; `pairing.create` needs that graph's admin token; `bearerAuth` checks only
  the graph's own token table. So after picking a graph the form asks for its device token or a
  pairing link, as the phone and browser forms do. A root-gated "mint for graph X" endpoint was
  not added: it would make the root token a key to every graph's data (ADR 025 kept it to the list).
- **Flags** `deleteMac` / `listServerGraphs` in `__NOOKLET_DESKTOP__`, like `reveal`: a server's
  page may be newer than the shell.

## Verified by hand (2026-10-05)

- `b786_against_a_real_server` (ignored test) against `pnpm nooklet serve --data <scratch> --port
  6531` with `default` and `garden`, `garden` opened first (`/g/garden/healthz` 200): passed; the
  whole folder went to `graphs-retired/garden-<time>` and the server then answered 404 for it.
  Recipe: `pnpm nooklet graph create default --data <dir>`, same for `garden`, `pnpm nooklet serve
  --data <dir> --port 6531`, `curl http://127.0.0.1:6531/g/garden/healthz`, then
  `NOOKLET_DELETE_PROBE_DATA=<dir> NOOKLET_DELETE_PROBE_PORT=6531 cargo test -- --ignored
  b786_against_a_real_server`.
- `nooklet graph retire` while that server ran: refused (serve.pid), as the CLI fallback relies on.
- `the_real_trash_takes_a_folder` (ignored test): passed; a probe folder left its temp dir for the
  Trash (the Trash itself is not listable from this sandbox).

## Verification (exact, on `56e86713`)

- `cargo test` (src-tauri): **46 passed, 0 failed, 3 ignored** (the real keychain; the real Trash
  and the real-server deletion, both run by hand above and passing).
- `pnpm -r test`: core 523, plugin-api 17, desktop (node) 4 passed; server **1 failed / 951** in
  the first run (`cli-graph-retire.test.ts` "refuses retire/replace while a serve holds the data
  dir…", untouched code, under the full parallel run's load), then 4/4 alone and **952/952** on a
  re-run of the server suite; web **1840 passed** (run on its own, since `pnpm -r` stopped at the
  server failure).
- `pnpm e2e` (full, port 6530): **886 passed, 1 failed, 6 skipped** (26.5 min). The failure is
  `[webkit] focus-log.spec.ts:36`, already listed as pre-existing and flaky in BUGS.md (e2e-flaky
  notes); `focus-log.spec.ts` re-run alone: 6/6 passed. Main had 884 passed; this adds 3 e2e tests.
- New tests fail without the fix: with `DesktopGraphMenu.tsx` and `DesktopAddGraph.tsx` reverted
  to main, the 4 positive B-786/B-787 component tests fail (the "not offered" ones pass either way,
  as they should).
- `pnpm -r typecheck` clean; `pnpm exec biome check .`: no diagnostics in any changed file (31
  warnings elsewhere, pre-existing); `node tools/leak-check.mjs --tree` clean.
- `pnpm desktop:build --bundles app`: built and bundled `nooklet.app` (not installed, not
  launched); the binary carries `deleteMac:true`, the bundled web client `delete-mac-graph`.
- NOT verified: anything in a real WKWebView window (the owner's check below).

## Owner's check in the real app (not done by any agent: no GUI run)

Build: `pnpm desktop:build --bundles app`, then run
`apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app`.

B-786:
1. **Add a graph → Create on this Mac**, name it "Delete Me". It opens. Open **This Mac** from the
   graph menu.
2. In the graph menu, **On this Mac**: "This Mac" has no trash icon; "Delete Me" has one. Click it.
   The dialog says it is the only copy and that the folder goes to the Trash; **Move to Trash**
   stays disabled until you type `delete`.
3. Type `delete`, press **Move to Trash**. Expect: the row disappears, "“Delete Me” is in the
   Trash." under the list, and in Finder's Trash a folder `delete-me-<date>T<time>Z` containing
   `graph.sqlite`. `~/.nooklet/default/graphs/` no longer has `delete-me`; `graphs-retired/`
   doesn't either.
4. The open graph's row never has a trash icon, and once This Mac is the only graph on this Mac,
   no row under On this Mac has one.
5. Open a server graph: no trash icons on This Mac's rows there (deletion is offered only from a
   graph on this Mac).
6. Optional: drag the folder back from the Trash into `~/.nooklet/default/graphs/`, rename it
   `delete-me`, reopen the graph menu (or relaunch): it is listed again and opens with its notes.

B-787:
7. **Add a graph → Connect to a server**: your server's address (bare, no `/g/…`) and its root
   token (`nooklet token root` on the server's machine). Press **Show graphs on this server (root
   token)**. Expect the server's graphs, the ones already added marked "already on this Mac".
8. Pick one: the address fills in with `/g/<id>`, the token field empties, and a note asks for a
   device token. Paste a device token for that graph and **Connect**: it opens.
9. Keychain Access → `com.nooklet.desktop`: only the device token's item (account = the graph's
   address); `desktop.json` has no `nkroot_`.
10. A wrong root token: "That root token was rejected…" on the form.

## How to resume

Read this file, then `git log 81d8a618..HEAD`, then continue with the first unchecked item.
