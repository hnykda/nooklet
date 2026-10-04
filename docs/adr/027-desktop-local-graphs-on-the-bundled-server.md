# ADR 027: On the desktop, a "local graph" is a new graph on This Mac's bundled server

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
