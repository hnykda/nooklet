# Progress — multi-graph hosting

Implementing `docs/adr/025-multi-graph-hosting.md`. Milestones M1-M7, server-first, per the plan
approved 2026-09-15. This file is the durable record — see CLAUDE.md's own rule: update after every
meaningful step, not at the end.

## Status

- [x] M1 — server: graph registry + dynamic `/g/:graphId/*` dispatch
- [x] M2 — server: storage layout + one-time migration
- [x] M3 — server: root token + `/graphs`
- [x] M4 — client: graph list replaces the single-slot model (data layer + OPFS/lock namespacing)
- [x] M4.5 — full-repo e2e stabilization after M1-M4 — **done**, see below
- [x] M5 — client: graph switcher UI + the three legal moves — **done**, see below
- [x] M6 — desktop (Tauri): list-based config + launcher rewrite — **done**, see below
- [ ] M7 — Capacitor (iOS): verify M4/M5 land for free — next, not started

## M1-M4 — done, verified for real

See ADR 025 for the decision. Summary of what's built and proven:

- **Routing**: one process, N graphs, dynamic `/g/:graphId/*` dispatch via a single `.mount()` call
  composing unmodified per-graph `createApp()` instances — verified with a real cross-graph
  WebSocket test (two live `ws://` connections, poke isolation proven, not assumed).
- **Storage**: one SQLite file + mirror + assets per graph under `<dataDir>/graphs/<id>/`, with
  automatic one-time migration from the old flat layout — verified against a real seeded legacy
  data dir, migrated cleanly, content queryable through the real API afterward.
- **Auth**: root token + `/graphs` (list/create), separate from per-graph tokens — verified via
  curl against a running `nooklet serve`.
- **Bare-origin compatibility**: `GET /healthz` (process-level liveness) and a general
  `app.all("*", ...)` 307-redirect-to-`/g/default` fallback, so a single-graph deployment (the
  common case, and the entire pre-ADR-025 e2e suite) keeps working with no server-side URL
  changes. Verified the redirect is genuinely followable end to end (POST body intact) with a real
  `fetch()`, not just a Location header in theory.
- **Client data layer**: `bootstrap.ts` rewritten around a `GraphListEntry[]` + active-pointer
  model instead of three flat `localStorage` keys; `apiBaseUrl()`/`hasSyncTarget()` resolve off the
  active entry, falling back to `samePathGraphPrefix()` (parses `location.pathname`) for a
  zero-config first launch. OPFS filename and the leader-election web lock are namespaced per
  `graphEntryId` so two graphs behind one origin never contend.
- **PWA/service worker**: `/sw.js`, `/manifest.webmanifest` and the workbox runtime chunk are
  served unredirected at bare origin (a SW registration is rejected outright if its script response
  is a redirect) — `graphs/mount.ts`'s `webClientDir` option, `http/web-client.ts`'s new
  `serveStaticFile` export. Workbox's own `runtimeCaching`/`navigateFallbackDenylist` regexes
  updated to recognize an optional `/g/<slug>` prefix on API/sync/asset paths.

772 server tests, 1371 web tests, all typecheck/biome clean.

## M4.5 — full e2e suite: green, except one pre-existing, unrelated bug found and logged

Running the WHOLE e2e suite (not just spec files already touched) surfaced real client bugs no
unit test could reach — exactly what CLAUDE.md's testing section warns unit tests alone miss.
Fixed, in order of discovery:

1. **`App.tsx`'s `<Router>` had no `base`** — needed `base={samePathGraphPrefix() ?? ""}`, or the
   server-side redirect worked but the SPA's own route matching never recognized the resulting URL.
2. **Content-rendered links** (`[[wikilinks]]`, tags, query results, embeds — raw `<a href>` tags
   in `editor/render/*`, not `<A>`) needed the prefix applied manually via a new
   `routes/page-path.ts#rawAnchorHref()`, used only at those specific raw-anchor sites — NOT baked
   into `pageRoutePath()`/`historyRoutePath()` themselves, which must stay app-relative for every
   `<A>`/`navigate()` call site (a real double-prefix bug was hit and reverted mid-session).
3. **`Shelf.tsx`'s "already on this page" check**, and several `location.pathname`-parsing helpers
   (`refactor-host.tsx#currentPageNameFromPath`, `ClientPlugins.tsx`, `CommandLayer.tsx`'s
   `randomPage.currentPageName` and `activeView` detection, `focus-log.ts`, `CalendarButton.tsx`)
   compared/parsed the raw pathname without stripping a possible `/g/<slug>` prefix — centralized
   into one exported `data/bootstrap.ts#appRelativePathname()` rather than fixed ad hoc per site.
