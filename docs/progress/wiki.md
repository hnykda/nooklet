# Wiki progress (docs/wiki/)

Task: write the user wiki as a nooklet graph under `docs/wiki/` (Logseq file-graph layout the
importer reads), commit it in small increments, verify by importing and serving it.

Started 2026-09-12. Scope: `docs/wiki/**` and this file only.

## Commands

```sh
# import (must report zero errors, zero unintended warnings)
rm -rf /private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/wiki-data
pnpm nooklet import docs/wiki --data /private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/wiki-data
# serve for the Playwright check (port 6362; kill it when done)
pnpm nooklet serve --port 6362 --data /private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/wiki-data --no-mirror
# regenerate the shortcuts page
pnpm --filter @nooklet/web exec tsx <repo>/docs/wiki/tools/generate-shortcuts.ts
```

Never touch `~/.nooklet/default`.

## Pages

Planned order (commit every batch after a clean import):

1. README.md, logseq/config.edn, Home, Getting started, Concepts, guide, reference, concept
2. Journals, Tasks, References and tags, Search, Settings
3. Sync, Agents and MCP, Import from Logseq, Command line, Markdown format
4. Keyboard shortcuts (generated) + tools/generate-shortcuts.ts, Troubleshooting, Architecture,
   Contributing, FAQ
5. Playwright verification (scratch script), final report

Done (committed): none yet
In flight: batch 1

## Findings to report (code contradicts docs)

- Mirror: `ServerConfig.mirror` is read by nothing; `exportAll` runs only on `nooklet export`; no
  file watcher exists (chokidar is a dependency but unused). README/PLAN §5/OPERATIONS §2/ADR 002
  describe a continuous, consumed mirror. `--no-mirror` is a no-op (`parseArgs` never sets
  `mirror` to false).
- Task markers: PLAN §5 says NOW/LATER map to TODO/DOING on import; `outline.ts` and
  `TASK_MARKERS` keep them as distinct markers (same glyphs as TODO/DOING).
- Desktop: ADR 016 says v1 does not bundle the server; `apps/desktop` bundles a sidecar and
  reuses an already-running server on 6100 (README matches the code).
- Journal "Scheduled and deadline" section: PLAN says not built; confirmed absent in `apps/web`.
- ADR 019 is referenced by code comments but `docs/adr/019-*` does not exist (020 does).
- MCP tool list: 27 core tools + 5 `ui_*` (pinned in `mcp/server.test.ts`); spec's catalog is
  behind (no `trash_*`, `page_history`, `graph_links`, `system_diagnostics`, `page_merge`, etc.).

## Next steps

Write batch 1 pages, import, commit.
