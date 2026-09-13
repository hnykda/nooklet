# ADR 023: The client plugin host compiles built-in client halves into the web build

Date: 2026-09-13. Status: accepted (M8, impl-plugins). The precache cost below has not been put to
the owner yet.

## Context

ADR 007 gives a plugin an optional client half and says "the host bundles each entry with esbuild
and `import()`s it". The server half of that sentence was built in M4: `PluginHost` bundled every
client entry at activation, served it at `/plugins/<id>/client.<hash>.js` and listed it in
`GET /api/v1/plugins`. The browser half never was. Nothing in `apps/web` fetched the list or
implemented `ClientPluginContext`, so the built-ins' client halves — `/mermaid`, the mermaid fence
renderer, word-count's status item — were unreachable (B-103, exposure audit D9; the templates
workstream hit the same wall, ADR 019 §Context 1).

Two more facts shaped the fix:

1. **The mermaid plugin fetched mermaid from jsdelivr at render time**, through a computed
   `import()` specifier so no bundler would see it — `mermaid@11`, whatever that resolved to on
   the day. For a local-first app that means no diagrams offline and unpinned third-party code
   executing in the page.
2. **The desktop app ships no built-in plugins' server halves** (B-180): the sidecar has no
   `plugins/` directory, so a host that asked the server which client halves to load would load
   none there.

## Decision

1. **Built-in client halves are compiled into the web build.** `apps/web/src/plugins/builtins.ts`
   imports each plugin's `src/client.ts` and `package.json` statically; `ClientPlugins.tsx`,
   mounted inside `<CommandProvider>` by `CommandLayer`, activates them at startup. A new built-in
   client half is one import and one row.
2. **The host implements what the built-ins need, through existing seams, and throws for the
   rest.** `registerSlashCommand` registers a `plugin.<id>.slash<Item>` command
   (`when: editorFocused`) and contributes a row to the slash menu, which now ranks a signal
   (`commands/slash/contributed.ts`) instead of a constant. `registerCodeBlockRenderer` feeds a
   renderer registry `tokens.tsx`'s fence case consults (`editor/render/PluginFence.tsx`).
   `registerStatusItem` mounts into a top-bar strip. Also `registerCommand`, `rpc.call`,
   `editor.currentPage/insertText/openPage/navigate`, `log`, `subscriptions`. Every other member
   of `ClientPluginContext` throws `"<member> is not supported by nooklet's client plugin host
   yet (ADR 023)"`. Registrations are disposed in reverse order on stop or a failed activation.
3. **Client events are the ones the client can tell honestly.** `page.opened`, and a new
   client-only `page.changed { page: Page | null }`: another page opened, no page open, a change
   to the open page's rows from any device, or the push queue draining so a server read now sees
   a local edit. The server-shaped events (`block.updated` & co.) are not delivered: the replica's
   change bus reports tables and page ids, not rows or ops. word-count uses `page.changed`.
4. **mermaid is the mermaid plugin's own npm dependency** (`12.0.0`), imported lazily so it
   becomes chunks loaded on the first diagram. `plugins/*` became pnpm workspace members so a
   built-in plugin can declare dependencies and resolve `@nooklet/plugin-api` types, as a plugin
   author's own `npm install` would.
5. **The server bundles a client half on first request, not at activation**
   (`PluginHost.clientBundle`). Nothing requests those bundles now, and with mermaid inlined each
   one is 12 MB of esbuild output.
6. `RenderInfo.block`/`page` are read from the replica for the fence's nearest `[data-block-id]`
   row. A fence outside a block row (the shelf's outline) shows its source instead of reaching a
   renderer with an invented block.

## Alternatives rejected

- **`import(client_url)` at runtime from `GET /api/v1/plugins`** — ADR 007's literal wording, and
  the only way user plugins in `<dataDir>/plugins` could get a client half. Rejected for the
  built-ins: the service worker precaches the build, not `/plugins/*`, so an offline start would
  have no slash commands or renderers; slash rows and renderers would wait for an authenticated
  round trip after first paint; the modules would never be typechecked against the app (compiling
  word-count's client half with the app found a type error esbuild had been stripping since M4);
  and the desktop app would load nothing (B-180). It stays the natural shape for user plugins; the
  server routes are kept for it.
- **Move mermaid into core and drop word-count's client half** (the audit's one-hour option).
  Rejected: ADR 007 ships optional features as internal plugins "to keep the API honest", and the
  host is what makes `registerSlashCommand` real for everything after mermaid.
- **Keep the CDN import.** Rejected for the reasons in Context 1, plus an e2e suite that would need
  the network to prove a diagram renders.
- **Do-nothing `Disposable`s for unsupported registrations.** Rejected: a plugin whose panel never
  appears learns nothing. A throw names the member on the first call; the plugin is marked `error`
  and the others still activate.
- **Deliver `block.*` events from the replica's change bus** with whatever payload could be
  assembled. Rejected: a `{ block, before, origin, txId }` the host made up is worse than no event.

## Consequences

- **The precache grows by 5 MB.** Production build, `tools/probes/web-build-weight.mjs`, before
  (`da85cfb`) → after: precache 91 → 207 entries, 2,795 → 7,829 KiB; JS on disk 1,612 → 6,652
  KiB; startup entry 513.2 → 521.8 KiB. The largest chunk is mermaid's ELK layout engine,
  1,456 kB (453 kB gzip), then cytoscape 435 kB (138 kB gzip) and a second KaTeX, 259 kB (mermaid
  pins 0.16; the app uses 0.18). None load on a page without a diagram
  (`e2e/tests/plugins.spec.ts`). Every install downloads them once, in the background, like
  research/14 §3's 732 KiB. `globIgnores` for these chunks would give that back at the cost of the
  first diagram needing the network. Not done here: `vite.config.ts` is shared and it is the owner's
  trade.
- The lockfile gains mermaid's dependency tree (+116 packages).
- Enabling or disabling a built-in plugin with `nooklet plugin disable` affects its server half
  only; the web app activates every compiled-in client half.
- In the desktop app word-count shows nothing until B-180 ships the server halves; mermaid works
  there, since it needs no server.
- Server start no longer runs esbuild for client halves at all. The first request for one pays
  for it: 12 MB and 572-657 ms for mermaid at load average 20 on 14 cores
  (`tools/probes/mermaid-client-bundle-cost.mjs`). What surfaced it: `built-ins.test.ts`'s activation
  test, which then bundled mermaid, passed its 5 s timeout during a full unit run at load average
  44 — though at that load plugin tests that bundle nothing heavy timed out too, so the 5 s is not
  all mermaid's.

- mermaid takes the app theme when the first diagram loads it; toggling light/dark later leaves
  already-initialised diagrams in the old theme until a reload.

## Verified on the owner's graph

2026-09-13, a `.backup` copy (952 pages) served on a production build: both of its mermaid
diagrams (journals 2022-12-15 and 2023-01-07, Czech labels, the second under a collapsed block
until expanded) render in light and dark Chromium, with no console warnings and no request leaving
the origin; word count reads "232720 words" on its 961-block page within 0.4-0.6 s of opening.

## Still unverified

- Bytes actually fetched for a first flowchart (mermaid lazy-loads per diagram type). Only
  "none on a page without a diagram" and "all from this origin" are asserted.
- mermaid rendering in WebKit / the Mac app's WKWebView; the e2e ran Chromium only.
- Install time on a phone with the larger precache.
- mermaid 12.0.0 was three days old when adopted (published 2026-09-10); 11.17.2 is the fallback if
  it misbehaves.
