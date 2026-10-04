# ADR 028: On the desktop, a "local graph" is a new graph on This Mac's bundled server

Date: 2026-10-04. Status: accepted. Extends ADR 025 (move 1, "new local-only graph"). Work record:
`docs/progress/desktop-local-graph.md`. Bug: B-643.

## Context

ADR 025's move 1 was Capacitor-only: on the phone a local-only graph is an OPFS replica with no
server. The desktop app's switcher therefore never offered it (`GraphSwitcher.tsx` checked
`platform.name === "capacitor"`; the desktop app is the web platform). The owner, on the first
real-device test: the Mac app in remote mode (window on `http://127.0.0.1:6200`) cannot add a local
graph, the phone can.

The desktop app differs from the phone in two ways that matter. Its window always shows some
server's own origin (the bundled sidecar's, or a remote one's), and it ships a server of its own
("This Mac", `~/.nooklet/default`), which ADR 025 already lets host any number of graphs.

## Decision

A new local graph on the desktop is a new graph on the bundled server: `<dataDir>/graphs/<id>/`,
named by the switcher (B-644's generated names), made by the server's own CLI
(`nooklet graph create <id> --label <name>`), opened at `http://127.0.0.1:<port>/g/<id>`.

The page cannot call the shell (Tauri gives a server origin no IPC, and in remote mode the sidecar
is not running), so the switcher navigates to a reserved address,
`http://nooklet-desktop.invalid/{new-local-graph?label=…|open-local-graph?id=…}`, which
`main.rs`'s `on_navigation` intercepts. The shell creates the graph, makes This Mac active on it
(`desktop.json` `active_local_graph`) and restarts, as every other switch already does. The shell
injects This Mac's graphs (`localGraphs`, read from each `graph.json`) so the switcher lists them
from any server, and the launcher's picker lists them too.

## Rejected

- **An OPFS replica inside the window's origin** (the phone's model). It would belong to whichever
  server the window happens to show: invisible from This Mac and every other server, lost when that
  entry is removed or its address changes, with no Markdown mirror, no MCP, no CLI. The web code
  also treats a no-address entry on a served origin inconsistently (`apiBaseUrl` falls back to the
  page's own `/g/<slug>`).
- **Only pointing at the picker's "This Mac"**: that is one existing graph, not a new one.
- **A Tauri capability granting IPC to server origins**: a remote server's page (or a note's
  content) would get the whole command set. The navigation door opens on two benign actions only.

## Costs

- Any page shown in the window can trigger the two requests: make an empty graph on This Mac, or
  switch to one there, each followed by a visible restart. Nothing is read, deleted or sent.
- A restart per switch into or out of This Mac (about two seconds for the sidecar), as before.
- When the app reuses an already-running external server instead of its own, the CLI writes to the
  app's data dir, which may not be the one that server serves.
- That the real window's navigation reaches `on_navigation` was read, not observed: wry 0.55.1's
  `wkwebview/navigation.rs` runs every navigation action through the handler and cancels on
  `false`. No GUI run was made (the owner was using the app); Chromium e2e and `cargo test` cover
  each side separately.

## Amendment (2026-10-04, B-704): a third request, "add a server graph"

The in-app switcher's "add a server graph" verified the server with a request from the page. In the
desktop window the page is some server's origin (`http://127.0.0.1:<port>`), so a server on another
origin is a cross-origin request, and that server's CORS allowlist (`capacitor://localhost`,
`https://localhost` only) refuses it: "Load failed". Same-origin graphs (another `/g/<id>` on the
server the window shows) were never affected.

**Decision.** The same door as the two local-graph requests:
`http://nooklet-desktop.invalid/add-server-graph?url=<address>`. `main.rs` remembers the address
(`remember_remote_graph`, which also treats a bare server address and its `/g/default` as one
graph, as the launcher does), makes it active and restarts — what Switch Server… → Add a server
does. No token travels: after the restart the window shows that server's own page, whose set-up
screen asks for one. The switcher hides its token field for such an address and says so. A plain
browser tab cannot hand anything to a shell; there the form says a graph on another server opens
in its own tab and links it, and sends no request.

The same two requests are also offered on the set-up screen (`views/DesktopServerSwitch.tsx`):
a window on a remote server this device has no token for shows `ConnectView`, not the app, so the
graph menu is unreachable there; "Open a different graph instead" and "Back to This Mac" are the
way out without the native menu.

**Rejected.** Widening the server's CORS allowlist to `http://127.0.0.1:*` or `tauri://localhost`:
every page on the loopback origin of every machine could then call a server with a token it holds,
and the token would still have to be pasted into a page that is not that server's own.

**Cost.** Any page shown in the window can now also make the app switch to an arbitrary server,
after a visible restart. That server's page is then what the window shows, and it gets nothing it
could not get by being opened in a browser: no token or note content passes through the request.
That the real WKWebView window delivers this navigation to `on_navigation` is, as for the other two
requests, read from wry rather than observed (`cargo test` covers parsing and the config change;
`e2e/tests/desktop-local-graph.spec.ts` "B-704…" covers the page's side in Chromium).
