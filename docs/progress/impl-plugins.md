# M8 · impl-plugins — progress log

Agent task: B-103 — client plugin halves never load. Build the smallest client plugin host that
makes the built-in plugins under `plugins/` work in the web app (bundled built-ins only, no remote
code): `/mermaid` in the slash menu, a mermaid fence renders, word-count shows a page's word count
(exposure audit item 14). Branch `m8/impl-plugins`, worktree
`<repo>/.claude/worktrees/wf_69b4f9a8-ee2-11`, from `da85cfb` (the worktree was
created at the older `41666ee`; branch reset to `da85cfb` before any change). e2e port **6404**.
Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/impl-plugins/`.

## 1. Done (commit hashes)

- `329d7f7` B-181: client bundles content-addressed in `<pluginDir>/.nooklet-build/`, not a leaked
  temp dir per start (`bundler.test.ts`). Inbox: B-103 in progress, B-180, B-181.
- `8d1e9c7` the host: `plugins/*` workspace members; mermaid bundled (lazy chunks) instead of
  jsdelivr; `apps/web/src/plugins/{host.ts,builtins.ts,ClientPlugins.tsx,StatusItems.tsx}`;
  `editor/render/PluginFence.tsx` + `tokens.tsx` hookup; `commands/slash/contributed.ts` +
  `SlashMenu.tsx` ranks it; `data/plugin-lookups.ts`; `store.ts#serverCaughtUpVersion`;
  `CommandLayer.tsx`/`AppShell.tsx` one-line mounts; plugin-api `page.changed` event; word-count
  client on `page.changed`; server bundles client halves lazily (`PluginHost.clientBundle`).
  Unit: web 13 host + 5 fence + 1 slash test new; server plugins 55/55 (sequential run — the
  machine was at load 44, parallel runs time out at vitest's 5 s in files I did not touch too).
- `1cf6d2c` `e2e/tests/plugins.spec.ts` (5 tests then) + `popups.spec.ts` SLASH_ORDER gains
  "Mermaid diagram".
- (next commit) ADR 023, spec §5 note, B-103 fixed + B-182 in the inbox, plugins.spec.ts lazy-chunk
  and same-origin assertions (6/6), `tools/probes/web-build-weight.mjs`,
  `tools/probes/mermaid-client-bundle-cost.mjs`.

e2e on 6404 (Chromium): plugins 6/6; popups + render + rendering + templates + query + navigation +
diagnostics 77/77; editing + views + shelf + parity + a-fresh-journal + focus 82/83 — the one
failure, views "opening the palette while editing…", also fails on `da85cfb` → B-182, not mine.

- `66c2fee` ADR 023, spec §5, inbox (B-103 fixed, B-182), probes, plugins.spec.ts 6/6.
- `b255b62` page events emitted `untrack`ed; plugin-api README points at what runs today.
  Re-verified: typecheck clean; unit web 703/703, plugin-api 17/17, server 523/523; e2e plugins +
  popups 49/49.
- Real graph (`.backup` copy in scratch, served on 6404, `scratchpad/impl-plugins/real-graph-probe*.mjs`):
  both owner mermaid diagrams render (light + dark, Czech labels, no console warnings, no
  off-origin requests); word count "232720 words" on OmnivoreSync (961 blocks) in 0.4-0.6 s.
  Observation, not filed: the graph also has Logseq `{{renderer code_diagram,mermaid}}` macros,
  shown as unknown macros (macro renderers are not implemented by the host).

## 2. In flight

Nothing uncommitted after the last commit.

## 3. Next steps, in order

1. Final: biome, `pnpm -r typecheck`, unit suites of web/plugin-api/server, report.
2. Coordinator: B-180 (desktop ships no plugin server halves), B-182 (palette focus regression),
   the precache decision (ADR 023 Consequences: +5 MB), `plugins/*` in the workspace + lockfile
   (+116 packages) when merging.

## 4. Decisions made and why

- **Built-in client halves are bundled into the web build**, not `import()`ed from the server's
  `/plugins/<id>/client.<hash>.js` at runtime: works offline under the service worker, no code
  fetched at runtime, typechecked with the app (which immediately caught a real type error in
  `word-count/src/client.ts` that esbuild had been stripping). User plugins in `<dataDir>/plugins`
  stay server-only until a runtime client host exists. → ADR 023.
- **mermaid is a real dependency of the mermaid plugin** (`12.0.0`, released 2026-09-10; pnpm's
  release-age policy accepted it), lazy-imported, not fetched from jsdelivr: local-first app,
  offline rendering, no unpinned third-party code at runtime, no network in e2e. Requires
  `plugins/*` as workspace members.
- **The server no longer bundles client halves at activation** — on first request instead. Once
  mermaid was bundled, eager bundling cost 12.06 MB of esbuild output per start (235-610 ms idle,
  measured with `scratchpad/impl-plugins/mermaid-probe/measure.mjs`; over 5 s under load, which is
  how `built-ins.test.ts` timing out surfaced it) for bundles nothing requests any more.
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

`cd` into the worktree, `git log --oneline da85cfb..` for what landed, then continue from §3.
e2e: `cd e2e && NOOKLET_E2E_PORT=6404 pnpm exec playwright test tests/plugins.spec.ts --project=chromium`.
