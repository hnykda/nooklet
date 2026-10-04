# Progress: one graph list on desktop (proposal 005, B-780..B-785, ADR 032)

Branch: this worktree's branch, based on `main` at `2ae93c7a`. Not merged, not pushed.
Design: `docs/proposals/005-one-graph-list-on-desktop.md` (accepted 2026-10-04).

## Status

- [x] Read proposal 005, ADR 025/028/029, `graph-menu.md`, `main.rs`, launcher, web switcher.
- [x] BUGS.md: B-780 (umbrella) + B-781..B-785 logged before any fix (`d4053b9f`); marked fixed
      with their tests; B-739 closed; follow-ups B-786, B-787. (A B-788 for a pre-existing biome error in `ImageViewer.tsx` was dropped: main had fixed it by the merge at `6efdb0ae`.)
- [x] Rust: shell-owned list (`graph_list.rs`), migration, Keychain (`token_store.rs`), verify
      (`connect.rs`), always-on sidecar, per-target window, door requests with a request key
      (`c47acd84`); no self-rebuild loop for a token-less server window (`28db1e3f`).
- [x] Launcher shrinks to Connecting… / Couldn't reach (`c47acd84`).
- [x] Web: `DesktopGraphMenu`, `DesktopAddGraph`, `DesktopConnectView`, bootstrap token from the
      shell, desktop mismatch screen, phone wording, `DesktopServerSwitch` removed (`e00f40e0`,
      `17b927db`).
- [x] e2e: `desktop-graphs.spec.ts` (was `desktop-local-graph.spec.ts`), launcher, desktop-shell,
      graph-remove, graph-switcher (`99885785`).
- [x] ADR 032, ADR 028 amendment, PLAN M12 line, user guide (getting-started, features, faq,
      sync-and-offline) (`f918638a`).
- [x] Merged main `0ca331e9` (`6efdb0ae`); full verification below; `pnpm desktop:build --bundles app` builds and bundles.

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

## In flight

- Nothing. Done except the owner's real-window check below.

## Owner's check in the real app (not done by any agent: no GUI run)

Build: `pnpm desktop:build --bundles app`, then run
`apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app` (or install it as usual). The first
launch migrates `~/Library/Application Support/com.nooklet.desktop/desktop.json` once and leaves
`desktop.json.v1.bak` beside it.

1. Launch. It opens the graph that was active (your real server). Because its token is not in the
   Keychain yet, the window shows "Connect to <name>" with the address filled in and, if the old
   version had stored it in that page, the token too. Press **Connect**. Expect: a Keychain prompt
   ("nooklet wants to use…"): **Always Allow**; the window swaps once and the graph opens synced.
2. Quit and relaunch: it opens that graph directly, no form, no prompt (or one more prompt if
   macOS asks again for this build).
3. Click the graph name at the top of the sidebar. Expect: **On this Mac** (This Mac + any other
   local graphs) and **On servers** with one sub-heading per host (your real server, and the two
   dead 127.0.0.1 test servers from the old file). No "device" wording anywhere.
4. Pick **This Mac**: the page changes to This Mac with no restart (no window close/reopen).
5. Pick your server graph again: a window swap (brief flash) and it opens, synced. No token asked.
6. Remove the two dead 127.0.0.1 servers with the trash icon (confirm dialog). They disappear.
7. **Add a graph → Connect to a server**: type your server's address and a wrong token
   (`nk_` + 48 zeros). Expect "That token was rejected…" on the same form. Then an address
   nothing listens on (`http://127.0.0.1:6549`). Expect "Couldn't reach 127.0.0.1:6549: …". Then a
   token of the wrong shape (`abc`): named before anything is sent.
8. **Add a graph → Create on this Mac**: keep the suggested name, **Create**. The new graph opens
   (no restart) and is listed under On this Mac.
9. Rename a row with the pencil; reload (Cmd+R); the new name is still there.
10. Menu bar **nooklet → Graphs…**, with the sidebar closed: the sidebar opens with the menu.
11. Turn Wi-Fi off and pick your server graph: "Couldn't reach <host>." with **Try again** and
    **Open a graph on this Mac**; the latter opens This Mac.
12. Keychain Access → search `com.nooklet.desktop`: one item per server graph you connected,
    account = the graph's address. `desktop.json` contains no token.

## Verification (exact)

On the merge with main (`6efdb0ae` + the B-788 drop):
- `pnpm e2e` (full, port 6480): **857 passed, 0 failed, 6 skipped** (27.9 min).
  An earlier full run before the merge (on `28db1e3f`): 853 passed, 2 failed — `commands.spec.ts:202`
  (B-98, known) and `sync-connection-states.spec.ts:60`; both passed when re-run alone after the
  merge (14 passed), and both were in the coordinator's list of flakes main fixed.
- `pnpm -r test`: core 506, plugin-api 17, server 951, web 1744, desktop (node) 4 — all passed.
- `cargo test` (src-tauri): 33 passed, 1 ignored (`the_real_keychain_round_trips`, writes to the
  login keychain; not run).
- `pnpm -r typecheck` clean; `pnpm exec biome check . --diagnostic-level=error` clean;
  `node tools/leak-check.mjs --tree` clean.
- `pnpm desktop:build --bundles app`: built and bundled `nooklet.app` (not installed, not launched).
- NOT verified: anything in a real WKWebView window (navigation interception, window swap, the
  Keychain prompt, the Graphs… menu item, migration of the owner's real `desktop.json`).

## How to resume

Read this file, then `git log 2ae93c7a..HEAD`, then continue with the first unchecked item.
