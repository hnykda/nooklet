# Coordinator progress — session of 2026-09-12

Resume file. If you are reading this because the previous session was cut off, start here, then
`git log --oneline -30`, then every other file in `docs/progress/` (one per agent), then
`docs/BUGS.md`'s Open section.

## Done today (all on `main`, none pushed — 20+ commits ahead of origin)

- ADR 018 journal names + display-format setting; page icons; asset import + B-51; B-43 storage
  fallback; the code-review batch (B-52–B-63, review agent); the e2e expansion (+166 tests) and
  every bug it found fixed: B-64–B-84 (`615777c`, `f639465`, `7bf1c3b`, `cf50211`, `c9a98f9`,
  `7d6cdfc`). Whole e2e suite: 222 passed, 3 skipped by design. Unit: 1,320.
- research/13 (Logseq usage and demand) committed; PLAN.md M7 added; PLAN.md's four
  contradictions with the code fixed.

## In flight — eight agents, disjoint file ownership

| Slug (`docs/progress/<slug>.md`) | Scope | Owns | Port |
|---|---|---|---|
| m7-query | ```query``` fence (ADR 011), `/query`; highlighter + KaTeX seams; bundle numbers | `packages/core/src/query*`, fence recognition in `tokens.ts`/`outline.ts`, `apps/web/src/editor/render/**`, `livePreview.ts`, `data/queries.ts`, `docs/adr/011` amend, `docs/research/14` | 6350 |
| m7-templates | `template::` blocks, `/template`, `<% today %>`, journal template, ADR 019 | `plugins/templates/**` or `commands/registrations/templates.ts` + `data/templates.ts`, `views/VirtualJournalDay.tsx`, `data-api.ts#journal()` only, `docs/adr/019` | 6351 |
| m7-refactors | block→page, move to page, page merge, find & replace; ops + MCP + UI | new `ops/{block-to-page,block-move-to-page,page-merge,graph-replace}.ts`, `commands/registrations/refactor.ts`, `views/FindReplaceView.tsx`, `data-api.ts` (not `journal()`) | 6352 |
| m7-views | reference filters/sort, appearance basics, shelf outline card, link-all-unlinked | `views/ReferencesPanel.tsx`, `referenceGrouping.ts`, `shell/Shelf.tsx`, `data/appearance.ts`, `styles/shell.css` tokens, `ops/page-link-unlinked.ts` | 6353 |
| m7-trash-history | trash list/restore, page history timeline, orphan-asset GC | new `ops/{trash-list,trash-restore,page-history}.ts`, `views/TrashView.tsx`, `views/HistoryView.tsx`, `data/history.ts`, `gc.ts`, `cli.ts` gc case | 6354 |
| exposure-audit | read-only: what is built vs reachable; cheap wins below the top ten; publish-a-graph scoping | `docs/review/2026-09-12-exposure-audit.md` only | 6360/6361 |
| research-collab | sharing, membership, co-editing, presence, hosting for friends, prior art | `docs/research/15-collaboration-and-sharing.md` only | — |
| wiki | `docs/wiki/` as a nooklet file graph; must import with zero errors | `docs/wiki/**` only | 6362 |

Shared, append-only files (re-read before edit): `commands/slash/items.ts` (query, templates),
`views/SettingsPanel.tsx` (templates, views), `ops/index.ts` (refactors, views, trash),
`App.tsx` (refactors, trash), `BlockContextMenu.tsx` ENTRIES (refactors), `Sidebar.tsx`
(trash), `docs/BUGS.md` (all). `docs/PLAN.md` is the coordinator's.

Each agent was told: keep its progress file current, commit small and often, never `git add -A`,
never push. Their final reports are relayed to the owner by the coordinator.

## Hand-backs the coordinator owes once agents report

- Trash/history: a "History" link on `views/PageView.tsx` (agent may not edit it).
- Any "needed change elsewhere" the agents list.
- PLAN.md M7 status per item; ADR numbers taken concurrently (019 templates; 020+ first come).
- Fold the audit's gap list and cheap wins into the queue; decide on publish-a-graph with the
  owner; fold the collab shortlist into PLAN as a proposal, not a milestone.
- The wiki becomes the first candidate for publishing.

## Pending on the owner

- B-42 (needs-repro): which runtime — `/Applications/nooklet.app` (built Sep 11 14:38, predates
  everything since) or the browser at 127.0.0.1:6100 — and whether it reproduces after a hard
  reload / rebuild. B-65 (fixed) is the likely explanation.
- Pushing: 20+ commits ahead of `origin/main`; nothing has been pushed this session.

## How to resume

- Ports in use by agents: 6350–6354, 6360–6362; the coordinator uses 6330. Default e2e 6188.
- `cd e2e && NOOKLET_E2E_PORT=<port> pnpm exec playwright test` — always set the port.
- Never open `~/.nooklet/default` with a `nooklet` command; copy it first
  (`sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph.sqlite'"`).
- Scratchpad: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/`.
- Attribution lines for commits are in the session's system reminder; all agents were given them.
