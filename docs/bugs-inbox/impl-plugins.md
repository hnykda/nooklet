# Bugs inbox · impl-plugins

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in.

---

### B-103 (existing)
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-12, exposure audit · **Test:**
`e2e/tests/plugins.spec.ts` (all six), `apps/web/src/plugins/host.test.ts`,
`apps/web/src/editor/render/PluginFence.test.tsx`, `apps/web/src/commands/slash/SlashMenu.test.tsx`
"shows a row contributed while it is open…"

Client plugin halves never load: nothing in `apps/web` implements `ClientPluginContext`, so
`/mermaid`, the mermaid fence renderer and word-count's status item are unreachable.

**Fixed 2026-09-13.** A client plugin host (ADR 023): the built-in client halves are compiled into
the web build (`apps/web/src/plugins/builtins.ts`) and activated at startup inside the command
layer. `registerSlashCommand` registers a registry command and contributes a slash row — the menu
now ranks a signal (`commands/slash/contributed.ts`), not the module constant that made any
runtime row impossible; `registerCodeBlockRenderer` feeds a registry `tokens.tsx`'s fence case
consults (`editor/render/PluginFence.tsx`); `registerStatusItem` mounts into a top-bar strip.
Unimplemented context members throw with their name. mermaid is now the plugin's own dependency,
lazily loaded, instead of a jsdelivr fetch; word-count listens to a new client-only
`page.changed`. Compiling word-count's client half with the app found a type error esbuild had
been stripping since M4 (`CountResult` as an `interface` is not `Json`), fixed in the same commit.
The tests that would have caught it: `plugins.spec.ts` "/mermaid is in the slash menu and
inserts a diagram that renders", "a mermaid fence renders as a diagram, not as code", "word count
shows the open page's words and follows edits (audit item 14)"; `host.test.ts` "activate and
register /mermaid, the mermaid fence renderer and the word-count status item".

---

### B-180 · The desktop app ships no built-in plugins' server halves
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-plugins (by reading, not
reproduced in a built app) · **Test:** none

`packages/server/src/cli.ts#pluginDirsFor` finds the built-in plugins at `plugins/` three levels
above the CLI file, and `apps/desktop/build-sidecar.mjs` copies no `plugins/` directory into the
sidecar. So in the Mac app the `page.wordcount` op and its `page_wordcount` MCP tool do not exist,
and word-count's client half (bundled into the web build since B-103) shows no count there — its
`rpc.call("count")` has no server half to answer. Fix: ship the built-in plugins' server bundles
with the sidecar (or discover them from a resource path the sidecar sets).

---

### B-181 · Every server start leaks a temp directory per plugin client half
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, impl-plugins · **Test:**
`packages/server/src/plugins/bundler.test.ts` "writes into the plugin's own .nooklet-build,
content-addressed, never a temp dir per call"

`packages/server/src/plugins/bundler.ts#bundleClientEntry` bundles into a fresh
`mkdtemp(tmpdir(), "nooklet-plugin-client-")` on every activation and nothing ever removes it. On
this machine `$TMPDIR` held **2,063** `nooklet-plugin-client-*` directories (counted 2026-09-13 with
`readdirSync(os.tmpdir())`) — every `nooklet serve`, every e2e run and every server unit test that
loads plugins adds two. Harmless at ~2 KB each; not once mermaid is bundled rather than fetched
from a CDN (B-103), which makes each one 12 MB.

**Fixed 2026-09-13.** The client bundle is built in memory (`write: false`), hashed, and written
once to `<pluginDir>/.nooklet-build/client.<hash>.js` (already gitignored, where the server half's
bundle lives) through a per-process temp name and a rename, so concurrent servers on one checkout
write identical bytes safely and a restart with unchanged source writes nothing. The directories
already in `$TMPDIR` are not cleaned up by this. The test that would have caught it:
`bundler.test.ts` "writes into the plugin's own .nooklet-build, content-addressed, never a temp dir
per call" (bundles twice, asserts one file inside the plugin dir).

---

### B-182 · Closing the command palette with Escape leaves the editor unfocused again
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, impl-plugins (regression of a
B-72 fix) · **Test:** `e2e/tests/views.spec.ts` "opening the palette while editing and closing it
hands focus back to the editor" — currently failing

