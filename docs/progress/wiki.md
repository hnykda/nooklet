# Wiki progress (docs/wiki/)

Task: write the user wiki as a nooklet graph under `docs/wiki/` (Logseq file-graph layout the
importer reads), commit it in small increments, verify by importing and serving it.

Started 2026-09-12. Scope: `docs/wiki/**` and this file only.

## Commands

```sh
# import (must report zero errors, zero warnings, pagesImported > 0). Path MUST be absolute:
# `pnpm nooklet` runs with cwd packages/server and a relative path silently imports nothing.
DATA=/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/wiki-data
rm -rf "$DATA"
pnpm nooklet import <repo>/docs/wiki --data "$DATA"
# serve for the Playwright check (port 6363; kill it when done). --no-mirror is a no-op in cli.ts.
pnpm nooklet serve --port 6363 --data "$DATA" --no-mirror
# browser + link verification (scratch script, not committed)
node /private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/verify-wiki.mjs http://127.0.0.1:6363
# regenerate the shortcuts page (loads the registrations through Vite SSR)
node docs/wiki/tools/generate-shortcuts.mjs
```

Never touch `~/.nooklet/default`.

## Pages

All 21 pages done and committed: e366708 (17 pages), a08d492 (Troubleshooting, Architecture,
Contributing, FAQ), 4797ca1 (mirror pages follow B-95; nested-fence fix on Markdown format).

Final verification (2026-09-12, after 4797ca1): import 21 pages / 422 blocks, 0 warnings,
0 errors, 0 dangling refs; `verify-wiki.mjs` against `serve --port 6363`: all 21 pages render
blocks in Chromium with the right title, all 21 distinct [[link]] targets resolve, Keyboard
shortcuts renders 5 tables. Server on 6363 stopped. Port 6362 was another agent's server
(`audit-data-mirror`) and was never touched. Keyboard shortcuts regenerated before the final
commit: 84 commands, 48 bound, identical to the committed page.

In flight: nothing. Still to do: nothing — task complete; report delivered to the coordinator.

## Findings to report (code contradicts docs)

- Mirror: SUPERSEDED mid-task by `adc2b1a` (17:54, B-95) — `serve` now runs `startLiveMirror`
  (commit-triggered, 500 ms debounce, sweep on start). Still export-only: no file watcher
  (chokidar unused). Pages corrected accordingly (Markdown format, Command line, Architecture, FAQ).
- `--no-mirror` is STILL a no-op even though B-95 says "honoured for the first time":
  `parseArgs` is unchanged (`flags.get("mirror") !== false`; `--no-mirror` sets key `no-mirror`).
  Verified: `serve --port 6363 --data <scratch> --no-mirror` wrote 21 files into `<scratch>/pages/`.
- CLI: `nooklet import <dir>` on a directory that does not exist reports success with zero pages
  and no warning (relative paths through `pnpm nooklet` resolve inside `packages/server`).
- Task markers: PLAN §5 says NOW/LATER map to TODO/DOING on import; `outline.ts` and
  `TASK_MARKERS` keep them as distinct markers (same glyphs as TODO/DOING).
- Desktop: ADR 016 says v1 does not bundle the server; `apps/desktop` bundles a sidecar and
  reuses an already-running server on 6100 (README matches the code).
- ADR 017: `page_backlinks` has no `tagged_pages` group anywhere in the server; the client does
  not list tagged pages.
- ADR 004: says the UUID→id mapping is kept in an import table for idempotent re-import; the
  importer keeps it in memory only.
- mcp-tools.md §3.9: describes `nooklet mcp --stdio` as an HTTP client to `/mcp`; `cli.ts` opens
  the database directly.
- Journal "Scheduled and deadline" section: PLAN says not built; confirmed absent in `apps/web`.
- ADR 019 is referenced by code comments but `docs/adr/019-*` does not exist (020 does).
- MCP tool list: 27 core tools + 5 `ui_*` (pinned in `mcp/server.test.ts`); spec's catalog is
  behind (no `trash_*`, `page_history`, `graph_links`, `system_diagnostics`, `page_merge`, etc.).
- B-86 (`[[Page|label]]` refs) still open; documented on References and tags.

## Next steps

None. If restarted: nothing to resume; `git log --oneline -3 -- docs/wiki` shows the three
commits. To re-verify, run the commands above.
