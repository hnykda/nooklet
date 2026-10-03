**Superseded 2026-09-16**: `DesktopConfig`'s single `remote_url` slot this file describes was
replaced by a list (`remote_graphs` + `active_graph_id`) as ADR 025's M6 — see
`docs/progress/multi-graph-hosting.md`'s own M6 section. Old `desktop.json` files in this file's
shape still load (migrated on read, unit-tested). Kept below as the historical record of the
original single-server decision, which M6 built directly on top of rather than redesigning.

# Progress — desktop remote-client mode

The desktop `.app` (`apps/desktop`) always spawned its own bundled `nooklet serve` sidecar and was
its own canonical graph — self-contained, but with no way to instead become a client replica of a
server the owner already runs elsewhere (the role the phone's Capacitor build has, see
`docs/progress/mobile-ios.md`). Owner: "I thought the desktop should work on its own, offline, and
connect to a server if set up." Owner confirmed the current standalone graph (`~/.nooklet/default`)
has no real data worth preserving, so this is a clean two-mode design, not a migration.

## Architecture decision (confirmed, not assumed)

nooklet is one canonical server plus N client replicas — no server-to-server sync exists or should
exist. So "remote mode" cannot mean "sync my local graph with a remote one"; it means this Mac
stops being a server at all and becomes a plain client, exactly like the phone. Concretely: **which
URL the Tauri window loads, and whether a sidecar is spawned, is now a persisted native choice**
(`desktop.json`) — nothing in `apps/web`'s shared client code needed to change, because a real
`https://` origin is not the Capacitor problem (`capacitor://localhost` can never be a real server's
origin; a Tauri window navigating to a real URL already can be, same as a browser tab). The existing
paste-a-token `ConnectView.tsx` handles auth for a remote desktop exactly as it already does for any
non-loopback device.

## Done (committed 2026-10-03, together with ADR 025's M6, which reworked it)

1. `apps/desktop/src-tauri/src/main.rs`: `DesktopConfig { remote_url: Option<String> }` persisted at
   `<app_config_dir>/desktop.json`; `normalize_remote_url` (pure, unit-tested) requires `http(s)://`
   and strips trailing slashes. `setup()` skips the entire spawn-or-reuse block when a `remote_url`
   is configured or the picker is being shown (`show_picker`) — `ServerProcess` stays unused, no
   local server runs. New commands `set_remote_server` (persist the choice; validates even a
   hand-edited config file) and `quit_app` (so the launcher's "quit and reopen" step is a button,
   not an instruction to find Cmd+Q). New menu item **Switch Server…** writes a one-shot sentinel
   (`show_picker_once`) and quits — see the file's own doc comment for why a relaunch, not live
   re-navigation, is how a mode change takes effect. `shell_script()` now also injects `remoteUrl`/
   `forcePicker` so the launcher knows which of three things to do before trying anything.
2. `apps/desktop/src-tauri/Cargo.toml`: `serde_json` moved from `dev-dependencies` to
   `dependencies` (now used outside `#[cfg(test)]`).
