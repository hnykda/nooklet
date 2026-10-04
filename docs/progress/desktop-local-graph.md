# Progress: a local graph from the desktop app's switcher (B-643), whimsical names (B-644)

Branch `worktree-agent-a72408d2a6d0b0d34`, based on `main` at `c3302f6`. Not merged.

## Status

- [x] B-643 cause found (below).
- [x] Model decided (below).
- [x] Name generator + tests (B-644): `apps/web/src/data/graph-names.ts` (100 names),
      `bootstrap.ts#newLocalGraphName`; used by `createLocalOnlyGraph` (switcher, phone),
      `chooseLocalOnly` (set-up screen's "Just this device", both paths) and the desktop's
      "New graph on this Mac". The B-612 stranded-install rescue keeps "This device" on purpose (it
      is the device's old notes coming back, not a new graph). No existing entry is renamed.
- [x] Server CLI `nooklet graph create <id> [--label]` / `graph list`
      (`registry.ts#createGraphForCommand`; also creates "default" on an empty data dir, or serve's
      zero-config default would be skipped and the bare address would 404).
- [x] Web: `bootstrap.ts#adoptAddressBarGraph` (called first in `main.tsx`); switcher on the
      desktop: "New graph on this Mac" in the add choice, an "On this Mac" group listing the
      bundled server's graphs that are not rows already, the shell's error shown
      (`nooklet:desktop-error`).
- [x] Rust: `active_local_graph`, `list_local_graphs` (reads `graphs/*/graph.json`), injected
      `localGraphs`/`activeLocalGraph`, `on_navigation` (`parse_shell_request`,
      `handle_shell_request`, `local_graph_in_url`), `set_active_graph(id, localGraph)`.
- [x] Launcher: opens `/g/<activeLocalGraph>`; picker lists This Mac's graphs.
- [x] ADR 028 written (renumbered from 027 at merge: 027 is conflict copies).
- [ ] Verification: see below.

## B-643: cause (confirmed by reading, then by the e2e below)

`apps/web/src/shell/GraphSwitcher.tsx`: `const showLocalOption = platform.name === "capacitor"`.
The desktop app is the web platform (`platform/index.ts` picks `capacitorPlatform` only when
`window.Capacitor.isNativePlatform()`); `platform/desktop-shell.ts` is a separate flag the switcher
never read. So "Add a graph" on the desktop goes straight to the connect form, in local and remote
mode alike. Deliberate at the time (the switcher's header: "a browser tab always has SOME origin
behind it, so 'no server at all' is only ever a real choice under Capacitor"), but the desktop app
is not a browser tab: it has its own server.

## Decision: on the desktop, "a local graph" is a new graph on This Mac's bundled server

Options considered:

1. **A browser-local (OPFS) replica inside the window's origin** (what the phone does). Rejected.
   The window's origin is whichever server it is showing (`http://127.0.0.1:6200` in the owner's
   test), so the graph would live in that server's storage partition: invisible from This Mac or
   any other server, gone if that server entry is removed or its address changes, and the web
   code treats an entry with no `baseUrl` on a served origin inconsistently (`hasSyncTarget`,
   `apiBaseUrl` fall back to the page's own `/g/<slug>`, i.e. it could sync into the server it
   sits on). No Markdown mirror and no MCP for agents either.
2. **Only point the user at the picker's "This Mac"**. Rejected as the whole answer: that is the
   sidecar's one default graph, not a new graph, and B-643 asks to create one.
3. **A new graph on the bundled sidecar server** (ADR 025: a server hosts N graphs). Chosen. It
   lives in `~/.nooklet/default/graphs/<slug>/` like This Mac's default graph: real SQLite, the
   Markdown mirror, MCP, reachable from the CLI and agents, independent of which server the window
   happened to be on, and promotable later the same way as any server graph.

How it works without any IPC from the page (Tauri refuses `invoke` from a server origin, proven in
`desktop-remote-mode.md`; the sidecar is not even running in remote mode):

- The switcher (desktop shell only) navigates to a sentinel address
  `http://nooklet-desktop.invalid/new-local-graph?label=<name>`. `.invalid` never resolves
  (RFC 2606), so if nothing intercepts it the navigation fails rather than reaching anyone.
- `main.rs`'s `on_navigation` intercepts it (returns false), creates the graph with the sidecar's
  own CLI (`node server.mjs graph create <slug> --label <name> --data <dataDir>`), records it as
  `active_local_graph`, sets This Mac active and restarts (the same `request_restart` every other
  switch uses). The launcher then opens `http://127.0.0.1:<port>/g/<slug>`.
- `open-local-graph?id=<slug>` does the same for an existing This-Mac graph (rows in the switcher
  when the window is on another server).
- Same-origin navigation on the sidecar to `/g/<slug>` is observed (allowed) and persisted as
  `active_local_graph`, so the next launch reopens the graph last used.
- Cost: any page shown in the window can trigger those two requests (create an empty graph, or
  switch to a This-Mac graph, then restart). Both are benign and visible; nothing is read or
  deleted.

Found on the way and needed for this: loading `/g/X` while this origin's active list entry is
`/g/Y` showed Y's data under X's URL (`apiBaseUrl()` prefers the active entry). The address bar
now wins on web/desktop (`adoptAddressBarGraph`).

## Verification (exact, `884f469`)

- `cargo test` (apps/desktop/src-tauri, `CARGO_TARGET_DIR` in scratch, empty `apps/desktop/sidecar/`
  so the build script finds its resource dir): 17 passed (11 before + 6 new).
- `pnpm -r test`: core 473, plugin-api 17, server 785, web 1547, all passed.
  `pnpm --filter @nooklet/desktop test`: 4 passed.
- `pnpm -r typecheck` clean; `pnpm exec biome check . --diagnostic-level=error` clean (1173 files).
- e2e (chromium, port 6420): `desktop-local-graph.spec.ts` 4/4, `desktop-launcher.spec.ts` 8/8 (6
  old + 2 new), and graph-switcher, local-graphs (`LOCAL_GRAPHS_RUNS=2`), graph-mismatch-discard,
  desktop-shell, remote-device, search-local-only, sync-connection-states, local-page-creation,
  sync-timeout: all passed after one test fix (below).
- Full chromium e2e suite: 709 passed, 2 skipped, 2 failed: `pages.spec.ts` "a page created through
  the API appears in the open sidebar without a reload" and `plugins.spec.ts` "deleting the open
  page asks word count about it without a 500 (B-610)". Both files re-run alone: 22/22 passed. So
  order-dependent in the full run; not run on `c3302f6` to show they are pre-existing, and neither
  touches the graph list, the switcher or `/g/` routing.
- Red without the fix: "once made, the new graph opens on This Mac's server..." fails with
  `adoptAddressBarGraph()` commented out (requests went to `/g/default`). The component test
  "offers a new graph on this Mac" cannot pass on `c3302f6` (no such option there).
- Behaviour change caught by the suite: `graph-switcher.spec.ts` "adding an existing remote graph"
  went to a bare `/page/...` after switching to `gs-second`, which the server redirects to
  `/g/default/...`; it used to show gs-second's data under default's URL, now it opens default. The
  test now visits `/g/gs-second/page/...`.

## Still unverified

- The real desktop window: no GUI launch (owner was using the app). That WKWebView reports the
  switcher's `location.assign` to `on_navigation` was read in wry 0.55.1
  (`wkwebview/navigation.rs`), not observed. Also unobserved: `nooklet graph create` through the
  bundled sidecar's `node server.mjs` (the CLI itself is tested via tsx), the restart into the new
  graph, and the error event reaching the switcher from Rust.
- When the app reuses an external server already on its port, the new graph goes into the app's
  data dir, which may not be what that server serves.

## BUGS.md updates to fold in

- **B-643** → fixed (`884f469`). Cause: `GraphSwitcher.tsx` offered a local graph only when
  `platform.name === "capacitor"`; the desktop app is the web platform. Model chosen: a new graph on
  This Mac's bundled server (ADR 028), via a shell request the page makes by navigating to
  `nooklet-desktop.invalid`. Tests: `e2e/tests/desktop-local-graph.spec.ts` (3 desktop cases),
  `e2e/tests/desktop-launcher.spec.ts` two B-643 cases, `GraphSwitcher.test.tsx` "B-643: the
  desktop app" (4), `desktop-shell.test.ts` (2), `cli-first-run.test.ts` "graph create" (2), Rust
  `main.rs` tests (6). Real window unverified.
- **B-644** → fixed (`884f469`). Tests: `data/graph-names.test.ts` (6), `bootstrap.test.ts` "B-644:
  each new local graph gets its own curated name", e2e `desktop-local-graph.spec.ts` "B-644: on the
  phone...". Existing names (including "This device") are never renamed; the B-612 rescue still
  labels the recovered graph "This device".
- **New, fixed** (medium): on web/desktop, loading `/g/X` while this origin's active entry was `/g/Y`
  showed Y's data under X's address (router followed the URL, every request followed the entry).
  Fixed by `bootstrap.ts#adoptAddressBarGraph`. Tests: `bootstrap.test.ts` "adoptAddressBarGraph"
  (3), e2e "once made, the new graph opens..." (red without it). Consequence: a bare address, which
  the server redirects to `/g/default`, now opens default even if another graph was active.
