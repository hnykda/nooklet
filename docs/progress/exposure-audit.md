# Progress: exposure audit (2026-09-12)

Deliverable: `docs/review/2026-09-12-exposure-audit.md` (written incrementally). Nothing else in
the tree is to be changed by this task.

## Done
- Read CLAUDE.md, ops registry (`packages/server/src/ops/index.ts`, all `defineOp`s, `live/*`),
  every command registration, slash items, context menu, palette, settings, shell, routes, help,
  `data/store.ts` hooks and their call sites, mirror export, renderer, core exports.
- Part 1 inventory tables written from code (see the deliverable §1). Verdicts that need the
  running app are marked "pending" there until the runtime pass lands.
- Client built (`pnpm --filter @nooklet/web build` via the e2e global-setup); the spec
  `e2e/tests/a-fresh-journal.spec.ts` passed on port 6360 (server torn down by global-teardown).
- Two audit servers running (started with `run_in_background`, logs in the scratchpad):
  - 6361: `pnpm nooklet serve --port 6361 --data <scratch>/audit-data --no-mirror`
  - 6362: `pnpm nooklet serve --port 6362 --data <scratch>/audit-data-mirror` (mirror default —
    used only to test whether `serve` writes mirror files at all; code says it never does)
  - scratchpad: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad`

- Runtime pass done: `<scratch>/audit.mts` (needs `<scratch>/node_modules` symlink to the repo's;
  run from `e2e/` with `pnpm exec tsx`) → `<scratch>/audit-results.json`, `<scratch>/shots/`.
  Results are in the deliverable §1.9. Confirmed dead: collapse/expand all, plugin manager route,
  /scheduled, /deadline, /image, numbered lists, client plugin halves, mirror-on-serve. Also
  confirmed: block props invisible, scheduled/deadline invisible on rows, `/page/<alias>` 404s,
  embeds are placeholders, no delete/favourite on the page view.

- audit2 done and folded into §1.9 (follow-up paragraph): /pages fine (timing), `/property`
  inserts literal text (not a block_prop), Expand all dead, Cmd+O alias ranking works.
- §1.10 ranked gaps written (20 rows). Part 2 written (18 candidates + "not worth it" list).

- audit3 done: aliases work in `[[`/`#` on the rebuilt build; D14 withdrawn; §1.9 patched.
- Part 3 written. "Defects noticed" written (D1–D13, D14 withdrawn). "What landed" section
  written (tree moved a4d137f → f5b5248 during the audit: trash/history/replace views, refactor
  commands, query fence, highlight/KaTeX, templates, appearance).

- Re-grep at HEAD `f5b5248` done: every dead-surface claim still holds; "re-checked at HEAD"
  line added to §1.10.
- Servers on 6361/6362 stopped (`pkill -f 'serve --port 636[12]'`).

## Status: DONE
The deliverable is complete. Evidence kept in the scratchpad: `audit.mts`, `audit2.mts`,
`audit3.mts`, `audit-results.json`, `audit2-results.json`, `audit3-results.json`, `shots/*.png`,
`server-6361.log`, `server-6362.log`. Nothing else in the tree was changed by this task.

## If restarted
Nothing to do. (Coordinator rule for any re-run: start servers and Playwright probes in the
FOREGROUND — a backgrounded task would leave a restarted agent waiting forever. The two servers
here were started in the background before that rule arrived; they were stopped with `pkill` and
ports 6360/6361/6362 verified free at 18:00.) If the coordinator wants the scratch evidence preserved beyond the session, copy
`<scratch>/audit*-results.json` and `<scratch>/shots/` somewhere durable. (cheap wins) from research/13 §3.1–3.3, §4.1 plus what §1 established.
3. Write Part 3 (publish scoping). Logseq docs fetch failed twice (docs.logseq.com too large,
   raw github 404) — use research/13 §4.1/§4.3 and research/01 for Logseq Publish facts, and
   mark the rest unverified.
4. Final message: top five gaps, top five cheap wins with effort, publish verdict in three
   sentences.
5. Kill the two servers (background task ids b6yyx0nkn, b7zwsivmt) when done.

## Findings so far that must not be lost (already in the deliverable)
- `nooklet serve` never writes the markdown mirror; only `nooklet export` calls `exportAll`
  (grep: `exportAll(`/`exportPage(` callers are `cli.ts:305` only; `config.mirror.enabled` is
  read nowhere). README claims otherwise.
- No client-side plugin host exists in `apps/web` (no code fetches `/plugins/<id>/client.*.js` or
  `/api/v1/plugins`), so the word-count status item and the mermaid renderer never mount.
- `task.setScheduled`/`task.setDeadline` (palette, `/scheduled`, `/deadline`) go to
  `createFakeDatePickerHost()` in `app/CommandLayer.tsx:301` — they do nothing.
- `block.collapseAll`/`block.expandAll`/`block.insertImage` are registered and shown, but
  `editor/BlockTree.tsx`'s `runCommand`/selection switch has no case for them.
- `listNumber` is hard-wired `false` (`editor/numbering.ts` header, `BlockTree.tsx:112`), so
  numbered lists never render although the research table says "have".
- `app.openPluginManager` navigates to `/settings/plugins`, a route that does not exist.
- No UI anywhere can delete a page (`page.delete` has no client caller).
