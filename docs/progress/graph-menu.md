# Progress: graph menu in the sidebar (B-709), live control off on phones (B-708), desktop add-server via the shell (B-704)

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
- [x] Simulator probe step `graphmenu` (`tools/probes/phone-ui/`).
- [ ] Verification run recorded below; commit.

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

## Coordination

The phone-input agent edits the switcher's token/URL inputs and ConnectView. This branch keeps the
form markup in place (only `hidden=` added to the token label and root-token link, and the submit
button wrapped); expect a small textual conflict in `GraphSwitcher.tsx`'s add form on merge.

## How to resume

Read this file, `git log c9d993b..HEAD`, then continue with the first unchecked item.

## BUGS.md updates to fold in

(see bottom, filled when verification is done)
