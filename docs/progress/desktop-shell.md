# Progress — desktop-shell (m11)

Branch `m11/desktop-shell` from `52e5d20`. Worktree `.claude/worktrees/wf_dd1ff6ba-1f5-1`.
Bugs inbox: `docs/bugs-inbox/desktop-shell.md` (B-530..B-535). **State: done** (see "Not done").

Owner report: "I don't see any settings dialog anywhere, nor the question mark icon in the desktop
app. not even graph? seems way behind."

## Answer

The owner's app was running a stale client (B-532), not a covered toolbar (B-531, refuted). The
service worker never took over while an older one controlled the page: `injectRegister: false`
silently disabled vite-plugin-pwa's autoUpdate `skipWaiting`/`clientsClaim`. First launch after any
update → the previous client for the whole session. Fixed and proven in Chromium and in WKWebView.
Also: the owner's app talks to `pnpm nooklet serve` from the main checkout on 6100 (read-only
`lsof`/`ps`), so the client it shows is that checkout's `apps/web/dist`, not the `.app`'s sidecar —
after merging, rebuild `apps/web` there (the server re-reads files per request) and relaunch the app
once; expect one reload flash.

## Safety rules (from the coordinator, binding)

- Owner's app: `apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app` in the main
  checkout, port 6100, `~/.nooklet/default`, WebKit data `~/Library/WebKit/com.nooklet.desktop`.
  Never touched. No `/Applications`.