4. **Service worker registration** — `/sw.js` was being 307-redirected by the new bare-origin
   fallback, and a SW script response that is a redirect is rejected outright by the browser. Fixed
   as described above.
5. **Four e2e helper/spec files** read/wrote the old flat `nooklet.deviceToken` localStorage key
   directly (`sync-timeout.spec.ts`, `remote-device.spec.ts`, `local-page-creation.spec.ts`) — a
   silent no-op after M4, leaving those tests in the wrong simulated state. Fixed to operate on
   `nooklet.graphs`/`nooklet.activeGraphId`. One of these (`remote-device.spec.ts`'s third test)
   needed a second fix after that: its seeded graph-list entry had no `baseUrl`, and
   `hasSyncTarget()` reads `entry.baseUrl` directly (unlike `apiBaseUrl()`'s fallback chain) — an
   entry with none read as "no sync target at all," so the worker never even tried to pull.
6. **Several e2e specs hardcoded exact href/URL-pathname equality** against paths that now
   legitimately carry a `/g/default` prefix on a real rendered link (`namespace-paths.spec.ts` —
   the most affected — `history.spec.ts`, `untrusted-content.spec.ts`'s asset-open test,
   `mirror-live.spec.ts`/`page-export.spec.ts`'s direct-filesystem mirror-path checks, several
   `a[href='/pages']`-style sidebar-nav selectors). Fixed with a new shared
   `e2e/helpers/api.ts#graphBase(page)`/`withBase(page, path)` pair.

**Full-suite result, final**: 655 passed, 9 failed, 2 skipped. Every failure is accounted for and
none is caused by this milestone's work:
- 6 are `docs/BUGS.md` B-585 — a real, pre-existing bug in B-568's client-side ref-page creation
  (earlier this session, unrelated to ADR 025), confirmed via `git stash` bisection against the
  last clean commit (all pass there) to NOT be caused by any of this milestone's work. Logged with
  full diagnosis in BUGS.md; deliberately not fixed here (a different subsystem — CodeMirror/editor
  debounce interaction — this milestone never touches).
- 2 are `desktop-page-creation-probe.spec.ts`'s own pre-existing, already-documented probes (one
  literally titled "logged, not fixed here" — B-581, from earlier this session).
- 1 (`search-fallback.spec.ts`) is a known order-dependent flake (B-561's own category — passes
  cleanly in isolation, only fails as part of the full suite alongside every other spec sharing one
  server).

## M5 — client: graph switcher UI + the three legal moves — done, verified for real

`apps/web/src/shell/GraphSwitcher.tsx` (new): icon-button-plus-popover next to `SyncIndicator`,
shaped like `CalendarButton.tsx`. List with switch/rename/remove; "Add a graph" (web/desktop: straight
to the connect form; Capacitor: local-only vs. sync-with-a-server choice first); a per-row "add a
server" action on any genuinely local-only entry (promote). Wraps `data/connect-graph.ts`'s
`connectToGraph`/`createGraphOnServer` (also new — shared with `ConnectView.tsx`'s own onboarding
flow, factored out to avoid duplicating the verify-then-remember logic). 12 component tests, all
passing.

**e2e verification** (`e2e/tests/graph-switcher.spec.ts`, new) — the one thing no component test
could prove, since it needs a real worker/OPFS replica and a real second sync round trip: move 2
("add an existing remote graph never mixes its content with the one already active") and move 3
("promoting a local-only graph pushes its full pre-existing local history to the new graph, provable
from the SERVER via a keyword `search` call, not just the client's own screen"). Move 1 (new
local-only graph) is Capacitor-only and already covered by `GraphSwitcher.test.tsx`'s platform-mocked
tests. Both e2e cases pass now — but the FIRST real run against a live multi-graph `nooklet serve`
immediately caught a real bug, exactly per CLAUDE.md's testing philosophy:

- **B-586 (found and fixed)**: `switchTo`/`addServer`/`submitPromote` all ended with a bare
  `location.reload()`, which only lands correctly when the new graph shares the page's current
  origin/prefix (Capacitor) or IS that prefix already. Switching to a second graph on the SAME
  server under a DIFFERENT `/g/<slug>` left the browser's URL, `<Router base>`, and every rendered
  link stuck on the OLD graph's prefix forever, while `apiBaseUrl()` quietly served the new one —
  the next link click or bookmark would have hit the wrong graph for real. Fixed with a new
  `data/bootstrap.ts#graphEntryUrl()` + `GraphSwitcher.tsx#goToActiveGraph()` that navigates
  (`location.assign`) to the entry's actual address instead of blindly reloading in place. Full
  diagnosis, fix, and updated tests in `docs/BUGS.md`.
- **B-587 (found, not investigated)**: an unrelated, pre-existing data-integrity test
  (`apps/web/src/sync/e2e.test.ts`'s "push first" name-collision-with-a-tombstone case) started
  failing a `verifyRebuildParity` check on the server, surfaced by a full `pnpm -r test` run done
  while wrapping up B-586. Confirmed via `git stash` bisection to be pre-existing in the
  accumulated-but-uncommitted tree (passes on `629f572`), not caused by ADR 025/B-586 (the failing
  test never imports `bootstrap.ts`/`GraphSwitcher.tsx`). Logged with full detail, deliberately not
  investigated — different subsystem (sync/tombstone replay), possibly related to B-585's area
  (both touch this session's earlier B-568 ref-page work) but not confirmed to share a cause.

Repo-wide after the B-586 fix: `pnpm -r typecheck` clean, `pnpm exec biome check` clean on every
file this milestone touched (pre-existing lint warnings remain in unrelated files, untouched),
`pnpm -r test` green except the pre-existing B-587 failure above.

## M6 — desktop (Tauri): list-based config + launcher rewrite — done, verified for real

`apps/desktop/src-tauri/src/main.rs`'s `DesktopConfig { remote_url: Option<String> }` (one slot)
replaced with a list: `DesktopConfig { remote_graphs: Vec<RemoteGraph>, active_graph_id:
Option<String> }`, matching M4's client model. "This Mac" itself is never stored — `active_graph_id:
None` means it, exactly as `remote_url: None` did before — only REMOTE entries need remembering.
`RemoteGraph { id, url }`: `id` is a stable hash of the (normalized) URL (`graph_id_for_url`), not a
random uuid — no new crate needed, and it gives re-adding an already-known address the same dedupe-
by-address `data/bootstrap.ts#setConnectedGraphToken`'s Capacitor path already gives the web client,
for free.

Three commands replace `set_remote_server`, matching the approved plan exactly: `add_graph(url)`
(remembers a server, returns its entry — does not activate it), `remove_graph(id)` (forgets one,
falling back the active pointer to "This Mac" if it was the one removed), `set_active_graph(id)`
(persists which entry is active — `None` for "This Mac"). All three, like the old
`set_remote_server`, only persist: the spawn-or-not decision still happens once, at process start,
so every meaningful change (picking a DIFFERENT entry than the one currently active) still ends in
quit + relaunch — `remove_graph` on a non-active entry is the one exception, applied live with no
relaunch, since it never changes what is currently loaded.

**Migration**: old `{"remote_url": "..." | null}` files are told apart from the new shape by the
`remote_url` key alone (the new shape never writes one) and read as an equivalent one-entry-or-empty
list — nothing rewritten to disk until the next real save. `parse_config`/`migrate_remote_url` are
pure functions, unit-tested (old shape with a real address → one active entry, address normalized
the same way `add_graph` would; old shape standalone → nothing remembered, same as a fresh install).
11 Rust tests total (7 pre-existing + 4 new: `graph_id_for_url` stability/distinctness, `active_url`
resolution including the stale-id fallback, `parse_config` on both shapes, the migration itself).

**`launcher/index.html`** (the biggest UI rewrite in this plan, as the approved plan predicted):
the old two-fixed-card picker (`#choice-local`/`#choice-remote`) becomes a real, dynamically rendered
list (`renderGraphList()`/`graphRow()`) — "This Mac" always first (synthesized client-side, since
Rust never sends it as an entry), then every remembered server, each with a remove (✕) button unless
it is the active one, then a dashed "Add a server" card. B-584's fix (re-picking the ALREADY-active
entry still needs a quit+relaunch when `forcePicker` skipped spawning/connecting for this whole
launch) generalized from the old binary `choice-local` handler into one `chooseGraph(id)` covering
every row. Row text is built via `textContent`, not `innerHTML`, even though the old code used
`innerHTML` for its two static cards — a remote row's subtitle is a URL the OWNER typed, and once
rows are rendered from data instead of hardcoded there is no reason to trust it as markup.
`Object.defineProperty(window,"__NOOKLET_DESKTOP__",...)`'s injected shape changed from
`{remoteUrl, forcePicker}` to `{graphs, activeGraphId, forcePicker}` — `apps/web/src/platform/
desktop-shell.ts` (the shared client's OWN read of this global) needed NO change, confirmed by
reading it first: it only ever reads `platform`/`port`, never the remote/picker fields, which are
launcher-only.

**Verified for real, not just code review** (mirroring `docs/progress/desktop-remote-mode.md`'s own
proven devtest-binary technique): `cargo check`/`cargo test` clean (11 tests); `pnpm --filter
@nooklet/desktop test` (4, `status.js` — untouched, unaffected) and `pnpm --filter web exec vitest
run src/platform/desktop-shell.test.ts` (5, confirms the shared client's read of the shell global
is genuinely unaffected) both green; `biome check` clean on `launcher/index.html`. Then a REAL
`tauri build --debug --bundles app` with `TAURI_CONFIG` overriding the identifier
(`com.nooklet.desktop.devtest3`, isolated from the owner's real `com.nooklet.desktop` config/port
the whole time — confirmed clean before and after), launched twice against real `desktop.json`
files:
1. A genuine two-entry `remote_graphs` list, `active_graph_id` pointing at one of them (a throwaway
   local HTTP server standing in for "a remote nooklet server," same technique
   `desktop-remote-mode.md` proved out): the app skipped spawning, resolved the right active URL,
   and the launcher's `reachable`/`location.replace` flow navigated there for real — confirmed by
   having THAT page (fully outside nooklet's own code) read back `window.__NOOKLET_DESKTOP__`
   (re-injected on the new navigation, as its own doc comment claims) and report it: `{"graphs":
   [{"id":"g1",...},{"id":"g2",...}], "activeGraphId":"g1", ...}` — the FULL list, both entries,
   came through the real Rust→JS injection boundary correctly, not just the active one.
2. The OLD single-`remote_url` shape, for real, on a fresh devtest config dir: migrated correctly on
   read — `{"graphs":[{"id":"gff1c00588212ad8b",...}],"activeGraphId":"gff1c00588212ad8b",...}` —
   and the app connected through it exactly as case 1 did.

Both runs' processes were confirmed exited (not force-killed while a child was mid-cleanup) and the
devtest config directory removed afterward; the owner's real app, config, and port 6100 were
confirmed untouched throughout (checked before, not just assumed after).

**Not done / explicitly unverified — same gap the original picker had, never closed**: no GUI
interaction was exercised at all. Nobody clicked a row, "Add a server," a remove button, or Back in
a real window — verified above is the DATA CONTRACT (Rust config → injected JS → the launcher's own
connect logic), not the picker's click-through. `add_graph`/`remove_graph`/`set_active_graph` follow
the exact registration pattern of the already-proven `server_status`/`restart_app`, and the logic
each delegates to is unit-tested, but this needs a human (or a GUI-automation-capable session)
clicking through it at least once before this is fully trusted, same caveat `desktop-remote-mode.md`
left for the picker it replaces.

## M6 follow-up (2026-09-16) — auto-restart instead of "quit now, reopen it yourself"

Owner, after using it: "why is there this 'nooklet will quit now' after selection of local mode or
server mode. Can we not do it? super annoying." Every picker confirmation (and `Switch Server…`
from the menu) ended with `quit_app` — a plain `app.exit(0)` — leaving a manual "go find the dock
icon and reopen it" step the owner had to do every single time.

Fix: `quit_app` renamed `restart_app` and now calls `AppHandle::request_restart()` instead of
`exit(0)` — Tauri's own reliable-from-any-thread restart primitive: it still delivers
`RunEvent::Exit` first (this app's `run()` closure needs that to kill a spawned local server child
before the process actually goes away), then relaunches the same binary with the same env. Used by
both the picker's `finishAndRestart` (`launcher/index.html`, renamed from `finishAndQuit`) and
`on_menu`'s `MENU_SWITCH_SERVER` case, so "Switch Server…" from the menu bar no longer needs a
manual reopen either. The "Saved" message changed from "nooklet will quit now. Open it again to use
this setting." to "Saved — restarting nooklet to apply it…", so the window closing and a new one
appearing a moment later reads as the app doing its job, not as something going wrong — the owner's
own request to be told what is about to happen, not left to guess.

**Found in passing while making this change**: `e2e/tests/desktop-launcher.spec.ts`'s B-584
regression test had silently gone stale during M6 itself — it still injected the pre-M6
`remoteUrl`/`forcePicker` shape and clicked `#choice-local`, an element id the M6 list rewrite
removed, and stubbed `set_remote_server` (also removed by M6). Never re-run against the M6 tree
until now, so this went unnoticed. Fixed alongside this change: `openLauncher()`'s injected shape
updated to `graphs`/`activeGraphId`, the stub now answers `add_graph`/`remove_graph`/
`set_active_graph`/`restart_app`, and the test clicks the dynamically-rendered "This Mac" row via
`getByRole("button", { name: /This Mac/ })` instead of the now-gone `#choice-local`.

**Verified for real**: `cargo test` (11, unchanged count — `restart_app` itself has no new pure
logic to unit-test, it is a one-line delegation to Tauri's own primitive) and
`e2e/tests/desktop-launcher.spec.ts` (5, all fixed and green) both pass. Then, since NO test —
unit, e2e, or otherwise — can prove an OS-level process actually restarts, a targeted real check:
built a devtest `.app` (`TAURI_CONFIG` overriding both `identifier` and `build.frontendDist`, so it
loads a tiny probe page instead of the real launcher, never touching that file) whose only job is to
call `invoke("restart_app")` and report back to a local log server. Launched once, observed FOUR
consecutive real restarts before it was stopped (the probe page fires on every load, including its
own post-restart reload — a self-inflicted loop, not a defect, stopped by killing the current PID):
each one produced a genuinely new OS process (confirmed via `ps`, a new PID every time, the previous
PID gone), and each new process's window loaded the page again successfully — real, repeated, clean
process-level evidence the restart mechanism works, not just that the code compiles. Devtest config
dir and scratch build removed afterward; confirmed no stray `nooklet-desktop` processes and the
owner's real app/config/port 6100 untouched throughout.

**Same conversation, second follow-up — periodic reconnect while the picker is showing an error**:
owner: "I also ideally want some kind of a 'periodic check' on a page with selection of mode in case
some server becomes available again." `launcher/index.html`'s `attempt()` already showed the picker
with an error when the active entry stopped answering, but left it there for good — no automatic way
back in short of a manual retry. Added `scheduleRecheck()`/`stopRecheck()`: while (and ONLY while)
the picker is showing because of that specific failure — never for a deliberately-opened picker
(`forcePicker`/"Use a different server…"), which must never auto-navigate out from under a choice
being made — it re-checks the same address every 3s, and the moment it answers, shows "‹address› is
back — reconnecting…" and navigates there with no click needed. Stopped the instant the owner takes
any other action (picks a different row, opens the add-a-server form, a restart is already
underway) so it never fights a deliberate choice. Independent of `loop()`/`loopStopped`, which exist
to REACH the picker, not leave it, and stay stopped for as long as it is open for any other reason.

**Verified for real**: a devtest `.app` pointed at a port nothing was listening on (confirmed: alive,
no navigation, matching "picker showing an error"); a throwaway HTTP server started on that exact
port several seconds later; confirmed — zero manual interaction — the app navigated there within one
recheck cycle, via the same "have the destination page report back `window.__NOOKLET_DESKTOP__`"
technique used for M6's own injection-contract verification above. Devtest config dir and processes
removed afterward.

## How to resume

Read `docs/adr/025-multi-graph-hosting.md` first (the decision), then this file. All of M1-M6 was
committed to `main` on 2026-10-03 at the owner's request (with the mobile-ios and desktop-remote-mode
work it was interleaved with; see `git log` around that date). Next: M7 (Capacitor/iOS verification,
expected to be nearly free by construction — M4/M5 already confirmed to need zero Capacitor-specific
code, this is a "does it actually work on a real Simulator" check, not new implementation).

Before M7, consider closing M6's own remaining gap: a real human click-through of the desktop
picker (list/add/remove/switch), never done for either this rewrite or the two-card picker it
replaced.

Three separate, real, pre-existing bugs are logged but deliberately NOT this milestone's blocker:
B-585 (client-side ref-page creation timing), B-587 (server-side rebuild-parity divergence, found
while finishing M5's own verification — possibly related to B-585, not confirmed), and the desktop
picker's own never-yet-exercised GUI interaction (not a bug, a verification gap — see M6 above).
