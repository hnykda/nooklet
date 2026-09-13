# Bug inbox — desktop-shell (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-530..B-539.

Owner's report (2026-09-13, a desktop build from that day): "I don't see any settings dialog
anywhere, nor the question mark icon in the desktop app. not even graph? seems way behind."

Everything below was observed in a **devtest** build of the app (bundle id
`com.nooklet.desktop.devtest`, `NOOKLET_PORT=6420`, a `sqlite3 .backup` copy of the owner's graph),
never the owner's own app or store. Screenshots are in the m11c scratchpad (`shots/`), listed per
entry. The window was only ever observed, never clicked: the process driving it has no macOS
Accessibility permission, so synthetic clicks and keys are dropped (`tools/probes/desktop-window.swift`
prints `accessibility trusted: false`). What that leaves unverified is said per entry.

---

### B-530 · The desktop launcher page is not in git, so a clean checkout cannot build the desktop app
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, desktop-shell (building a devtest
app from a fresh worktree) · **Test:** none automated — `cargo check` in a fresh worktree is the check

`tauri.conf.json` has `frontendDist: "../dist"`, i.e. `apps/desktop/dist/index.html` — the
hand-written launcher page that polls the server and redirects to it. The root `.gitignore`'s
`dist/` swallowed it, so it existed only in the checkout it was written in. In a fresh worktree:

```
error: proc macro panicked
   --> src/main.rs:163:16
163 |         .build(tauri::generate_context!())
    = help: message: The `frontendDist` configuration is set to `"../dist"` but this path doesn't exist
```

The release workflow (`.github/workflows/release.yml`) checks out fresh, so it cannot have built
the app either. Fix: `!apps/desktop/dist/` after the desktop lines in `.gitignore`, and the page
committed as it was in the main checkout (plus reading the port from the shell, below).

---

### B-531 · Hypothesis refuted: the traffic lights do NOT cover Toggle sidebar / Back / Forward
**Status:** not a bug · **Severity:** — · **Found:** 2026-09-13, desktop-shell ·
**Evidence:** `shots/01-base-default-size.png`

The suspicion was that `TitleBarStyle::Transparent` + `hidden_title` puts web content under the
title bar, so the macOS window buttons would sit on the top bar's first three controls and leave
no visible way into the sidebar (and so to Graph and Pages). At the default 1100×800 window, with
the client from `52e5d20`, the screenshot shows otherwise: `Transparent` only makes the title bar
transparent (Tauri's `Overlay` is the style that lays content under it). The title bar is its own
~32 pt strip; the 44 pt top bar starts below it with Toggle sidebar, Back and Forward fully
visible; the sidebar is collapsed; the `?` help button is visible bottom-right. So at the default
size the current client offers Toggle sidebar → Graph / Pages, and `?` → Settings / Keyboard
shortcuts, without a shortcut. The owner's app builds from the same `main.rs`, so it has the same
geometry. What the owner saw is B-532.

Unverified: that those controls respond to a real click in WKWebView (see the note at the top).
Their boxes are not covered by anything native, which is what the hypothesis was about.

---

### B-532 · The service worker never takes over while an older one controls the page — the desktop app runs the previous client for a whole session after every update
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, the owner ("seems way behind"),
reproduced in desktop-shell · **Test:** `e2e/tests/sw-update.spec.ts` › "a newer service worker takes
over an open page and reloads it onto the new build (B-532)" (fails on the old code with the new
worker in `waiting`); probe `tools/probes/desktop-sw-update.sh`, screenshots `shots/update-before-fix/`
and `shots/update-after-fix/` (label crops in each `labels/`)

B-20 switched `vite-plugin-pwa` to `registerType: "autoUpdate"` so a new build would apply itself.
It does not, because `vite.config.ts` also sets `injectRegister: false`, and the plugin only turns on
`workbox.skipWaiting` / `workbox.clientsClaim` for autoUpdate when `injectRegister` is `"auto"` or
unset (`node_modules/vite-plugin-pwa/dist/index.js`, v1.3.0: `if ((injectRegister === "auto" ||
injectRegister == null) && registerType === "autoUpdate") { workbox.skipWaiting = true;
workbox.clientsClaim = true; }`). The generated `dist/sw.js` confirms it: `skipWaiting()` appears
only inside the `SKIP_WAITING` message handler, and there is no `clientsClaim()`. And in autoUpdate
mode `registerSW`'s update function never sends that message (`if (!auto) sendSkipWaitingMessage()`),
while `sw/register.ts`'s `onNeedRefresh` is never called in that mode at all. So a new worker
installs, precaches, and then **waits** for as long as any page is controlled by the old one; the
reload-on-`activated` that autoUpdate relies on never fires.

Reproduced in the devtest app (`tools/probes/desktop-sw-update.sh`, fresh WebKit store, graceful
quits): serve the `adadff1` client and launch; serve the `52e5d20` client and launch again. Each
index.html is stamped with a visible label naming its build and `index-*.js`:

- launch with the old client served: `shell: OLD adadff1 · index-DXnnFemz.js` (as expected);
- **first launch after the server has the new client: still `OLD adadff1`, for the whole 40 s
  session.** The request log shows the update WAS found — `GET /sw.js`, then the new build's
  `/static/index-DxOn0mZf.js` fetched with `sec-fetch-dest: empty` (the new worker filling its
  precache) — but no page ever asked for it;
- second launch: `shell: NEW 52e5d20 (no fix)` — the waiting worker took over only once the app
  had quit and no page was left for the old one to control; third launch: new as well.

So after any update the desktop app shows the previous client for the first whole session, which
is exactly "a build from today that seems way behind". In a browser the same bug pins a tab that
stays open (reloads do not activate a waiting worker; the hourly `registration.update()` just finds
the same waiting worker again). A guess, not checked: the owner's store still holding a Sep 11 client
fits B-430 — the Sep 11 app could not start its own server against the migrated graph, so it may
never have reached a newer client before this build's first launch.

Which client the owner's app shows is also not decided by the app build at all: the shell uses any
nooklet already answering on 6100, and on the owner's machine that is `pnpm nooklet serve` from the
main checkout (`lsof`/`ps`, read-only: pid started 17:22, serving that checkout's `apps/web/dist`).
A rebuilt `.app` alone changes nothing the window loads; rebuilding the client that server serves does.

**Fix** (`apps/web/vite.config.ts`): `workbox.skipWaiting: true` and `workbox.clientsClaim: true`,
explicitly, with the reason beside them; `sw/register.ts` loses the never-called `onNeedRefresh`
whose comment claimed it applied updates. The generated `sw.js` now calls `self.skipWaiting()` on
install and `clientsClaim()`. Nothing else was needed: the old page's own `registerSW` reloads when
a newer worker activates, and that code is already in every installed client since B-20.

Proven twice:
- Chromium (`e2e/tests/sw-update.spec.ts`): a page controlled by this build's worker, a newer
  registration of the same `sw.js` → before: no reload in 60 s, state
  `{"controlled":true,"scriptURL":".../sw.js","waiting":true,"installing":false}`; after: the page
  reloads by itself in ~2 s and settles with nothing waiting (3/3 with `--repeat-each=3`).
- WKWebView, the devtest app (`desktop-sw-update.sh`, same OLD `adadff1` client installed first,
  graceful quits, 6 s / 30 s screenshots): the **first** launch after the server has the fixed client
  already shows `shell: NEW with B-532 fix · index-B8cDJY3A.js` at 6 s, and so do both later
  launches. The request log shows the extra `GET /sw.js` of the reloaded page registering again.

This also rescues clients installed before the fix: the old page's worker never needed to change,
only the NEW worker has to skip waiting, and that is the code the server now serves.

Unverified: the owner's own store (not inspected, by the rules of this task); an app killed rather
than quit (probe quits normally); the reload landing mid-typing in WKWebView (pagehide flush is
covered for browsers by `reload-durability.spec.ts`, not re-run in the app).

---

### B-533 · The desktop app's menu bar has no Settings…, no Reload and an empty Help menu
**Status:** open (fix in progress) · **Severity:** medium · **Found:** 2026-09-13, desktop-shell ·
**Test:** see the fix

`main.rs` sets no menu, so Tauri installs its macOS default (`tauri-2.11.5/src/menu/menu.rs`,
`Menu::default`): *nooklet* (About, Services, Hide, Hide Others, Quit), *File* (Close Window),
*Edit* (Undo, Redo, Cut, Copy, Paste, Select All), *View* (Enter Full Screen only), *Window*, and a
*Help* menu with nothing in it on macOS. So the one place a Mac user looks for Settings (the app
menu, Cmd+,) has none, there is no Reload — the only recovery from a wedged page short of quitting —
and Help is empty. Settings is reachable in the client itself (`?` → Settings, Cmd+, when the
webview has focus), which is why this is medium, not high.

A custom menu replaces that default wholesale, so it has to carry the predefined Edit items over:
on macOS those items are how Cmd+C/V/X/A/Z reach a text field in a webview (Tauri ships them in its
default for that reason). Unverified here: that the keys work in the devtest window, before or
after — no Accessibility permission to send them.

---

### B-534 · Links that open a new window do nothing in the desktop app — every external link in a note, and Help's Documentation / Report a bug
**Status:** open (fix in progress) · **Severity:** high · **Found:** 2026-09-13, desktop-shell
(reading Tauri's source for the Help menu) · **Test:** see the fix

Note links render as `<a target="_blank">` (`editor/render/tokens.tsx`), Alt+Enter on a link calls
`window.open(url, "_blank")` (`app/hosts.ts`), and the help menu's Documentation / Report a bug /
Request a feature are `target="_blank"` anchors. In WKWebView a new-window navigation goes to the
UI delegate, and wry 0.55.1 (`src/wkwebview/class/wry_web_view_ui_delegate.rs`,
`create_web_view_for_navigation_action`) returns `None` — nothing happens — unless the app set a
new-window handler (`WebviewWindowBuilder::on_new_window`). `main.rs` sets none.

Verified by reading the source of the exact versions in `Cargo.lock` (tauri 2.11.5, wry 0.55.1),
NOT by clicking a link in the app: this environment cannot send clicks to it (see the top).

---
