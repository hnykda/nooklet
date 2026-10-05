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
- [ ] Commit, then full verification (below).

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

## Verification (exact)

(filled in after the runs)

## Owner's check in the real app

(filled in at the end)

## How to resume

Read this file, then `git log 81d8a618..HEAD`, then continue with the first unchecked item.
