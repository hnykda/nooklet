# Bugs and backlog

Working list. Anything reported from real use lands here first, so it survives a lost session and
is not stuck in a chat transcript.

**Conventions.** Each entry says what you *see*, not what the code does — the diagnosis belongs in
the fix. A fixed entry keeps its commit so the regression test is findable. Anything with a
reproducing test names it; anything without one says so, because "fixed" without a test here means
"believed fixed".

Status: `open` · `fixed` · `wontfix` · `needs-repro`

---

## Open

### B-12 · Two CSS naming schemes in the editor
**Status:** open · **Severity:** low · **Found:** 2026-09-11

`BlockRowView` uses `.vr-row` / `.vr-content` / `.vr-block-view`; `VirtualJournalDay` uses
`.block-tree` / `.block-row` / `.block-content-input` for the same concepts. Confusing to style and
to write selectors against. Fold into one scheme during the design pass.

---

### B-13 · UI is visually unfinished
**Status:** open · **Severity:** medium · **Reported:** 2026-09-11

Verbatim: "looks absolutely barebones… like first project in life design." Needs a real typographic
scale, spacing rhythm, and focus/hover states.

---

## Fixed

### B-39 · `nooklet backup` rewrote the graph it was asked to preserve
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, by running it on a real graph

ADR 018's journal-name migration was hooked into `cli.ts`'s shared `open()` on the reasoning that
it is idempotent and cheap, so it may as well be everywhere. Every command goes through `open()` —
including `backup`, `verify`, `gc` and `export`, which are the commands you reach for when you
want to inspect or preserve a graph, not change it.

Two consequences, both bad. Taking a backup *before* a migration produced a backup taken *after*
it, which is the opposite of the thing being asked for. And `verify` — a diagnostic whose entire
job is to report on a database's state — would have reported on a database it had just modified.

`open()` now takes `{ migrate: true }`, passed only by `serve`, `import` and `mcp`.

**Lesson:** "idempotent and cheap" is an argument about cost, not about permission. A command that
does not say it writes must not write.

### B-32 · `graph.spec.ts` wrote into today's journal
**Status:** fixed · **Severity:** low · **Found:** 2026-09-11

The graph spec appended to **today's** journal, which is exactly the shared state
`a-fresh-journal.spec.ts` needs untouched — that spec is named to sort first for this reason, and
only worked because it happened to run earlier. Reordering or sharding the suite would have broken
the journal test with a failure that read as an editor bug rather than a fixture collision.

It now writes to a dated day in the past, with a comment saying why.

### B-37 · The Settings command navigated to a route that does not exist
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11 by a subagent building the panel

`app.openSettings` called `navigate("/settings")`. There is no such route, so the command — bound
to a key and listed in the palette — landed on a blank page. It now raises the settings panel.

Test: `e2e/tests/settings.spec.ts`.

### B-38 · Embeddings could not be configured without dropping to the CLI
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11 by a subagent

Semantic search needed `nooklet embed model …` from a terminal: there was no HTTP op to see
whether a provider was reachable, pick a model, or start a backfill, and nothing in the UI to do it
with. Someone who installed the app and wanted the feature it advertises had no path to it.

Now `embeddings.status` / `configure` / `reindex` exist (HTTP-only, deliberately not MCP tools:
they are operator decisions with real cost), the provider is probed *before* anything is persisted
so a bad host is never stored, and the indexer activates a model once its backfill drains — which
is the part a request handler cannot do synchronously and the reason an HTTP-configured model
would otherwise sit inactive forever.

Tests: `packages/server/src/ops/ops.http.test.ts` (against a stub Ollama, so results do not depend
on the machine), `e2e/tests/settings.spec.ts`. Also verified end to end against a real Ollama with
`bge-m3`: an English query returned a Czech note as its top hit.

