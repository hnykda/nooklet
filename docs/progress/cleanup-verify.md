# cleanup-verify: adversarial check of m9/cleanup (B-330, B-331/332, B-144/334, B-180)

Worktree `.claude/worktrees/wf_e473942f-106-10`, branch `m9/cleanup`, e2e port 6405. Scratch:
`<scratchpad>/m9/cleanup-verify/` (NOOKLET_DATA, the real-graph copy, logs).

## Done (verified, re-run by this agent)

- Read the whole diff `cf08d19..816d9c3`; compared intent with `3d73b13` and `373c654`.
- `pnpm -r typecheck` clean. `apps/web` 1024/1024; three full web runs at once (load ~34): 3×1024.
  `packages/server` 610/610. Biome on the 52 changed files: only the 3 errors + 1 warning in
  `DiagnosticsPanel.tsx`, identical at `cf08d19` (base file swapped in).
- e2e (port 6405): namespace-paths, follow-link, navigation, references, history, trash, replace,
  link-unlinked: 36/36.
- Probe spec (not kept): namespaced names with Czech diacritics, `%`, `?`, `#`, quotes — hrefs
  have no `%2F`, a full page load of each rendered href opens the page, clicks land on the same
  URL; Alt+Enter on a lowercased Czech link and on a link to a not-yet-created page both open.
- B-180: rebuilt the sidecar at HEAD, `tools/probes/sidecar-plugins.mjs` 4/4. Sidecar
  `plugin list` from `/` on a scratch graph lists the 3 bundled plugins; dev `nooklet plugin list`
  still lists the repo's 3. Sidecar `serve` on the real-graph copy: plugins listed,
  `page.wordcount` on `TTRPG/VTM-alpha` = 157 blocks / 5110 words, the UI's word-count status item
  shows "5110 words", no `%2F` among the page's hrefs, an aborted search shows
  "Search failed. could not reach http://127.0.0.1:6405 (Failed to fetch)".
- `built-ins.test.ts` + `bundled.test.ts` together 12× (they write the same `.nooklet-build`
  files from two workers): 12/12.

- Riskiest edge, now tested: a namespaced name holding what a URL gives meaning to.
  `e2e/tests/namespace-paths.spec.ts` "a copied link to a namespaced page opens it, whatever the
  name holds: Czech, %, ?, #, quotes" (loads each rendered href fresh) and
  `apps/web/src/views/navigateTarget.test.ts` "… survives the browser's URL parser, with a zoom
  query after it" (6 names, incl. the owner's `TTRPG/VTM-alpha/Isabella D'Angelo`). Both pass
  (spec 10/10); both fail with `pageNameToPath` mutated to `encodeURI` per segment (e2e 1/1
  failed, unit 1 failed), and the unit cases fail with whole-name `encodeURIComponent`.

- Stale pointers: `App.tsx` / `PageRoute.tsx` still sent readers to `views/navigateTarget.ts` for
  the path encoding, and `canonicalPageRoute.test.ts` mocked the store for an import that is gone
  (fixed, `6c49cc6`).
- More e2e on port 6405: search-filters, graph, diagnostics, settings, plugins, refactor, shelf,
  embeds, query, query-task-tag, tagged-pages, tasks, page-rename, page-identity, connectivity,
  views, rendering, render, untrusted-content, journal-agenda, history-later-edits, trash-conflict,
  replace-stale, replace-unicode, references-cap, references-filters: 148 passed, 1 failed —
  `views.spec.ts:461` (B-161): failed again alone at HEAD, and alone with `cf08d19`'s `apps/web`
  and `e2e` swapped in (so not this branch). The other 43 specs: 104 passed + 1 skipped, and
  162 passed + 1 skipped. With the 36 + 10 above, every spec file has run on this tree.
- `packages/core` 393/393, `packages/plugin-api` 17/17 (load ~11). `nooklet verify` on the
  real-graph copy after the sidecar served it: 20,411 ops replayed, OK.
- Found in passing, logged (not caused by the branch, outside its brief): B-336 — a user's own
  plugin in `<data>/plugins` cannot resolve `@nooklet/plugin-api`/`zod` in the sidecar (probe
  `tools/probes/sidecar-user-plugin.mjs`, exits 1); B-337 — `build-sidecar.mjs` ships a stale
  `apps/web/dist` if one exists.
- Not logged, theoretical: `bundled.test.ts` and `built-ins.test.ts` both write the repo plugins'
  `.nooklet-build/server.mjs` (esbuild `write: true`, not atomic) from separate vitest workers;
  12 runs of the pair showed no torn read.

## In flight

- nothing uncommitted.

## Verdict

Solid: the four parts do what the brief asked, verified in a browser, on a built sidecar and on the
real-graph copy. This agent added tests (`3d24e77`) and comment fixes (`6c49cc6`), no code fixes.

