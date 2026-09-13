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

