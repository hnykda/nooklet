# M8 · impl-plugins — progress log

Agent task: B-103 — client plugin halves never load. Build the smallest client plugin host that
makes the built-in plugins under `plugins/` work in the web app (bundled built-ins only, no remote
code): `/mermaid` in the slash menu, a mermaid fence renders, word-count shows a page's word count
(exposure audit item 14). Branch `m8/impl-plugins`, worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-11`, from `da85cfb` (the worktree was
created at the older `41666ee`; branch reset to `da85cfb` before any change). e2e port **6404**.
Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-plugins/`.

**State: done.** Everything below is committed; nothing is in flight.

## 1. Done (commit hashes)

- `329d7f7` B-181: plugin client bundles content-addressed in `<pluginDir>/.nooklet-build/`, not a
  leaked temp dir per start (`bundler.test.ts`). Inbox: B-103 in progress, B-180, B-181.
- `8d1e9c7` the host: `plugins/*` workspace members; mermaid bundled (lazy chunks) instead of
  jsdelivr; `apps/web/src/plugins/{host.ts,builtins.ts,ClientPlugins.tsx,StatusItems.tsx}`;
  `editor/render/PluginFence.tsx` + `tokens.tsx` hookup; `commands/slash/contributed.ts` +
  `SlashMenu.tsx` ranks it; `data/plugin-lookups.ts`; `store.ts#serverCaughtUpVersion`;
  `CommandLayer.tsx`/`AppShell.tsx` one-line mounts; plugin-api `page.changed` event; word-count
  client on `page.changed`; server bundles client halves lazily (`PluginHost.clientBundle`).
- `1cf6d2c` `e2e/tests/plugins.spec.ts` + `popups.spec.ts` SLASH_ORDER gains "Mermaid diagram".
- `66c2fee` ADR 023, spec §5 note, inbox (B-103 fixed, B-182), plugins.spec.ts lazy-chunk and
  same-origin assertions, `tools/probes/web-build-weight.mjs`,
  `tools/probes/mermaid-client-bundle-cost.mjs`.
- `b255b62` page events emitted `untrack`ed; plugin-api README points at what runs today.
- `96b60af` ADR 023: verified on the owner's graph; mermaid theme fixed at first load.

## 2. Verification (final code)

- `pnpm -r typecheck` clean. Biome clean on every changed file (5 pre-existing warnings in
  `packages/plugin-api/src/client-context.ts`, same count as on `da85cfb`).
- Unit: web 703/703, plugin-api 17/17, server 523/523. (Earlier, at load average 44, parallel
  server runs timed out at vitest's 5 s in plugin files I did not touch as well; a sequential run
  was 55/55.)
- e2e, Chromium, port 6404: plugins 6/6 and popups 43/43 on the final code (49/49); before the
  `untrack` change also render + rendering + templates + query + navigation + diagnostics (with
  popups) 77/77, and editing + views + shelf + parity + a-fresh-journal + focus 82/83 — the one
  failure, views "opening the palette while editing…", fails identically on `da85cfb` → B-182.
- Owner's graph (`.backup` copy in scratch, served on 6404, `scratchpad/impl-plugins/real-graph-probe*.mjs`):
  both mermaid diagrams render (light + dark, Czech labels, no console warnings, no off-origin
  requests); word count "232720 words" on OmnivoreSync (961 blocks) in 0.4-0.6 s. Observation, not
  filed: the graph also has Logseq `{{renderer code_diagram,mermaid}}` macros, shown as unknown
  macros (the host implements no macro renderers).

## 3. Next steps (outside this branch)

1. Coordinator: B-180 (desktop app ships no plugin server halves — word count is empty there),
   B-182 (palette Escape focus regression, bisect it), the precache decision (ADR 023
   Consequences: +5 MB), and `pnpm-workspace.yaml` `plugins/*` + `pnpm-lock.yaml` (+116 packages)
   when merging — regenerate the lockfile rather than hand-merge it.

## 4. Decisions made and why

- **Built-in client halves are compiled into the web build**, not `import()`ed from the server's
  `/plugins/<id>/client.<hash>.js` at runtime: works offline under the service worker, no code
  fetched at runtime, typechecked with the app (which immediately caught a real type error in
  `word-count/src/client.ts` that esbuild had been stripping). User plugins in `<dataDir>/plugins`
  stay server-only until a runtime client host exists. → ADR 023.
- **mermaid is a real dependency of the mermaid plugin** (`12.0.0`, published 2026-09-10; pnpm's
  release-age policy accepted it), lazy-imported, not fetched from jsdelivr: local-first app,
  offline rendering, no unpinned third-party code at runtime, no network in e2e. Requires
  `plugins/*` as workspace members.
- **The server no longer bundles client halves at activation** — on first request instead. With
  mermaid inlined that bundle is 12 MB and ~0.6 s of esbuild at load average 20
  (`tools/probes/mermaid-client-bundle-cost.mjs`), paid on every start for bundles nothing
  requests any more.
- **ServerChangeEvents are not delivered on the client in v1**: the replica's change bus carries
  tables + page ids, not rows or ops, so a `block.updated` payload would be invented. Unsupported
  context members throw with their name. Added client-only `page.changed { page | null }` — fires
  on open, on leaving for no page, on any change to the open page's rows, and on push drain.
- **Slash commands go through the command registry** as `plugin.<camelId>.slash<Item>` with
  `when: editorFocused`, plus a row in `commands/slash/contributed.ts` (a signal, so rows added
  after first render appear).
- **RenderInfo's block/page** are read from the replica for the nearest `[data-block-id]` row;
  a fence outside any block row (the shelf) keeps its source rather than get an invented block.

## 5. How to resume

`cd` into the worktree, `git log --oneline da85cfb..` for what landed.
e2e: `cd e2e && NOOKLET_E2E_PORT=6404 pnpm exec playwright test tests/plugins.spec.ts --project=chromium`.
Build weight: `pnpm --filter @nooklet/web build && node tools/probes/web-build-weight.mjs`.
