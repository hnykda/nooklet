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
  keep it.
- **Unverified in a real window** (the owner's check, listed in the progress file): that WKWebView
  delivers each navigation to `on_navigation`, the window swap, the keychain prompt, and the menu
  item. `cargo test` covers the list, migration, verification against a local HTTP listener,
  request parsing, which navigation needs a new window, and — run in Node — which documents see the
  token; Chromium e2e covers the page side with the shell emulated.
