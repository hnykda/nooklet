# Bugs inbox · impl-plugins

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in.

---

### B-103 (existing)
**Status:** in progress · **Severity:** medium · **Found:** 2026-09-12, exposure audit

Client plugin halves never load: nothing in `apps/web` implements `ClientPluginContext`, so
`/mermaid`, the mermaid fence renderer and word-count's status item are unreachable.

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