### B-21 · Journal pages were stored under a display format
**Status:** fixed · **Severity:** medium · **Raised:** 2026-09-11 (user: "stored name should IMHO
be ISO. and then we should have in settings selectable format of that") · ADR 018

A journal page was *stored* under whatever title format the graph was written with —
`Mon, 07.09.2026` in the imported Logseq graph — while search results, block references and the
API all handed out the ISO date. The format a date is displayed in had become part of its
identity, and that one mistake produced B-22, B-23, and a quieter third: `ref.dst_page_key` is the
reference text, so `[[Mon, 07.09.2026]]`, `[[Sep 7th, 2026]]` and `[[2026-09-07]]` were three
different keys and a journal's backlinks were whichever subset happened to match its stored name.

Now: a page with a journal day is stored as `2026-09-07` (derived in `@nooklet/core`'s reducer, so
client, server and replay all agree); every recognised date format canonicalises to one reference
key; and the displayed title is a per-device setting (Settings → Appearance → Journal date format).

Existing graphs are migrated by `packages/server/src/journal-names.ts`, which mints real
`page.rename` ops — a raw UPDATE would desync live state from the op log and no other device would
ever hear about it. Run against the real 952-page graph: 825 pages renamed, `nooklet verify` clean,
and unresolved references *dropped* (path_ref 7403 → 5889, ref 1444 → 1357) because dates written
in a different format now resolve.

Tests: `packages/core/src/journal.test.ts`, `packages/core/src/sync/apply-ops.test.ts`,
`packages/server/src/journal-names.test.ts`, `e2e/tests/journals.spec.ts`.

### B-23 · `page.create` accepted a journal-formatted name and made a non-journal page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, while writing journal e2e tests ·
commit `dab7dc7`

`page.create` deliberately refuses journal days — but its guard used `journalDayFromWire`, which
only understands ISO and `today`/`yesterday`, not the title formats `parseJournalTitle` accepts. So
`page.create({name: "Tue, 08.09.2026"})` succeeded and produced a page with `journal_day = NULL`:
named like a journal day, looking like one, and invisible to the journal stream forever.

The guard now uses `parseJournalTitle` — the parser the rest of the system resolves references
with — and the error names the ISO date to use with `page_append` instead.

Test: `packages/server/src/ops/ops.http.test.ts`, `describe("page.create journal guard")`.

### B-35 · `page.append` could not create an ordinary page, and shadowed journals
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, by an e2e test that tried to use it

Two faults in one function. `page_append`'s `create_page` flag defaults to true and is documented
as creating the page — but `resolvePageRef` only ever honoured it on the journal branch, so
appending to a page that did not exist yet failed with *"does not exist and create_page is false"*
having been passed exactly the opposite. An agent reading that message would conclude the flag was
the problem and never find the real one.

And the fallthrough was B-23's hole through a different door: `page_append({page: "Sep 8th, 2026"})`
would have created an ordinary page shadowing that journal day.

`resolvePageRef` now resolves in a documented order — wire date, id, existing name, *then* any
other journal title format, and only then creates an ordinary page. The name-before-date step is
what keeps an imported page genuinely called `11.12.2024` reachable by its name.

Test: `packages/server/src/ops/ops.http.test.ts`, `describe("page.append page resolution")`.

### B-36 · Moving the e2e port left the browser pointing at the old one
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-11, immediately after B-34's guard fired

B-34 taught the suite to refuse a port that is already serving nooklet, and to say
`NOOKLET_E2E_PORT`. Doing what it said moved the *server* but not the *browser*: `baseURL` came
from a separate `NOOKLET_E2E_URL` and stayed at 6188 — the very server the guard had just objected
to. The suite then tested a concurrent agent's build and reported a failure in code that was
correct, which is the exact outcome B-34 existed to prevent.

`baseURL` is now derived from `NOOKLET_E2E_PORT`. One knob.

**Lesson:** a guard that tells you which knob to turn has to be sure that knob turns everything.

### B-33 · `.gitignore` silently excluded seven source files from the repository
**Status:** fixed · **Severity:** critical · **Found:** 2026-09-11 by a subagent

`.gitignore` line 12 was a bare `data/`, which matches **any** directory named `data` at any
depth — so `apps/web/src/data/` was never committed. The published repository was missing
`store.ts`, `api-client.ts`, `bootstrap.ts`, `types.ts`, `tree.ts`, `block-ref-cache.ts` and
`tree.test.ts`, and could not build.

Nothing local would ever have caught it: the files exist on disk, `git status` is clean, every
test passes. It surfaced only because a subagent noticed its own edits to `store.ts` were
invisible to `git status` and said so rather than assuming it had misread.

Now `/data/`, anchored to the root, which is what it always meant. Verified by cloning the repo
into a temp directory and running `typecheck` + `build` there — the check that would have caught
this at any point.

**Lesson:** a repo that builds locally proves nothing about what was committed. Clone it.

### B-34 · The e2e suite could silently run against someone else's server
**Status:** fixed · **Found:** 2026-09-11, chasing a test that failed only in the full suite

`global-setup.ts` spawned a server on a fixed port and then waited for `/healthz`. When something
was already listening — a concurrent agent's Playwright run — the spawn failed to bind but the
health check succeeded against the OTHER process, so the whole suite ran against a foreign server
carrying foreign data.

It presented as a real product bug: one spec failed on state it never created, and kept failing
when run in isolation. Several rounds went into looking for a regression in the editor that did
not exist.

The setup now refuses to start when the port is already serving nooklet, and says what to do
(`NOOKLET_E2E_PORT`). Logged alongside B-32, which was the same class of problem one level up —
tests sharing state they did not declare.

### B-30 · A client silently held a copy of a different graph
**Status:** fixed · **Found:** 2026-09-11, chasing "search finds nothing but the sidebar is full"

The sidebar listed a thousand pages while search returned zero results. Both were telling the
truth about different graphs: the client's replica lives in OPFS keyed by **origin**, so pointing
`127.0.0.1:6100` at another data directory leaves the browser reusing the copy it already had.
The page list reads the local replica; search and backlinks read the server. Every individual
part worked.

Each database now mints a stable identity (`packages/server/src/graph-identity.ts`), exposed via
`GET /api/session`. The client remembers which graph its replica belongs to and, on a change,
stops and explains instead of rendering two disagreeing halves (`views/GraphMismatchView.tsx`).

**It asks rather than wiping.** The local replica can hold edits that were never pushed, and
destroying those silently to fix a configuration mistake would be the worst possible trade.

Two contributing causes worth recording: the README's quick start said `--data ~/.nooklet` while
the CLI defaults to `~/.nooklet/default`, so following it produced a second graph; and the desktop
app used the platform app-data directory, so it opened a third. Both now use one default.

### B-31 · A wall-clock assertion in the unit suite
**Status:** fixed · **Found:** 2026-09-11 by a subagent, which correctly refused to blame its own change

`packages/core/src/tokens.test.ts` asserted `tokenizeContent` over 20,000 blocks finished in under
50 ms. It measured 60-71 ms when run alongside the rest of the suite and passed every time in
isolation — the test was measuring the machine's load, not the code.

A test that fails when the laptop is busy teaches nobody anything and trains people to re-run
until green. The budget is now 500 ms: an order of magnitude above the real ~30 ms, which still
catches the regression actually worth catching (an accidental quadratic turning this into
seconds) and never fires on load.

### B-29 · A self-executing module hijacked the CLI once bundled
**Status:** fixed · **Found:** 2026-09-11, building the desktop app's bundled server

The desktop app's server died on `unable to open database file` for a directory that plainly
existed. The path it tried to open was the data **directory**, not `graph.sqlite` inside it.

`mcp/stdio.ts` ended with a standalone entry point:

```js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```

Bundled by esbuild into a single file alongside `cli.ts`, that guard compares *the bundle's* path
— so it is true for whichever entry point is actually running, and the stdio bridge's `main()`
ran instead of the CLI's. The two read `--data` differently on purpose: the CLI takes a data
directory, the bridge takes the database file. Hence the error.

`main()` and its `parseArgs` now live in `mcp/stdio-main.ts`; `mcp/stdio.ts` is a pure library.

**The red herring worth remembering:** a byte-identical copy of the bundle ran fine from `/tmp`
and failed from the repo. That is not filesystem magic — `/tmp` is a symlink to `/private/tmp`,
so `import.meta.url` (symlinks resolved) and `process.argv[1]` (as given) did not match, and the
guard stayed false. Chasing "the location matters" nearly sent this in the wrong direction; what
settled it was printing the path that was actually being opened.

**Rule:** a module that can be imported must not self-execute. Bundling makes every entry point
look like *the* entry point.

### B-28 · The entire command layer was wired to a no-op editor
**Status:** fixed · **Test:** `e2e/tests/parity.spec.ts` (6 tests)
**Found:** 2026-09-11, by finally exercising B-17/B-18 in a browser

The slash menu, `[[`/`#`/`((` autocomplete and every formatting shortcut did nothing. All were
implemented and unit-tested against a fake host; none had ever run in a browser. Three bugs,
stacked:

1. **`CommandLayer` captured the host once.** `const editor = activeEditorHost()` evaluates at
   setup, when no `BlockTree` has focus — so it captured the inert no-op host and kept it forever.
   `activeEditorHost()` returns a *snapshot*; anything built once at startup needs the new
   `liveEditorHost`, which forwards each call to whoever is active now.
2. **The host was never registered anyway.** `BlockTree`'s registration effect was
   `createEffect(() => { if (surface.currentId() !== null) … })` — and `surface.currentId()` reads
   a plain closure variable inside `surface.ts`, not a signal. The effect ran once, at mount, with
   nothing focused, and never re-ran. Now keyed on `editingId()`, which is a real signal.
   Measured before the fix: `getSelection()` returned `null` on every keystroke, so no trigger
   could ever match.
3. **Commands wrote to the model but not the editor.** With the above fixed, `Cmd+B` resolved and
   *ran* (`handled: true`) yet the text never changed: `EditorHost.setText` called `onTextChange`,
   updating `localBlocks` while CodeMirror kept the old buffer — and the next refetch, which
   prefers the live buffer for the block being edited, then discarded the change entirely. It now
   dispatches a real CodeMirror transaction and lets the surface's update listener do the rest.

**Lesson:** a unit test against a fake host proves the command's logic and nothing about whether
the host is connected. Every one of these had passing unit tests.

### B-25 · Any LAN caller could mint a write token by forging `Host: localhost`
**Status:** fixed · **Severity:** critical · **Test:** `packages/server/src/http/host-guard.test.ts`
**Found:** 2026-09-11 by the multi-user/pairing research agent, reproduced before fixing

`buildClientBootstrap` decided "is this loopback?" from the `Host` header, which the caller
controls. Verified against a running server bound to `0.0.0.0`:

```
curl -H 'Host: localhost:6198' http://192.168.1.6:6198/api/session
→ {"token":"nk_<redacted>"}
```

That is a `write` + `can_sync` token handed to anyone who can reach the port. Introduced in this
session along with the bootstrap endpoint.

Now decided from the socket's peer address (`getConnInfo`), with the `Host` check RETAINED as a
second condition rather than replaced — a DNS-rebinding attack arrives from a genuine loopback
peer (the victim's own browser) carrying the attacker's hostname, so both must hold. An
in-process request with no socket is treated as non-loopback: never hand out a credential to a
caller you cannot identify.

### B-26 · The DNS-rebinding guard covered 2 routes out of 7
**Status:** fixed · **Test:** `packages/server/src/http/host-guard.test.ts`, "guards EVERY route"
**Found:** 2026-09-11, same research pass

`@modelcontextprotocol/hono` ships a Host guard, but `createApp` merges that sub-app *after*
`/api/v1/*`, `/sync/*`, `/api/session` and `/assets/*` are registered — and Hono composes handlers
in registration order, so a terminal handler registered earlier short-circuits before the merged
middleware runs. The guard only ever covered paths with no earlier route. Meanwhile `cli.ts`
printed that requests with an unexpected `Host` "are refused". They were not.

nooklet now installs its own allowlist middleware *before* every route, active only when bound to
a non-loopback address. Verified per-route: with `--host 0.0.0.0` and no `--allow-host`, all of
`/healthz`, `/openapi.json`, `/api/session` and `/` return 403 to a LAN Host and 200 to loopback;
adding `--allow-host` opens exactly that hostname. The CLI message now says what actually happens.

**Testing note:** these cannot be tested through `app.request()` — both behaviours depend on the
connection itself. And `fetch` silently drops a `Host` header (it is a forbidden header name), so
the tests use raw `node:http`; written with `fetch` they would have asserted nothing while passing.

### B-27 · A plain LAN IP cannot run the client at all
**Status:** documented · **Severity:** high · **Found:** 2026-09-11, same research pass

`http://192.168.1.5:6100` — the URL the README previously recommended for phone access — is not a
*secure context*. The client stores its replica via OPFS (`installOpfsSAHPoolVfs`) and elects a
writer with `navigator.locks`; both are secure-context-gated and neither has a fallback, so the
client cannot open its database there at all. README now recommends HTTPS or a tailnet and
explains why.

Not a code fix: the real remedy is a documented deployment shape. Revisit if a plain-LAN fallback
is ever wanted, which would mean a non-OPFS storage path.

### B-22 · Clicking a search result said "This page doesn't exist yet"
**Status:** fixed · **Test:** `e2e/tests/journals.spec.ts` (3 tests)
**Reported:** 2026-09-11

Three separate defects on one path.

1. **Journal pages were only addressable by their stored name.** The graph stores
   `Mon, 07.09.2026`; search results and references hand out `2026-09-11`. `usePageByName` looked
   up by name only, so a journal that plainly existed reported "doesn't exist yet". It now falls
   back to `parseJournalTitle` → `journal_day`, which is format-agnostic. See B-21 for the
   underlying design fix.
2. **Zooming into a block threw and left the view permanently blank.** `flattenVisible` called
   `getBlock`, which throws on an unknown id — and on the first render the tree is empty because
   the page resource has not resolved, so a `?block=` URL took down the whole subtree behind a
   "Loading…" that never cleared. A missing zoom root now yields no rows instead of throwing.
3. **"Loading…" never cleared even once data arrived.** `createResource` sets `loading = true` on
   every REFETCH, and after the version-stamping fix (B-05) every resource refetches whenever its
   tables change — so a spinner keyed on `loading` alone reappeared on every sync pull. Views now
   show a spinner only while there is nothing to display (`loading && value === undefined`).
   Fixed in `PageView`, `TasksView`, `ReferencesPanel` and `SearchView`.

### B-24 · Future journal days were invisible
**Status:** fixed · **Test:** `e2e/tests/journals.spec.ts`, "a future journal day appears in the stream"
**Reported:** 2026-09-11 ("shows just today page even though /page/Sep 12th, 2026 exists")

The stream query was `journal_day < today`, so a day ahead of today never appeared. Empty past
days are hidden deliberately; a *future* day exists only because something was written or
scheduled there, so hiding it turned into "days you created are not shown". Future days now render
above today (keeping the stream newest-first) and are not counted against the `maxDays` window,
which exists to bound scrolling back through years of history.

### B-20 · The app never updated — a browser stayed pinned to the first build it cached
**Status:** fixed · **Reported:** 2026-09-11 as search still hanging and "agents can't see this
window" persisting after both had been fixed and verified

`vite.config.ts` used `registerType: "prompt"`, which only applies an update when something calls
the update function — and `sw/register.ts`'s `onNeedRefresh` did nothing but `console.info`. So a
browser kept serving the first build it had ever precached, forever. Every fix shipped after that
first visit was invisible, and the symptoms looked like unfixed bugs.

Proven by driving a *fresh* browser (no service worker) at the same server and the user's real
graph: `/api/session` 200, `/api/v1/search` 200, 48 results, zero console errors, live UI
connected. The code was correct; the cache was not.

Now `registerType: "autoUpdate"`, `onNeedRefresh` actually applies the update, and a long-lived
tab re-checks hourly (a service worker otherwise only looks for a new version on navigation).
Safe for unsaved text because a pending edit already flushes on `pagehide`/`visibilitychange`
(B-04).

**To unstick a browser that is still on an old build:** hard-reload twice, or DevTools →
Application → Service Workers → Unregister, then reload.

**Lesson:** when a verified fix "doesn't work" for the user but passes in CI, suspect the
delivery path before the code. `pnpm e2e` rebuilds and uses a fresh browser context every run, so
it could never have caught this.

### B-19 · The service worker served a shell with no token, so reloads lost credentials
**Status:** fixed · **Test:** `e2e/tests/remote-device.spec.ts`, plus every reload-based editing test
**Found:** 2026-09-11, while adding the connect screen

The web-client token was injected into `index.html`. The PWA service worker precaches that file
**at build time**, so from the second page load onward the browser was handed a shell containing
no `window.__NOOKLET__` at all — the app silently lost its credentials on every reload, on
loopback, where everything was supposed to just work. It had been happening since the token
injection landed; it only became visible once a missing token started rendering a connect screen
instead of failing quietly.

A shell is static and cacheable; a credential is neither. The token now comes from
`GET /api/session` at startup (`data/bootstrap.ts#initBootstrap`), which the service worker's
runtime caching already treats as `NetworkOnly`.

**Lesson worth keeping:** two of the reload-based editing tests started failing the moment the
connect screen existed. They were not regressions — they were the first time this bug had anything
to fail against.

### B-15 · Keystrokes lost right after clicking a block or pressing Enter
**Status:** fixed · **Test:** `e2e/tests/editing.spec.ts`, "typing immediately after Enter"
**Reported:** 2026-09-11 as "I type, press enter, the new text disappears", "can't click on a new
bullet point to put cursor in there", and "tab + shift tab doesn't work"

All three were one defect. Solid runs a `ref` callback when the element is *created*, not when it
is inserted into the document, so `surface.attach`'s `view.focus()` ran against a still-detached
host and did nothing. Focus sat on `<body>` until a `requestAnimationFrame` backstop restored it a
frame later, and everything typed in that window went to `<body>` and was discarded. Measured:
immediately after Enter, `document.activeElement` was `BODY` and the focus trace read
`out->BODY`, `in:cm-content`.

It read as "Tab doesn't work" for the same reason — with focus on `<body>`, CodeMirror's keymap
never saw the key, so *no* structural key worked, including Backspace.

Fixed by re-asserting focus in a `queueMicrotask` (runs after Solid inserts the element but before
the browser dispatches the next input event), keeping the rAF as a backstop for the separate case
where the browser resets focus after removing the previously focused element.

### B-16 · An edit typed into a just-created block was discarded
**Status:** fixed · **Test:** `e2e/tests/editing.spec.ts`, "typing immediately after Enter"

`flushPendingEdit` looked the block up in `treeBefore` — the tree as of the edit's first keystroke
— and returned early when absent (`if (!before || before.content === content) return`). A block
created moments earlier (Enter for a new sibling, pasting a subtree) is not in that snapshot, so
the text op was never built and the typing was lost with no error. Absent from the snapshot is not
"unchanged": it now falls back to the live tree and only skips when content genuinely has not
moved.

---

The six below were reported within minutes of first opening a served production build, and all six
had passed the 1,180-test unit suite. That is what `e2e/` now exists to prevent — see its
`playwright.config.ts` header.

### B-01 · Served client had no API credentials
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/connectivity.spec.ts`

Search 401'd, linked references hung, `/ui/live` reported "agents can't see this window", and the
sync indicator flapped offline→syncing→offline every few seconds. One cause: the token came from
`VITE_NOOKLET_TOKEN`, a dev-only stand-in that is undefined in a production build. The server now
injects a per-process token as `window.__NOOKLET__`, for loopback callers only.

### B-02 · Editing stopped after exactly one character
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "types a whole sentence"

`<For each={rows()}>` keyed on objects rebuilt by `flattenVisible` on every refetch, so each
keystroke recreated every row's DOM and tore out the element the single CodeMirror surface is
re-parented into. Now keyed by block id.

### B-03 · Clicking a block entered edit mode without focus
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/rendering.spec.ts`, "clicking a seeded row"

The clicked `.vr-block-view` is swapped out of the DOM inside the click handler, so the browser
reset focus to `<body>` after the handler returned, undoing `view.focus()`. Re-asserted on the next
frame. Deliberately *not* moved to `mousedown`, which fires before link clicks and would break
`[[page]]` navigation.

### B-04 · Typed text vanished on blur, reappeared on reload
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "text survives blurring"

Two causes. See B-05 for why the UI didn't update; separately, a typed edit could be lost for real:
writes are debounced ~500 ms and nothing flushed on blur or unload, so clicking away and reloading
inside that window discarded it. Now flushed on `focusout` past the tree, `pagehide`, and
`visibilitychange`.

### B-05 · Nothing refetched after a write
**Status:** fixed · `d6163df` · **Test:** covered by B-04's test and "a page seeded through the API"

Global. Every resource source called `trackTable`/`trackPage` and then returned a stable scalar (an
id, a name, or literally `true`); `createResource` refetches only when the source *value* changes,
so Solid never re-ran the fetcher. Local edits reached SQLite and the UI kept rendering the
previous result until a reload. Sources now return a version-stamped object.

### B-06 · Enter dropped the next two keystrokes
**Status:** fixed · `d6163df` · **Test:** `e2e/tests/editing.spec.ts`, "Enter creates a second bullet"

Surfaced by fixing B-05: a refetch landing before the write committed overwrote the optimistic row
and unmounted the new block's editor, so `second bullet` arrived as `cond bullet`. The block being
edited is now preserved when absent from a query result.

---

### B-07 · Cmd+A in a block doesn't select its text
**Status:** fixed (by B-15's focus fix; covered by `e2e/tests/parity.spec.ts`) · **Status was:** open · **Severity:** high · **Found:** 2026-09-11, while writing e2e tests

Pressing Cmd+A (Ctrl+A) while editing a block does not select that block's text. It detaches the
editor and swallows the following keystroke — typing `persisted` after it produced
`seedersisted`, i.e. the `p` vanished and the caret jumped to the end.

Expected: select the block's text first, and only escalate to selecting sibling blocks on a second
press (`docs/spec/commands-and-keymap.md`). No keystroke should ever be dropped.

It turned out to be the same detached-editor fault as B-15: the keymap ran against an editor the
DOM no longer owned. `e2e/tests/parity.spec.ts` now presses Cmd+A in a real browser and asserts the
block's text is selected and the next keystroke replaces it.

### B-08 · References panel always present, no counts, not collapsible
**Status:** fixed · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** medium · **Reported:** 2026-09-11

Linked and unlinked references render as sections even when there are none, show no count, and
cannot be collapsed. Should show `Linked references (3)`, collapse/expand, and disappear entirely
when empty.

`apps/web/src/views/ReferencesPanel.tsx`.

### B-09 · References don't refresh after a local edit
**Status:** fixed · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** medium · **Found:** 2026-09-11, reading the code for B-08

`useLinkedReferences` and `useSearchResults` are server-backed and deliberately not wired to the
local change bus (`apps/web/src/data/store.ts`), exposing a manual `refetch` instead — but nothing
calls it. So adding a `[[link]]` does not update the panel until navigation.

Related to B-05's root cause but a separate path: those two resources bypass the version stamping.

### B-10 · A failed request renders as a permanent spinner
**Status:** fixed (search + references) · **Test:** `e2e/tests/references.spec.ts` · **Status was:** open · **Severity:** high · **Reported:** 2026-09-11 (as "searching for aa just stops at Searching…")

`SearchView` has a loading branch and a results branch but no error branch, so a rejected fetch
leaves "Searching…" on screen forever. The underlying 401 was B-01, but the *invisibility* is its
own bug and will hide the next failure too.

Every view that can fail needs an error state. Same applies to the references panel's "Loading…".

### B-11 · No diagnostics surface
**Status:** fixed · **Test:** `e2e/tests/diagnostics.spec.ts` · **Status was:** open · **Severity:** medium · **Requested:** 2026-09-11

Nothing in the UI says whether the client reached the API, whether it has a token (and if not,
why), how big the search index is, or whether embedding indexing is running. B-01 was invisible for
exactly this reason. `data/bootstrap.ts` already carries a `reason` field for this.

Wanted: a settings/dev panel with connection state, backend reachability, index size, indexing
progress.

### B-14 · No context menu on a bullet
**Status:** fixed · **Test:** `e2e/tests/parity.spec.ts` (3 tests) · **Status was:** open · **Severity:** medium · **Requested:** 2026-09-11

Right-clicking a bullet should open an app-specific menu rather than the browser's default:
zoom in, indent/outdent, toggle task, copy block ref, delete — and **formatting** (bold, italic,
highlight) when there is a selection. The commands already exist
(`commands/registrations/format.ts`, `structural.ts`); this is the missing surface for them.

### B-17 · Slash menu never verified in a browser
**Status:** FIXED — see B-28 below · **Status was:** needs-repro · **Severity:** medium · **Raised:** 2026-09-11

`SlashMenu`, `matchSlashTrigger` and the insert commands are implemented and unit-tested, and
`CommandLayer` wires them up — but nothing has ever exercised typing `/` in a real browser. Given
that every keyboard path checked so far had a defect (B-02, B-07, B-15), assume it is broken until
an e2e test says otherwise. Same for the `[[`, `#` and `((` autocomplete popups.

### B-18 · Formatting shortcuts never verified in a browser
**Status:** FIXED — see B-28 below · **Status was:** needs-repro · **Severity:** medium · **Raised:** 2026-09-11

`format.bold` / `format.italic` / `format.highlight` are registered with Cmd+B/I and unit-tested
against a fake editor host, but have never been pressed in a real browser. These route through the
same global capture-phase dispatcher and `EditorHost` delegation that B-07 shows is fragile.

## Notes for whoever picks this up

- `pnpm e2e` builds the client, boots a real server on a temp data dir, and drives Chromium. It is
  the only suite that would have caught B-01 through B-06.
- When a bug is "it doesn't update", check `data/store.ts` first — B-05's pattern was replicated
  across eight resources and is easy to reintroduce.
- Bugs found while fixing other bugs (B-06, B-09, B-12, B-16) are worth recording even when small;
  several entries above exist only because something else was being read carefully.
- **Assertions can hide bugs.** `expect(outliner).toContainText("first bullet")` and
  `toContainText("second bullet")` both passed while Enter was doing nothing at all, because both
  strings were sitting in one block. Assert structure (`toHaveCount`) alongside content.
- When a keyboard interaction "does nothing", check `document.activeElement` first. Three separate
  reports (B-15) were one focus bug, and the giveaway was that Backspace did not work either.