3. `apps/desktop/launcher/index.html`: extended with a picker, **redesigned mid-task per the
   coordinator's B-563 note** to mirror `apps/web/src/views/ConnectView.tsx`/`connect.css`'s
   choice-first pattern (owner feedback: a plain URL field read as "syncing is mandatory") —
   two option cards ("Just this device" / "Sync with a server", each with an inline SVG lifted from
   `lucide-solid`'s `smartphone`/`server` icon path data, no new dependency) rather than a form
   shown by default. Picking "Sync with a server" reveals a `‹ Back` + URL field + Connect, which
   verifies reachability (`/healthz`, no-cors) *before* persisting — same discipline as
   `ConnectView.tsx`'s `connect()`. Picking "Just this device" when nothing was actually configured
   just closes the picker and resumes the normal connect flow, rather than forcing a needless
   quit/relaunch. A real mode change ends with "Saved — nooklet will quit now," then `quit_app`.
   `apps/web/src/platform/desktop-shell.ts`'s doc comment updated to list `Switch Server…` among the
   shell-only menu items.
4. Docs: this file; `apps/desktop`'s own files carry the detailed doc comments (see above) rather
   than duplicating them here.

## Verified for real (not just code review)

- `cargo check`/`cargo test` clean: 7 tests (6 pre-existing + 1 new for `normalize_remote_url`).
  Isolated build: **`apps/desktop/src-tauri/target/` on this machine is stale/cross-contaminated**
  (its cached build script referenced a path under `<repo>/...`, a different
  checkout) — worked around with `CARGO_TARGET_DIR` pointed at scratch rather than touched; not this
  task's to fix, flagging it since a plain `cargo check` in that directory will reproduce it.
- `pnpm --filter @nooklet/desktop test` (4) and `pnpm --filter @nooklet/web typecheck` both clean.
- `biome check` clean on `launcher/index.html` and `desktop-shell.ts` (caught and fixed a real
  a11y issue: the two decorative SVGs needed `aria-hidden`).
- **The security boundary — proven empirically, per the coordinating session's brief, not assumed**:
  built a devtest binary (`TAURI_CONFIG='{"identifier":"com.nooklet.desktop.devtest"}'`, isolated
  `CARGO_TARGET_DIR`/`NOOKLET_PORT`/`NOOKLET_DATA`), pointed `desktop.json` at a throwaway local HTTP
  server standing in for "a remote nooklet server," and had that page call
  `window.__TAURI_INTERNALS__.invoke("server_status")` and log the result to a file (no GUI
  automation available, so verification is file-based: the page navigates to a logging endpoint with
  the outcome). Result: **`invoke-REJECTED:server_status not allowed. Plugin not found`.** This
  matches (and now confirms empirically) what `server_status`'s own pre-existing doc comment already
  claimed about the *local* sidecar's origin: Tauri's ACL treats any navigated-to real URL — local
  `http://127.0.0.1` or a genuinely remote `https://` — as equally outside the app's own bundled
  origin, with zero capability unless a capability file explicitly grants it, which this app still
  defines none of. Remote mode therefore introduces no new IPC surface at all.
- **Standalone mode (no config) still works, actually verified live, not just by code inspection**:
  same devtest binary, `desktop.json` removed, launched — it spawned the real bundled sidecar
  (`apps/desktop/sidecar/` was already assembled in this checkout) and served correctly on the
  isolated port/data dir. This was better verification than expected to be possible without a fresh
  `pnpm sidecar` run.
- Every test launch was killed within ~1–2 seconds of the picker/probe outcome being captured, to
  minimize how long a window could steal focus on the owner's machine (no GUI automation tool was
  used to click anything — every window shown was headless-in-effect, immediately closed). One
  incident: killing the standalone-mode run with `kill`/`kill -9` bypassed `RunEvent::Exit`'s child-
  cleanup (that handler only fires on a normal window-close/quit), orphaning the sidecar's `node`
  child process on the devtest port. Caught immediately via `ps`/`lsof` and killed; confirmed clean
  afterward. Not a defect in the feature — a property of how *this session* tested it — but worth
  knowing before killing a running instance externally again.
- `~/Library/Application Support/com.nooklet.desktop.devtest/` (the devtest config dir) and the
  throwaway HTTP server were removed after testing. The owner's real app/config/port 6100 were never
  touched — confirmed not running before starting (`ps`, `lsof`).

## Not done / explicitly unverified

- **No GUI interaction was exercised at all**: nobody clicked "Just this device," "Sync with a
  server," Back, or Connect in a real window. `set_remote_server`/`quit_app` are simple and follow
  the exact registration pattern of the pre-existing, working `server_status` command, and the
  validation logic they delegate to is unit-tested, but the actual click-path through the picker has
  not been exercised live — this needs a human (or a GUI-automation-capable session) clicking
  through it once.
- The pre-existing "type a fallback URL to recover" affordance inside `#help` (local-mode-only,
  unchanged by this work) still exists as before; `#open-picker`'s new "Use a different server…"
  link there is new and, per the above, unclicked.
- Android has no equivalent (no `android/` project exists yet at all — separate, unstarted work).
- Live re-navigation of the window from remote mode's content or the local client back to the
  bundled launcher origin was deliberately not attempted (cross-platform Tauri API risk not worth
  taking for this); `Switch Server…` quits instead, by design, not as a shortcut taken under time
  pressure — see `on_menu`'s doc comment.
- The stale/cross-contaminated `apps/desktop/src-tauri/target/` directory noted above was not
  cleaned up — out of scope for this task, flagged for whoever hits it next.

## How to resume

To exercise it for real: `pnpm --filter @nooklet/desktop run sidecar` (if `apps/desktop/sidecar/`
needs refreshing), then either `pnpm desktop` (today's default path, should be unchanged) or write
`~/Library/Application Support/com.nooklet.desktop/desktop.json` with
`{"remote_url":"https://your-test-server"}` and relaunch to see remote mode. `Switch Server…` in the
app menu is the deliberate way back into the picker once running. If something looks wrong, `docs/
BUGS.md` per this repo's own rule — this is the first time any of the picker UI has been seen by a
person at all.
