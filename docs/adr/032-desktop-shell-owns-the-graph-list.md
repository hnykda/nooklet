# ADR 032: The desktop shell owns the one graph list; tokens in the keychain; no restarts

Date: 2026-10-04. Status: accepted (proposal 005, accepted by the owner). Amends ADR 028 and its
B-704 amendment; narrows ADR 025's "a client remembers a list" for the desktop app. Work record:
`docs/progress/desktop-graphs.md`. Bugs: B-780 (umbrella), B-781..B-785.

## Context

The owner, using the desktop app against the production server: "the graph behaviour on desktop is
still super confusing". Proposal 005 mapped five places that each showed or added graphs, two lists
that never met (`desktop.json` in the launcher, each origin's localStorage in the in-app menu), an
add flow that asked for the address and the token on two screens a restart apart, phone-only
choices ("Just this device", promote, "keep as a device-only graph") on a Mac, and a restart for
every switch between This Mac and a server, because the shell decided once per launch whether to
start its bundled server.

## Decision

1. **One list, owned by the shell.** `desktop.json` holds the server graphs (address + label) and
   which graph was last open; This Mac's graphs are read from `<data>/graphs/*/graph.json`, as
   before (only a display-name override is stored). A server graph's device token is in the system
   keychain (`keyring` crate: macOS Keychain, Windows Credential Manager), keyed by the graph's
   address, never in the file. `apps/desktop/src-tauri/src/graph_list.rs`, `token_store.rs`.
2. **One menu.** The sidebar's graph menu reads the shell's list from `__NOOKLET_DESKTOP__.graphs`
   (`apps/web/src/shell/DesktopGraphMenu.tsx`), grouped **On this Mac** / **On servers** (by
   host). The per-origin localStorage list is not shown on desktop; it stays only as replica
   bookkeeping (replica key, graph identity for mismatch detection), since dropping it would orphan
   existing replicas and their unsynced changes. The native **Graphs…** item (was "Switch
   Server…") opens the same menu.
3. **One add form, checked by the shell.** "Create on this Mac" (a name) or "Connect to a server"
   (address + token or pairing link, one button). The shell makes the calls the web client would —
   `POST <graph>/api/v1/graph.overview` with the token, and for a pairing code first
   `pairing.redeem` (ADR 029) — from Rust (`connect.rs`, `ureq`), where CORS does not apply. Only an
   accepted token is stored. Every failure (unreachable, refused, wrong shape) is shown on the form.
4. **The token reaches the page through the initialization script, scoped.** A window is built for
   one graph. When that is a server graph with a keychain token, the script carries that one token
   and exposes it as `__NOOKLET_DESKTOP__.graphToken` only when `location.origin` is the graph's
   origin and `location.pathname` is its path or below (`/g/work`, `/g/work/…`, never
   `/g/workshop`), checked before any page script runs; elsewhere it is `null`. The script is
   main-frame only, so no iframe sees it. The web client's bootstrap uses it and never stores it.
   There is no ConnectView on desktop: a server graph without a token opens on the add form,
   pre-filled with its address (`views/DesktopConnectView.tsx`).
5. **No restarts.** The bundled server always runs. Switching is the window navigating to the
   graph's address; `on_navigation` lets it through when this window can show it (This Mac's graphs,
   the server graph it was built for) and otherwise opens a new window built for that graph and
   closes the old one. A new window starts on the launcher, which is now only "Connecting…" and, for
   an unreachable server, "Couldn't reach <server>." with **Try again** and **Open a graph on this
   Mac**.
6. **Requests from the page** still use B-643's navigation door (`nooklet-desktop.invalid`), now
   four kinds (`new-local-graph`, `connect-server`, `rename`, `remove`), each carrying a random
   per-window key that only the window's main-frame documents receive, and answered with a
   `nooklet:desktop-reply` event. ADR 028's `new-local-graph?label` / `open-local-graph` and its
   amendment's `add-server-graph` are gone; so are the launcher's Tauri commands except
   `server_status`.
7. **No device-only graph on desktop.** The mismatch screen offers "Re-sync from the server" and
   "Open another graph" only. "Just this device" and promote are not offered on desktop.
8. **Migration.** A `desktop.json` in the previous shape (`remote_graphs` / `active_graph_id` /
   `active_local_graph`, or the older `remote_url`) is read once, rewritten, and kept as
   `desktop.json.v1.bak`. Every address is kept. Tokens were never in that file, so a migrated
   server graph asks for its token on first open; the form is pre-filled with the token that
   origin's storage still holds from the older version, if any, so moving it to the keychain is one
   click.

## Rejected

- **Swap the script on the live window.** Tauri 2.11 / wry 0.55 add initialization scripts only
  when a webview is created. Reaching into `WKUserContentController` through `with_webview` could
  add scripts later but cannot remove one without `removeAllUserScripts`, which also removes
  Tauri's own; a stale token script would then stay in every later document. A new window per
  server graph is the supported path.
- **All server tokens in one script, each guarded by its origin check.** No window rebuilds, but
  every token would be in the script text handed to every document's web content process,
  whichever origin it shows.
- **A token in the URL fragment of the graph's address.** It would land in that origin's history
  and storage, and a reload would need it stored per origin, which is the localStorage copy this
  replaces.
- **Tauri IPC for server origins** (ADR 028's rejection stands): a remote page, or a note's
  content, would get the command set.
- **Polishing the wording only, a launcher-only switcher, or syncing the two lists**: proposal
  005's alternatives, for the reasons given there.

## Costs

- **Opening a server graph swaps the window**: the new one is placed where the old one was (size,
  position, full screen or zoomed), but its page loads from scratch and the swap may flash. Switching
  among This Mac's graphs, or from a server graph back to This Mac, stays in the window.
- **The keychain.** An unsigned or ad-hoc-signed build is a different "app" to the keychain after
  each rebuild, so macOS may ask once per build whether nooklet may read its item. Linux, not a
  release target, has no persistent store in this build (the `keyring` crate's default there), so
  server graphs ask for their token at every launch there.
- **The door's exposure, slightly wider.** Any page the window's main frame shows can, with the
  key the script gives it, create an empty graph on This Mac, add a server graph of its choosing
  (with a token of its choosing; the window then shows that server's page, which gets nothing it
  could not get in a browser), rename a graph, or remove a server graph from the list (its token is
  forgotten; the server keeps the graph; unsynced changes stay in this Mac's replica until it is
  added again). Iframes cannot: they never get the key. The window only ever shows nooklet pages in
  practice (external links open in the browser).
- **A token in the script text**: the window built for a server graph hands its script, token
  included, to whatever web content process renders its main frame. Only that graph's origin gets
  the value; another origin loaded in the same main frame would have the text in its process, not
  in its JavaScript.
- **The bundled server always runs**, also while a server graph is open: one idle Node process.
  Not measured (proposal 005's "Still unverified" stands).
- **"Show graphs on this server (root token)"** is not offered on desktop (it would be another
  cross-origin call the shell would have to make with a root token); the phone and a browser tab
  keep it. *Superseded by the amendment below (B-787).*
- **Unverified in a real window** (the owner's check, listed in the progress file): that WKWebView
  delivers each navigation to `on_navigation`, the window swap, the keychain prompt, and the menu
  item. `cargo test` covers the list, migration, verification against a local HTTP listener,
  request parsing, which navigation needs a new window, and — run in Node — which documents see the
  token; Chromium e2e covers the page side with the shell emulated.

## Amendment (2026-10-05, B-786, B-787): deleting a graph on This Mac; listing a server's graphs

Work record: `docs/progress/desktop-night-bugs.md`.

**Deleting a This-Mac graph (B-786).** A sixth request, `delete-mac-graph` (its own kind, not
`remove` with a `mac:` key, so a page and a shell of different versions can never turn "forget a
server" into "delete a folder"). On This Mac the folder is the graph, so:

1. The page asks only after the B-712 dialog's typed `delete` (`graph-removal.ts#macDeletionDialog`).
2. The shell refuses, before touching anything (`mac_delete.rs#check_deletable`): the graph open in
   the window; `default` (This Mac's main graph: the CLI, the MCP endpoint, the launcher's "Open a
   graph on this Mac" and the server's bare-address redirect all open it, and `graph retire` asks
   `--force` for it); the last graph on this Mac; and any request whose window is not on the
   bundled server's own origin. The typed confirmation is the page's, and a server graph's page is
   whatever that server serves, so only the client this app ships may ask.
3. The folder is checked (`graph_folder`): a real directory directly in `graphs/`, not a symlink,
   inside `graphs/` once resolved. The page names a graph by id only.
4. **The server lets go first, through B-713's retire.** The bundled server holds a graph's SQLite
   file, mirror, indexer and sockets once anything asked for it (ADR 025's lazy registry); moving
   the folder under it would leave it writing to the moved file. So the shell calls
   `DELETE http://127.0.0.1:<port>/graphs/<id>` with `<data>/root.token` (the same data folder the
   sidecar serves), which closes everything and moves the folder to `graphs-retired/<id>-<time>/`.
   With nothing listening, `nooklet graph retire <id>` (the bundled CLI) does the same move and
   itself refuses while `serve.pid` names a live server. A server on the port that refuses that
   root token, or does not know the graph, is serving another data folder: nothing is touched.
5. **Then the Trash** (`trash` crate, `NSFileManager trashItemAtURL`), not `rm -rf`. If the Trash
   refuses, the graph stays in `graphs-retired/` and the error says where.

Rejected: `rm -rf` (not recoverable); leaving it in `graphs-retired/` only (recoverable, but a
person deleting a graph expects to find it in the Trash and to get the space back by emptying it);
moving `graphs/<id>` to the Trash directly (the running server would keep the moved database open);
Finder's AppleScript `delete` (the `trash` crate's default: offers "Put Back" but asks for an
Automation permission). Costs: Finder may not offer "Put Back" for an `NSFileManager` trash, so
restoring is dragging the folder back and renaming it; the webview's replica of the deleted graph
(OPFS file, localStorage entry) stays in the bundled server's origin storage (B-880).

**Listing a server's graphs (B-787).** A seventh request, `list-server-graphs` with an address and
a root token. The shell makes the web client's `GET <server>/graphs` from Rust
(`connect.rs#list_server_graphs`) and answers with `{id, label, address}` rows; the page offers
them and fills the address of the one picked. The root token is used for that one request: nothing
on that path takes the keychain or writes a file, no error quotes it, and the form clears it once a
graph is picked.

The server has no op that turns a root token into a device token for an EXISTING graph:
`POST /graphs` mints an admin token only for a graph it creates, `pairing.create` needs that graph's
admin token, and the graph app's bearer check (`auth/tokens.ts#bearerAuth`) reads only the graph's
own token table, never the root token. So the desktop form, like the phone's and the browser's,
then asks for the picked graph's device token or a pairing link. Adding a root-gated "mint a device
token for graph X" endpoint would remove that step, but it would make the root token a key to every
graph's data rather than to the list, which ADR 025 kept it from being; not done.

Both requests are announced by flags in the script (`deleteMac`, `listServerGraphs`, as `reveal`):
a server graph's page comes from that server and may be newer than the shell, and without the flag
it would send a request nothing answers.
