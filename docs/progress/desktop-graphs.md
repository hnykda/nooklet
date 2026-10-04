# Progress: one graph list on desktop (proposal 005, B-780..B-785, ADR 032)

Branch: this worktree's branch, based on `main` at `2ae93c7a`. Not merged, not pushed.
Design: `docs/proposals/005-one-graph-list-on-desktop.md` (accepted 2026-10-04).

## Status

- [x] Read proposal 005, ADR 025/028/029, `graph-menu.md`, `main.rs`, launcher, web switcher.
- [x] BUGS.md: B-780 (umbrella) + B-781..B-785 logged before any fix.
- [ ] Rust: shell-owned list (`graph_list.rs`), migration, Keychain (`token_store.rs`), verify
      (`connect.rs`), always-on sidecar, per-target window, door requests with a request key.
- [ ] Launcher shrinks to Connecting… / Couldn't reach.
- [ ] Web: desktop data source + menu + add form + no-token screen; bootstrap token from shell;
      mismatch on desktop; phone wording; remove dead code.
- [ ] ADR 032, ADR 028 amendment, user docs.
- [ ] Tests: Rust, web unit, e2e; full runs; desktop build; leak check.

## Design decisions (and deviations from the proposal)

- **The init script cannot change after the window is built** (Tauri 2.11 / wry 0.55 add user
  scripts at creation only; there is no API to swap them). The proposal assumed the token could be
  handed over through it "without a page round-trip"; it can, but only for the graph the window
  was BUILT for. So the shell builds a new window whenever it opens a server graph whose token the
  current window's script does not carry, or after the list changed (dirty flag), and closes the
  old one. Navigations between This-Mac graphs, and from a server graph to This Mac with a clean
  list, are plain navigations. Cost: a window swap (brief flash) when switching to a server graph.
  Recorded in ADR 032.
- **Token scoping**: the script carries at most ONE token, the target graph's, and defines it on
  `__NOOKLET_DESKTOP__.graphToken` only when `location.origin` equals the target's origin and
  `location.pathname` is the target's path or below it. Main frame only (Tauri's
  `initialization_script`, not `_for_all_frames`), so no iframe ever gets it.
- **Requests page → shell**: still the B-643 navigation door (`nooklet-desktop.invalid`), now
  carrying a per-window random `key` that only the main-frame document gets (from the init
  script); a request without it is ignored. That shuts out iframes (whose navigations also reach
  `on_navigation`). Replies go back as a `nooklet:desktop-reply` event (`window.eval`), matched by a
  request id.
- **Switching** = the page navigates to the graph's address; `on_navigation` decides whether that
  needs a new window (above) and records the last-opened graph in `desktop.json`.
- **This-Mac graphs** come from `<data>/graphs/*/graph.json` as before (no second list); their
  display names can be overridden in `desktop.json` (`mac_labels`). They are not removable from
  the menu (they are folders on disk); logged as a follow-up.
- **Per-origin localStorage entries stay as replica bookkeeping** on desktop (replica key,
  `graphInstanceId` for mismatch detection): dropping them would orphan existing replicas and their
  unsynced ops. The MENU no longer reads them on desktop, and tokens no longer come from them.
- **Migration**: an older `desktop.json` (`remote_graphs`/`active_graph_id`/`active_local_graph`,
  or the older `remote_url`) is read once, rewritten in the new shape, and the old file kept as
  `desktop.json.v1.bak`. No entry is dropped (dead 127.0.0.1 test servers included; they can be
  removed from the menu). A migrated entry has no Keychain token: opening it shows the add form
  pre-filled with its address (and with the token an older version left in that origin's
  localStorage, if any).
- "Show graphs on this server (root token)" is not offered on desktop: it is a cross-origin
  request, and the shell has no use for a root token. Phone/web keep it.

## How to resume

Read this file, then `git log 2ae93c7a..HEAD`, then continue with the first unchecked item.
