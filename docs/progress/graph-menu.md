# Progress: graph menu in the sidebar (B-709), live control off on phones (B-708), desktop add-server via the shell (B-704), safe graph removal (B-712)

Branch `worktree-agent-aead121208475562a`, based on `main` at `c9d993b`. Not merged. Owner requests
2026-10-04.

## Status

- [x] B-709: graph switching is the left sidebar's title (`shell/Sidebar.tsx` mounts
      `shell/GraphSwitcher.tsx`); top-bar icon removed (`shell/AppShell.tsx`).
- [x] B-708: `/ui/live` off and badge hidden by default on Capacitor/touch-only
      (`live/device-default.ts`, `live/consent.ts`, `live/ConsentBadge.tsx`); Settings → Agent access
      (`views/SettingsPanel.tsx#AgentAccessSection`); ADR 015 amendment.
- [x] B-704: desktop shell request `add-server-graph` (`platform/desktop-shell.ts`, `main.rs`
      `ShellRequest::AddServerGraph`, `remember_remote_graph`, `graph_address`); plain web says a
      server on another origin opens in its own tab; ADR 028 amendment.
- [x] Simulator probe step `graphmenu` (`tools/probes/phone-ui/`); screenshots
      `tools/probes/phone-ui/10-drawer.png`, `11-graph-menu.png` (iPhone 17 / iOS 26.5, private
      headless device, deleted after).
- [x] Committed `75b71c1` (lint), `513828c` (B-708), `8a97ec6` (B-709 + B-704); merged main.
- [x] B-712 (coordinator, HIGH, added mid-task): typed-`delete` removal dialog
      (`shell/graph-removal.ts`, `app/confirm-dialog.tsx` `warning`/`typeToConfirm`), per-graph
      unsynced count (`data/pending-memo.ts`, recorded by `shell/SyncIndicator.tsx`).
- [x] B-712 committed `5d71ff3`; merged main (B-714) `f1fe169`: "Add a server" disabled with a
      reason on a B-714 device-only copy, and `submitPromote` refuses it before creating anything.
- [x] B-704 remote-origin follow-up (owner report via coordinator): `views/DesktopServerSwitch.tsx`
      on the set-up screen (desktop shell only): "Open a different graph instead" (address →
      `add-server-graph`) and "Back to This Mac" (`open-local-graph?id=default`).

## Decisions

- **Sidebar menu design (B-709).** The title is the open graph's name, a step larger and semibold,
  with a place glyph (server / laptop / phone) and an up-down chevron; no box until hover. Its
  accessible name is `"<name>, switch graph"`, so tests and screen readers find it by either. The
  menu is `position: fixed`, placed under the title on open (`placeUnder`): the sidebar is
  `overflow-y: auto` and would clip an absolute popover to 15rem. Width `min(288px, 100vw-16px)`.
  Rows grouped by where the graph lives: "On this device" (no `baseUrl`: Capacitor local-only),
  "On this Mac" (an entry on `http://127.0.0.1:<shell port>`, plus This Mac's graphs this origin has
  no entry for), "On a server". The per-row kind icon moved to the group heading. The open graph:
  accent ink + check icon + `aria-current="true"`. Rename/promote/remove unchanged.
- The "On this Mac" group now also holds This-Mac graphs that ARE entries (before, only unlisted
  ones had a group); `desktop-local-graph.spec.ts` B-643 case 3 updated to match.
- **B-704 web vs shell.** Decided per typed address, reactively: if its origin differs from the
  page's (never under Capacitor), the token field and the root-token link hide (`hidden`, so the
  phone-input agent's input attributes are untouched); in the shell the button reads "Add and
  restart" and hands `graphBaseUrl(url)` to the shell; in a tab a note + "Open <host> in a new
  tab" link replace Connect, and submit does nothing. No token goes to the shell.
- **B-708 scope of "touch-only".** `detectPlatformFromEnvironment().mobile` (iOS/Android UA, or
  coarse pointer without hover) or Capacitor. Only the default; a stored choice wins. Badge shown
  iff desktop, or either switch on.
- Fixed in passing: `apps/web/src/sync/http-transport-stall.test.ts` (from `c9d993b`) failed
  `biome check --diagnostic-level=error` (noUnsafeOptionalChaining); rewritten with a local.

