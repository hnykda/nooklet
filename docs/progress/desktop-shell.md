# Progress — desktop-shell (m11)

Branch `m11/desktop-shell` from `52e5d20`. Worktree `.claude/worktrees/wf_dd1ff6ba-1f5-1`.
Bugs inbox: `docs/bugs-inbox/desktop-shell.md` (B-530..B-539).

Owner report: "I don't see any settings dialog anywhere, nor the question mark icon in the desktop
app. not even graph? seems way behind."

## Safety rules (from the coordinator, binding)

- Owner's app: `apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app` in the main
  checkout, port 6100, `~/.nooklet/default`, WebKit data `~/Library/WebKit/com.nooklet.desktop`.
  Never touch any of them. No `/Applications`.
- Devtest app: identifier `com.nooklet.desktop.devtest`, `CARGO_TARGET_DIR=<scratch>/m11c/target`,
  port 6420 (proxy) → 6421 (server), `NOOKLET_DATA=<scratch>/m11c/data` (a `sqlite3 .backup` copy).
  Playwright on 6419.
- Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11c`
  (`shots/`, `data/`, `target/`, `logs/`, `build-app.sh`, `ctl.sh`, `desktop-window` binary,
  `src-adadff1/` = `git archive adadff1` with its web client built, `web-base/` = 52e5d20 client,
  `sidecar/` = 52e5d20 sidecar used to run servers).

## Incident (tell the coordinator)

The owner is using the machine. Launching the devtest app activates it (tao calls
`activateIgnoringOtherApps` on launch), and its window opens where the owner's app window is. At
17:56:46–51 someone typed `[[dru` and deleted it in the devtest window — landing in the SCRATCH
graph copy (`changes` seq 20450–20456), not the owner's; the owner lost those keystrokes. A probe
run's app also exited early once (probably quit by the owner). The update probe now hands focus
back to the previously frontmost app 1.5 s after each launch (`desktop-window give-back`), and
launches are kept to the minimum.

## Findings so far (evidence first)

1. Traffic lights covering the toolbar — **refuted** (B-531, `shots/01-base-default-size.png`):
   `Transparent` ≠ `Overlay`; content starts below a ~32 pt title strip; Toggle sidebar / Back /
   Forward and `?` all visible.
2. Sidebar collapsed by default — confirmed; routes to Graph/Pages via Toggle sidebar, Settings via `?`.
3. `?` visible — confirmed with the current client.
4. Stale client — **confirmed as the cause** (B-532, `shots/update-before-fix/`): first launch after
   an update runs the OLD client all session; the new worker waits. Root cause: `injectRegister:
   false` disables vite-plugin-pwa's autoUpdate `skipWaiting`/`clientsClaim`.
5. Found in passing: launcher page untracked (B-530, fixed); no native Settings/Reload/Help (B-533);
   `target=_blank` / `window.open` do nothing in the app (B-534, from Tauri/wry source).
6. Cannot click or type into the devtest window: no Accessibility permission (`AXIsProcessTrusted`
   false). Screenshots (`screencapture -l`) work.

## Done

- (commit 1, below) B-530 launcher tracked; `NOOKLET_PORT` + `__NOOKLET_DESKTOP__` init script;
  probes `desktop-window.swift`, `logging-proxy.mjs`, `desktop-sw-update.sh`; inbox B-530..B-534.

## Next

1. B-532 fix: `workbox.skipWaiting/clientsClaim` explicitly; test that guards the generated sw.js;
   rebuild; re-run `desktop-sw-update.sh` old=adadff1 → new=fix. Expect NEW within launch 1.
2. B-533 native menu (keep Edit items; Settings… Cmd+, → client; View → Reload Cmd+R; Help items).
3. B-534 `on_new_window` → system browser for http/https/mailto only.
4. Client side of the menu bridge: `platform/desktop-shell.ts` + unit test; Playwright test.
5. Final devtest build screenshot at default size; kill everything; report.

## Decisions

- No top-bar inset / drag region: the evidence (B-531) shows nothing overlaps, so there is nothing to
  inset. Switching to `Overlay` would be a design change, not a fix.
- Old client for the update probe: `adadff1` (same SW config and register code as every build since
  B-20, so it behaves as the owner's installed client does) — visual proof via a label stamped into
  each build's index.html by the probe, not via product code.

## How to resume

Read this file, `git log --oneline 52e5d20..`, `docs/bugs-inbox/desktop-shell.md`. Rebuild the
devtest app with `<scratch>/m11c/build-app.sh` (after `pnpm --filter @nooklet/desktop run sidecar`).