- Devtest app: identifier `com.nooklet.desktop.devtest`, `CARGO_TARGET_DIR=<scratch>/m11c/target`,
  port 6420 (proxy) → 6421 (server), `NOOKLET_DATA=<scratch>/m11c/data` (a `sqlite3 .backup` copy).
  Playwright on 6419.
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11c`
  (`shots/`, `data/`, `target/`, `logs/`, `build-app.sh`, `ctl.sh`, `desktop-window` binary,
  `src-adadff1/` = `git archive adadff1` with its web client built, `web-base/` = 52e5d20 client,
  `web-fix/` = B-532 fix client, `sidecar/` = 52e5d20 sidecar used to run servers).

## Incident (tell the coordinator)

The owner is using the machine. Launching the devtest app activates it (tao calls
`activateIgnoringOtherApps` on launch), and its window opens where the owner's app window is. At
17:56:46–51 someone typed `[[dru` and deleted it in the devtest window — landing in the SCRATCH
graph copy (`changes` seq 20450–20456), not the owner's; the owner lost those keystrokes. One probe
run's app also exited early (probably quit by the owner). After that the probe hands focus back to
the previously frontmost app 1.5 s after each launch (`desktop-window give-back`, confirmed
"frontmost now 75748" every time), and launches were kept to the minimum (2 probe runs × 4, 1 final).

## Done (commits, oldest first)

- `0d08bf6` B-530 launcher tracked; `NOOKLET_PORT` + `__NOOKLET_DESKTOP__` init script; probes
  `desktop-window.swift`, `logging-proxy.mjs`, `desktop-sw-update.sh`; inbox B-530..B-534.
- `47ad4bc` B-532 fix (`vite.config.ts` skipWaiting + clientsClaim; dead `onNeedRefresh` removed) +
  `e2e/tests/sw-update.spec.ts`.
- `ac89619` B-533 native menu + `platform/desktop-shell.ts` bridge; B-534 `on_new_window` → browser;
  `desktop-shell.test.ts` (5), `e2e/tests/desktop-shell.spec.ts` (2).
- (this commit) docs: OPERATIONS §4 client updates, ADR 016 amendment, B-535, progress.

## Evidence (screenshots, all in `<scratch>/m11c/shots/`)

- `01-base-default-size.png` — 52e5d20 client, default window: toolbar clear of traffic lights, `?` visible.
- `02-base-click-toggle-sidebar.png` — the click that did not arrive (no Accessibility permission).
- `update-before-fix/` — OLD adadff1 installed; NEW 52e5d20 served; launch 1 still OLD (early+late),
  launches 2–3 NEW. `labels/` has the label crops.
- `update-after-fix/` — same OLD installed; NEW-with-fix served; launch 1 already NEW at 6 s.
- `10-final-default-size.png` — this branch's app (custom menu builds, own sidecar on 6420), current
  client, default window. Quit normally; its sidecar exited with it.

## Tests (final numbers)

- Web unit: 1,143 passed (incl. `platform/desktop-shell.test.ts` 5).
- e2e Chromium, full suite in two halves on 6419: 229 passed + 1 skipped; 307 passed + 1 skipped +
  1 failed — the failure is B-356 (`page-icons.spec.ts` "clearing the field removes the icon",
  identical message, a known harness race), which passed 3/3 in two separate reruns of the spec.
  New specs: `sw-update.spec.ts` 1 (fails before the fix, 3/3 after), `desktop-shell.spec.ts` 2.
- `pnpm -r typecheck` clean; `cargo check` clean, no warnings; biome clean on touched files (two
  pre-existing `suppressions/unused` warnings in HelpMenu.tsx, not from this branch).

## Not done / unverified

- Nothing was clicked or typed in the WKWebView: no Accessibility permission. So unverified in the
  app: menu items chosen from the menu bar, Cmd+C/V/X/A/Z/,/R reaching the page, links opening in
  the browser (B-534 is "believed fixed"), toolbar controls answering a real click.
- No top-bar inset / drag region: nothing overlaps (B-531), so nothing to inset.
- Owner decisions: B-534 app-scheme links (`zotero://`) stay dead in the desktop app; B-535 left open
  for `m11/delete-launcher`.

## Decisions

- No inset: evidence first. `Overlay` would be a design change, not a fix.
- Old client for the probe: `adadff1` (same SW config and register code as every build since B-20).
  Visual proof by a label the probe stamps into each build's index.html — not product code.
- Fix only the worker (skipWaiting + clientsClaim) rather than a server build-id handshake: the old
  page's own `registerSW` already reloads on a newer worker's `activated`, so the smallest change
  rescues clients installed before the fix too — and the WKWebView probe shows it does.

## How to resume

Read this file, `git log --oneline 52e5d20..`, `docs/bugs-inbox/desktop-shell.md`. Rebuild the
devtest app with `<scratch>/m11c/build-app.sh` (after `pnpm --filter @nooklet/desktop run sidecar`).
Re-run the update proof: `tools/probes/desktop-sw-update.sh <old dist> OLD <new dist> NEW <out>`.

## Verification pass (2026-09-13, second agent) — state: done

Built a separate app from a COPY of `apps/desktop` wired with `tools/probes/desktop-harness/probe.rs`
(`com.nooklet.desktop.devtest2`, `CARGO_TARGET_DIR=<scratch>/m11c/verify-target`, port 6421 proxy →
6491 server, `NOOKLET_DATA=<scratch>/m11c/verify/data`, a fresh `sqlite3 .backup`). The harness posts
NSEvents inside the app, so clicks, keys and menu choices were really performed. Launches waited for
15 s of the owner's idleness and handed the keyboard straight back; the pasteboard was restored.

Confirmed: B-531 (hit-tests and clicks, `shots/verify/v01…v06`), B-532 baseline (`update-A-baseline`),
B-533 menu items and Cmd+, / Cmd+R / Edit keys in a textarea, B-534 links (`OPEN`/`REFUSED` log).

Found and fixed (commits on this branch):
- `611e00b` B-536 — Cmd/Ctrl+V into a block pasted nothing anywhere: the dispatcher matched
  `edit.paste`'s informational row and cancelled the paste. `e2e/tests/keyboard-paste.spec.ts` (2),
  dispatch unit test.
- `8a76e44` B-537 — B-532's reload lost the race with WebKit's 1 s soft update whenever `/api/session`
  was slow (`update-B-branch-slow-session`: OLD all session). Inline `controllerchange` listener in
  `index.html`; `sw-update.spec.ts` B-537 test, `sw/takeover.test.ts` (4); `update-C-fix-slow-session`
  reloads onto NEW at +1.1 s.
- Logged only: B-538 (follower after a cross-document navigation in WKWebView; no user path).

Unverified still: a real window drag (the window server ignores synthesized drags); Alt+Enter's
`window.open`; the real `open` spawn. Merge: conflicts with `main` in `main.rs` and `AppShell.tsx`;
main's launcher move makes B-530's tracked `apps/desktop/dist/` dead (see B-530).

Tests on `8a76e44`: web unit 1,148 passed; `pnpm -r typecheck` clean; e2e chromium full suite in four
chunks on 6497: 537 passed, 2 skipped, 3 failed — all three `editing.spec.ts` `openJournal` tests,
B-453 (order-dependent helper, known on main), which pass 4/4 run alone. New tests fail without their
fixes (keyboard-paste 2/2 fail, B-537 test fails with no reload in 20 s).
