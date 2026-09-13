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

**Verification pass (same day, a second agent).** A separately built devtest app
(`com.nooklet.desktop.devtest2`, port 6421, its own `sqlite3 .backup` copy) wired with
`tools/probes/desktop-harness/probe.rs`, which posts `NSEvent`s through `NSApp` from INSIDE the app —
AppKit's own hit-testing, WebKit's key handling and the menu bar's key equivalents, with no
Accessibility permission needed. So clicks, keys and menu choices below marked "verified in the app"
were actually performed. Screenshots: `shots/verify/` in the m11c scratchpad.

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

**Merge note (verification pass):** `main` has since moved the launcher to `apps/desktop/launcher/`
(`m11/delete-launcher`, `frontendDist` changed), so on merge this tracked `dist/index.html` and the
`.gitignore` negation become dead and should be dropped, carrying the `__NOOKLET_DESKTOP__.port`
read into the new launcher. `main.rs` and `AppShell.tsx` also conflict (`git merge-tree`).

---

### B-531 · Hypothesis refuted: the traffic lights do NOT cover Toggle sidebar / Back / Forward
**Status:** not a bug · **Severity:** — · **Found:** 2026-09-13, desktop-shell ·
**Evidence:** `shots/01-base-default-size.png` (client `52e5d20`), `shots/10-final-default-size.png`
(this branch's app, menu and client) · **Test (guard):** `e2e/tests/desktop-shell.spec.ts` › "at the
desktop window's size, Settings, Graph, All pages and Help are reachable by pointer"

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

~~Unverified: that those controls respond to a real click in WKWebView.~~ **Verified in the app**
(verification pass): the window's style mask has no full-size content view; `contentLayoutRect` and
the web view both start at y = 32 pt; the traffic lights sit at y 9–23 pt. Native hit-tests at the
centres of Toggle sidebar, Back, Forward and `?` land on the `WryWebView`; at (16, 16) on
`_NSThemeCloseWidget`; in the empty strip on `NSThemeFrame`. Clicking Toggle sidebar → Graph → Pages →
`?` → Settings at the default 1100×800 did each thing (`shots/verify/v01…v06`).

Window dragging: the 32 pt strip is AppKit's own title bar (`NSThemeFrame`, `isMovable` true), which is
what moves a window with this style; the web top bar has no drag region and needs none while
nothing overlaps it. A synthesized drag moves nothing either way — the window server drags title
bars from the real pointer — so a drag itself is still unverified.

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
**Status:** fixed (the client half tested; the native half built and launched, not clicked) ·
**Severity:** medium · **Found:** 2026-09-13, desktop-shell · **Test:**
`e2e/tests/desktop-shell.spec.ts` › "the native menu's Settings… and Keyboard Shortcuts open the
client's own panels (B-533)" (fails on the old code: nothing listens), `apps/web/src/platform/desktop-shell.test.ts` (5)

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

**Fix.** `main.rs#app_menu` (macOS only — Tauri adds no default menu elsewhere, and neither do we):
Tauri's default item for item, plus *nooklet → Settings…* (Cmd+,), *View → Reload* (Cmd+R) above
Enter Full Screen, and *Help → Keyboard Shortcuts / nooklet Documentation / Report a Bug…*.
`on_menu` handles Reload (`WebviewWindow::reload`) and the two links (system browser, B-534) itself;
Settings… and Keyboard Shortcuts are the client's, so it evaluates
`window.dispatchEvent(new CustomEvent("nooklet:desktop-menu", {detail}))` in the page, and
`apps/web/src/platform/desktop-shell.ts#listenToDesktopMenu` (wired in `AppShell`) opens
`openSettings()` / `HelpMenu`'s now module-level `openShortcuts()`. It listens only when the shell's
`__NOOKLET_DESKTOP__` flag is present. The client binds nothing to Cmd+R, so Reload does not shadow
a command; Cmd+, is bound in both, and by WebKit's `WebViewImpl::performKeyEquivalent` the page
sees it first — opening Settings is idempotent either way.

Verified: the menu builds (the devtest app launches with it; a failing `app_menu` aborts the Tauri
build at startup) and the client half end to end in Chromium. ~~**Not** verified: choosing the items
in the real menu bar, or any key reaching the WKWebView.~~

**Verified in the app** (verification pass): the menu bar is as listed above (plus the items macOS
adds itself: Writing Tools, AutoFill, Dictation, Emoji & Symbols, full screen). Chosen from the menu:
Settings… and Help → Keyboard Shortcuts open the client's dialogs (`v10`, `v11`), View → Reload
reloads. Keys: Cmd+, with a block focused opens Settings (`v09`); Cmd+R reloads. In a plain textarea
Cmd+C, Cmd+V, Cmd+X, Cmd+Z, Shift+Cmd+Z and Cmd+A all work (the page leaves them unhandled, the Edit
menu's items do them); in a block Cmd+C, Cmd+X, Cmd+Z and Shift+Cmd+Z work, and Cmd+V did NOT — a
client bug, B-536, now fixed. The general pasteboard was snapshotted and restored around each run.

---

### B-534 · Links that open a new window do nothing in the desktop app — every external link in a note, and Help's Documentation / Report a bug
**Status:** believed fixed (no test can click in the app here) · **Severity:** high · **Found:**
2026-09-13, desktop-shell (reading Tauri's source for the Help menu) · **Test:** none — see below

Note links render as `<a target="_blank">` (`editor/render/tokens.tsx`), Alt+Enter on a link calls
`window.open(url, "_blank")` (`app/hosts.ts`), and the help menu's Documentation / Report a bug /
Request a feature are `target="_blank"` anchors. In WKWebView a new-window navigation goes to the
UI delegate, and wry 0.55.1 (`src/wkwebview/class/wry_web_view_ui_delegate.rs`,
`create_web_view_for_navigation_action`) returns `None` — nothing happens — unless the app set a
new-window handler (`WebviewWindowBuilder::on_new_window`). `main.rs` sets none.

Verified by reading the source of the exact versions in `Cargo.lock` (tauri 2.11.5, wry 0.55.1),
NOT by clicking a link in the app: this environment cannot send clicks to it (see the top).

**Fix.** `WebviewWindowBuilder::on_new_window` in `main.rs`: hand the URL to the system browser
(`open` on macOS, `xdg-open` / `explorer` elsewhere) and deny the in-app window. Only `http`, `https`
and `mailto` leave the app — `open file:///…/Some.app` launches a program, and a link in a note is
not a reason to run one; anything else is logged and dropped. The Help menu's Documentation /
Report a Bug items use the same function.

**Owner decision needed:** app links (`zotero://select/…`, `obsidian://`, `things:`) stay dead in
the desktop app. `editor/render/safe-href.ts` deliberately lets them render (B-268: people link to
apps, and a browser hands them to the OS after its own prompt), but `open` has no prompt — letting
any scheme through would open `file://` (a `.command` file runs in Terminal), `smb://`, `ssh://` the
same way, from text an agent or another device can write. Options: keep the allowlist (current); add
named app schemes to it; or ask with a native confirmation before any other scheme.

~~Believed fixed, not tested.~~ **Verified in the app** (verification pass; the harness build logs
the URL instead of running `open`): a click on an `https://` link in a journal block, the `?` menu's
Documentation anchor, and Help → nooklet Documentation / Report a Bug… each logged `OPEN <url>` and
the window stayed on the client; a `zotero://` link logged `REFUSED`; a `file://` link never reached
the handler at all (WebKit refuses a file URL from an http page first). Still untested: Alt+Enter's
`window.open`, and the real `open` spawn (deliberately — it would open the owner's browser).

---

### B-535 · The launcher prefers a server URL it saved last time over the port the shell says
**Status:** open · **Severity:** low · **Found:** 2026-09-13, desktop-shell (reading
`apps/desktop/dist/index.html` while passing it the port) · **Test:** none

`serverUrl()` is `localStorage.getItem("nooklet.desktop.serverUrl") || DEFAULT_URL`, and every
successful connect saves the URL. So once the launcher has connected anywhere, the port the shell
reports (`__NOOKLET_DESKTOP__.port`, i.e. `NOOKLET_PORT` or 6100) is never used again for that
WebKit store: moving the app to another port, or a URL typed into the retry box once, sticks.
Harmless while everything is 6100. Not changed here — the launcher is also being reworked for B-430
on `m11/delete-launcher`; the natural fix is to try the shell's port first and keep the saved URL
as the fallback the retry box edits.

---

### B-536 · Cmd/Ctrl+V into a block pastes nothing — the command dispatcher swallows the key for `edit.paste`
**Status:** fixed · **Severity:** high · **Found:** 2026-09-13, desktop-shell verification (checking
that Cmd+C/V/X/A/Z reach the webview, step 3) · **Tests:** `e2e/tests/keyboard-paste.spec.ts` (2, both
fail on the old dispatcher: "hello" stays "hello"), `commands/keymap/dispatch.test.ts` › "never
matches edit.paste's Cmd+V…"

In the block editor a real Cmd+V (Ctrl+V elsewhere) inserts nothing, in the desktop app and in
Chromium alike. `commands/registrations/structural.ts` registers `edit.paste` with
`mac: "Cmd+V"`, `when: "editorFocused"`; `buildKeymap` compiles it like any other row, so
`CommandLayer`'s capture-phase dispatcher matches it, calls `preventDefault()` — which cancels the
browser's paste, so the `paste` event the editor actually handles (`surface.ts`
`domEventHandlers.paste` → `BlockTree#onPaste`) never fires — and runs `edit.paste`, whose editor
side does nothing (no `case "edit.paste"` anywhere). Spec R33 says the row is informational and
"never matched by the keydown dispatcher"; the code did not do that. Every e2e paste test builds a
synthetic `ClipboardEvent("paste")`, which is why none caught it.

Evidence:
- Chromium, Playwright against a real server (`paste-probe2.cjs` in the verify scratch): a plain
  `<textarea>` gets "PASTED" from `Meta+V`; the block editor stays `"hello "`, and a document
  capture listener sees the `V` keydown with `defaultPrevented: true` after the dispatcher.
- WKWebView, devtest2 app, keys sent in-process through `NSApp postEvent` (probe harness): in
  Settings → Custom CSS (a textarea) Cmd+C / Cmd+V / Cmd+X / Cmd+Z / Shift+Cmd+Z / Cmd+A all work
  through the native Edit menu; in a block Cmd+C, Cmd+X, Cmd+Z, Shift+Cmd+Z work and Cmd+V inserts
  nothing (`shots/verify/v08-block-editor-clipboard.png`).

**Fix** (`commands/keymap/dispatch.ts`): the dispatcher skips `edit.paste` rows when matching a key
(R33's "never matched"), so the key's default — the native `paste` event — happens. The row stays
in the compiled keymap, so the palette and Help → Keyboard shortcuts still show Cmd+V. After the fix,
in the devtest2 app: copy a word in a block, Cmd+V → `"hello world world"`, Cmd+Z takes it back
(`shots/verify/v13-block-editor-paste-after-fix.png`).

---

### B-537 · The update reload is a race the page loses when `/api/session` takes over a second — B-532 is not fixed under a slow start
**Status:** fixed (for every client from this fix on; see below) · **Severity:** high · **Found:**
2026-09-13, desktop-shell verification · **Tests:** `e2e/tests/sw-update.spec.ts` › "a newer worker that
takes the page over before the page registered its own still reloads it (B-537)" (fails before: no
reload in 20 s), `apps/web/src/sw/takeover.test.ts` (4) · **Evidence:** `shots/verify/update-A-baseline/`,
`shots/verify/update-B-branch-slow-session/`, `shots/verify/update-C-fix-slow-session/`

B-532's fix (worker `skipWaiting` + `clientsClaim`) relies on the OLD page's `registerSW`
(workbox-window) seeing the new worker's `updatefound` and reloading on its `activated`. Workbox only
tracks an update whose `updatefound` fires AFTER `wb.register()` has attached its listener — and
`main.tsx` calls `registerServiceWorker()` only after `await initBootstrap()`, a round trip to
`/api/session`. `register()` of an already-registered, unchanged script URL does not itself check
for an update (spec: resolves with the existing registration); the check that finds a new build is
WebKit's navigation soft update, which the request log shows exactly one second after the document
request (`GET / … GET /sw.js dest=-` at +1.02 s, every launch). If the page has not registered by
then, the new worker installs and claims the page unseen — workbox's `activated` never fires, no
reload — and the page runs the previous client for the whole session again.

Reproduced in the devtest2 app with the same probe shape as B-532 (fresh store, graceful quits,
harness reading the loaded `index-*.js` and `performance` navigation type):
- baseline, OLD `adadff1` → NEW this branch, no delay: the first launch after the update reloads
  (`nav: "reload"`) onto NEW within ~1.2 s — B-532's claim holds;
- OLD this branch → NEW this branch with index.html's precache revision bumped, `/api/session`
  delayed 2 s by the logging proxy: the first launch after the update shows **OLD for the whole 30 s
  session** (`nav: "navigate"`, never reloaded) although the new worker was fetched at +1.04 s; the
  next launch shows NEW.

A two-second `/api/session` is not exotic for the desktop app: a server the app has just spawned, or
one busy with a large graph at start, answers its first requests slowly, and a slower Mac spends
part of that second evaluating the bundle.

**Fix.** A six-line classic `<script>` in `apps/web/index.html`'s `<head>` listens for
`controllerchange` and reloads when a worker takes over a page that a worker already controlled.
It runs while the HTML is parsed — long before the soft update a second later — so it sees every
takeover, tracked by workbox or not; the first install's claim (page not controlled yet, already the
newest build) does not reload. `sw/register.ts` passes a no-op `onNeedReload` so workbox does not
restart the navigation the listener began.

Proven in the devtest2 app, same slow-session shape (`/api/session` +2 s, OLD = this fix, NEW = this
fix with index.html's revision bumped): the first launch after the update requests the document again
at +1.09 s, right after the soft update's `GET /sw.js` at +1.03 s, and shows NEW (`nav: "reload"`)
for the session; the following launch is a plain `navigate` (no reload loop), and so is the first
launch on a fresh store.

Not rescued: a page still running a client from BEFORE this fix (every build up to and including
B-532's) decides with its old code, so it can lose the race once more on the launch that installs
this fix — the result of `update-B` again. From then on the listener is in the page.

---

### B-538 · In WKWebView a same-origin cross-document navigation leaves the new page a sync follower
**Status:** open (observed, no user path found) · **Severity:** low · **Found:** 2026-09-13,
desktop-shell verification · **Test:** none

After `location.assign("/page/…")` in the desktop app (the verification harness did this), the
indicator read "synced via another tab" and stayed so across three View → Reload; a fresh launch
followed by three reloads stayed "synced". Probably WebKit's page cache keeping the previous
document — and its DB worker holding the leader lock (B-81) — alive. The client only ever reloads
(`location.reload()`) and navigates in-app, so nothing a user does is known to hit this; logged in
case one appears (a plugin, a future full navigation).