Edit a block, Cmd/Ctrl+K, Escape: the palette closes but `.cm-content` is no longer focused, so the
next keystroke goes nowhere. The e2e test B-72 added for exactly this fails on `da85cfb` itself
(1 run, port 6404, production build) and on `m8/impl-plugins` (2 runs), each time with
`toBeFocused` → "inactive" after 10 s — so it is not load and not the plugin host. Not
investigated beyond establishing that; which commit between B-72's fix and `da85cfb` broke it is
the next question (`git bisect` over `e2e/tests/views.spec.ts -g "opening the palette"`).


---

### B-183 · Diagrams drop back to their source and re-draw on every edit anywhere on their page
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "a diagram stays drawn while another block on its page is
edited (B-183)"; `apps/web/src/editor/render/PluginFence.test.tsx` "a fence re-created for the same
source shows the last drawing at once, not its source (B-183)"

Every write to a page (one coalesced op per typing pause in any block, a sync pull) re-creates the
rendered content of every row on it — rows survive, their `.vr-block-view` children do not
(pre-existing; probed by marking a paragraph, a code `<pre>` and the diagram in untouched rows,
typing in a fourth: all three were new nodes). For synchronous content that is invisible. For a
plugin fence it is not: `PluginFence` starts from the `<pre>` source and mermaid draws
asynchronously, so each write flashed every diagram on the page back to its source. Measured with
a `requestAnimationFrame` sampler: 4 flashes of 14–52 ms, 328 px → 95 px → 328 px, typing three
words in a sibling row; on the owner's graph copy (journal 2022-12-15) 9 frames without the
diagram, 452 px → 134 px, everything below it jumping.

**Fixed 2026-09-13.** `PluginFence` remembers the last thing each renderer drew per language +
source (`WeakMap` per renderer, 64 entries) and puts it into a re-created fence synchronously,
before the renderer runs again, so no frame paints the source. The rows re-creating their content
is not changed. Without the fix the e2e test saw 8 frames without the diagram.

---

### B-184 · A mermaid fence that fails to parse leaves a "Syntax error" drawing under <body>
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "a broken mermaid fence says why instead of rendering nothing"
(now also asserts no `body > [id^="dnooklet-mermaid-"]`)

`mermaid.render` appends a temp `div#d<id>` to `document.body`; on a parse error it draws its
"Syntax error in text" bomb there and throws without removing it (mermaid 12.0.0
`renderDiagram`: `removeTempElements()` runs on that path only with `suppressErrorRendering`).
Three broken fences left three such divs; with B-183 every edit to the page added more. Hidden by
`body { overflow: hidden }` but in the DOM and the accessibility tree.

**Fixed 2026-09-13.** `plugins/mermaid/src/client.ts` initialises mermaid with
`suppressErrorRendering: true`; the error still reaches the plugin's catch and is shown in the fence.

---

### B-185 · `/mermaid` leaves the caret after the closing fence
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `e2e/tests/plugins.spec.ts` "/mermaid is in the slash menu and inserts a diagram that
renders" (types " --> C" straight after inserting); `apps/web/src/plugins/host.test.ts` "/mermaid
inserts the starter diagram at the caret through the editor host" (asserts the caret)

The starter was inserted with the caret after "```", so the next keystroke produced "```X" — no
longer a closing fence — and the diagram became a parse error. Core "Code block" puts the caret
inside its fence.

**Fixed 2026-09-13.** The slash command passes `insertText(STARTER, { cursor })` to land at the end
of "  A --> B". `EditorApi.insertText`'s `cursor` is now documented as an offset into the inserted
text, which is what the host already implemented.

---

### B-186 · A client half that fails to bundle is re-bundled on every unauthenticated request
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verification of impl-plugins ·
**Test:** `packages/server/src/plugins/bundler.test.ts` "is bundled once per activation, however
often its unauthenticated URL is requested"

Since client halves are bundled on first request (`PluginHost.clientBundle`, B-103 work), a failed
bundle reset the cached promise so "a later request retries". The route that asks,
`GET /plugins/:id/:file`, is mounted before the auth gate, so anyone who could reach the server
could make it run esbuild once per request for any plugin whose client half does not build (3
requests → 3 esbuild runs and 3 error logs in the test before the fix), and the 500 body echoed
esbuild's message, absolute paths included.

**Fixed 2026-09-13.** The rejection stays cached until the plugin is reloaded (a reload activates a
fresh entry, which bundles again); the 500 body says to see the server log.
