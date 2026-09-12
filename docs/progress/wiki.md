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
# serve for the Playwright check (port 6362; kill it when done). --no-mirror is a no-op in cli.ts.
pnpm nooklet serve --port 6362 --data "$DATA" --no-mirror
# browser + link verification (scratch script, not committed)
node /private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/verify-wiki.mjs http://127.0.0.1:6362
# regenerate the shortcuts page (loads the registrations through Vite SSR)
node docs/wiki/tools/generate-shortcuts.mjs
```

Never touch `~/.nooklet/default`.

## Pages

Done (committed, e366708 — 17 pages, 301 blocks, clean import): README.md, logseq/config.edn,
tools/generate-shortcuts.mjs, Home, Getting started, Concepts, guide, reference, concept,
Keyboard shortcuts (generated), Journals, Tasks, References and tags, Search, Settings, Sync,
Agents and MCP, Import from Logseq, Command line, Markdown format.

In flight (on disk, not yet import-checked/committed): Troubleshooting, Contributing, FAQ,
Architecture.

Still to do, in order:
1. Import all 21 pages; commit batch 4 if clean.
2. Regenerate Keyboard shortcuts right before the final commit (other agents are adding commands
   live; the page names the date).
3. `pnpm nooklet serve --port 6362 …` in the background, run `verify-wiki.mjs`, kill the server.
4. Final commit (regenerated shortcuts page + this file), then the report to the owner.

## Findings to report (code contradicts docs)

- Mirror: `ServerConfig.mirror` is read by nothing; `exportAll` runs only on `nooklet export`; no
  file watcher exists (chokidar is a dependency but unused). README/PLAN §5/OPERATIONS §2/ADR 002
  describe a continuous, consumed mirror. `--no-mirror` is a no-op (`parseArgs` never sets
  `mirror` to false; only `--mirror`/`--mirror <v>` shapes exist).
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

Import all 21 pages → commit batch 4 → serve → verify → regenerate shortcuts → final commit.