- **B-712 removal.** One path removes a graph (`GraphSwitcher.tsx#confirmRemove`); the old inline
  "Remove / Cancel" pair is gone. Rules (`shell/graph-removal.ts`): local-only — warning "only
  copy … cannot be undone", typed `delete`, "Delete forever"; server — "the server at <host> keeps
  it, other devices unaffected", plain confirm when the device KNOWS it has 0 unsynced, typed +
  "N changes … will be lost" when N>0, typed + "cannot tell" when unknown; This-Mac — always typed,
  "stays on this Mac … nothing is deleted from the Mac" (removal never touched the bundled
  server's data; the graph reappears as an unlisted "On this Mac" row).
- **Why a remembered count.** Only the open graph's replica is loaded, and only non-open graphs
  can be removed, so the count is what the sync engine last reported while that graph was open
  here (`nooklet.pendingCount.<entryId>`), plus ops still in that replica's B-247 journal.
  Unknown is never treated as zero.
- **Export first.** The client has no whole-graph export/backup (only per-page "Export as
  markdown", which needs the graph open). The dialog says so and points at "Add a server for this
  graph" (promote) and per-page export. Follow-up logged below.
- The desktop launcher's own picker (`apps/desktop/launcher/index.html`) still removes a remote
  server row in one click: it only edits `desktop.json`; that origin's replica stays in its own
  storage and resumes if re-added, so nothing is lost. Left as is.

## Coordination

The phone-input agent edits the switcher's token/URL inputs and ConnectView. This branch keeps the
form markup in place (only `hidden=` added to the token label and root-token link, and the submit
button wrapped); expect a small textual conflict in `GraphSwitcher.tsx`'s add form on merge.

## How to resume

Read this file, `git log c9d993b..HEAD`, then continue with the first unchecked item.

## Verification (exact)

On `f1fe169` (merge of main incl. B-714) unless noted:
- `pnpm e2e` (full, port 6545): **817 passed, 5 skipped, 0 failed** (26.0 min). (An earlier full
  run is void: `git merge main` landed mid-run and the phone-input agent's run shares this
  scratchpad's log name.)
- After the remote-origin follow-up: `pnpm e2e desktop-local-graph connect` 14 passed.
- `pnpm -r test`: core 491, plugin-api 17, server 891, web 1683 — all passed.
  `apps/desktop` `pnpm test`: 4 passed. `cargo test` (src-tauri): 19 passed.
- `pnpm -r typecheck` clean; `pnpm exec biome check . --diagnostic-level=error` clean;
  `node tools/leak-check.mjs --tree` clean.
- Simulator (own headless iPhone 17 / iOS 26.5, by UDID, deleted after):
  `tools/probes/phone-ui/run.sh` step `graphmenu` passed; screenshots committed.
- Not verified: the real desktop window (WKWebView) delivering `add-server-graph` to
  `on_navigation` and the restart onto the remote entry; no GUI run.

## BUGS.md updates to fold in

- **B-709 → Fixed** (2026-10-04, graph-menu). The open graph's name heads the left sidebar; clicking
  it opens the graph menu, rows grouped On this device / On this Mac / On a server, the open one
  checked and `aria-current`; top-bar icon removed. Tests: `e2e/tests/graph-switcher.spec.ts`
  "B-709: …", `phone-ui.spec.ts` "B-709: on the phone …" (Chromium + WebKit), `GraphSwitcher.test.tsx`
  "B-709" (3); all switcher specs moved to `e2e/helpers/graph-menu.ts#openGraphMenu`. Simulator:
  `tools/probes/phone-ui/10-drawer.png`, `11-graph-menu.png`.
- **B-708 → Fixed.** `/ui/live` off and the agent badge hidden by default on Capacitor/touch-only
  devices; Settings → Agent access turns it on (badge comes back). ADR 015 amendment. Tests:
  `phone-ui.spec.ts` "B-708: …" (Chromium + WebKit: no `/ui/live` WebSocket before opt-in, one
  after, none after a reload with it off), `agent-access.spec.ts` (desktop unchanged),
  `consent.test.ts` "B-708" (3).
- **B-704 → Fixed (page side; real window unverified).** Desktop: switcher hands a cross-origin
  server to the shell (`add-server-graph`), `main.rs` remembers it (bare origin = `/g/default`),
  activates, restarts. Web: says a graph on another server opens in its own tab, links it, sends
  nothing. ADR 028 amendment. Tests: `desktop-local-graph.spec.ts` "B-704: …",
  `graph-switcher.spec.ts` "B-704: …", `GraphSwitcher.test.tsx` "B-704" (4),
  `desktop-shell.test.ts` "B-704", Rust `b704_*` (2) + 6 new rejected-URL cases.
- **B-704, why the owner reached ConnectView (add to the entry).** The window showed a remote
  server's page with no token for it, so `App.tsx` rendered `ConnectView`, not the shell — the
  graph menu was never on screen. ConnectView's "Sync with a server" outside Capacitor only asks
  for a token for `location.host` (`showServerField` is Capacitor-only); it never navigated
  anywhere. Fixed by `DesktopServerSwitch` on that screen (desktop shell only). The shell's flag
  and `on_navigation` apply to every document whatever its origin (`main.rs#shell_script`'s doc;
  read, not observed in a real window). Tests: `desktop-local-graph.spec.ts` "B-704: on a remote
  server's page with no token…" and "…the way back to This Mac".
- **New, out of scope (low): ConnectView's "Just this device" inside the desktop app on a remote
  server's page** would make a replica within that server's origin (ADR 028's rejected model) —
  not checked what `App.tsx#skip` does there; worth a look alongside B-704.
- **B-712 → Fixed.** As in Decisions. Tests: `e2e/tests/graph-remove.spec.ts` (4; the phone case in
  Chromium + WebKit), `graph-removal.test.ts` (5), `pending-memo.test.ts` (2),
  `GraphSwitcher.test.tsx` "B-712" (2) + the rewritten remove case.
- **New, follow-up (low/medium): no whole-graph export or backup in the client.** B-712's "Export
  first" can only point at per-page Export as markdown and promote-to-server. A local-only graph on
  a phone has no one-step way out.
- **New, follow-up (low): a removed graph's replica is never deleted.** `removeGraph` drops the list
  entry only; the OPFS file `/nooklet-<id>.sqlite3` (and its journal/draft keys) stay, unreachable
  — a storage leak, and the reason the dialog says "cannot open it again" rather than "erased".
- **Note:** `apps/web/src/sync/http-transport-stall.test.ts` (from `c9d993b`) failed
  `biome check --diagnostic-level=error`; fixed in `75b71c1`.
