# Coordinator progress — session of 2026-09-12

Resume file. If you are reading this because the previous session was cut off, start here, then
`git log --oneline -30`, then every other file in `docs/progress/` (one per agent), then
`docs/BUGS.md`'s Open section.

## Done today (all on `main`, none pushed — 60+ commits ahead of origin)

- ADR 018 journal names + display-format setting; page icons; asset import + B-51; B-43 storage
  fallback; the code-review batch (B-52–B-63, review agent); the e2e expansion (+166 tests) and
  every bug it found fixed: B-64–B-84 (`615777c`, `f639465`, `7bf1c3b`, `cf50211`, `c9a98f9`,
  `7d6cdfc`). Whole e2e suite: 222 passed, 3 skipped by design. Unit: 1,320.
- research/13 (Logseq usage and demand) committed; PLAN.md M7 added; PLAN.md's four
  contradictions with the code fixed.

## M7 — all eight workstreams done (evening of 2026-09-12)

| Slug (`docs/progress/<slug>.md`) | Landed |
|---|---|
| m7-query | `core/query.ts` + ```` ```query ```` fence view, `/query`; highlight.js + KaTeX behind lazy seams; ADR 011 amended; research/14 (bundle numbers). B-94 open (query `today` after midnight). |
| m7-templates | `/template` picker, `template::` blocks, journal template via `journal-template:: true`, `<% today %>` on both birth paths, Settings section, ADR 019. Agent hit its usage limit with unit 3 written and green; coordinator landed it as `c8da61c` (B-107 fix + `templates.spec.ts`). B-108 open (template insert not in Cmd+Z). |
| m7-refactors | `block.to_page`, `block.move_to_page`, `page.merge`, `graph.replace` (+ MCP), context-menu entries, `/replace` view, ADR 020; registry allows `_` in a segment with a tool-name collision check. B-85 (core cross-page `block.move` strands descendants), B-86 (`[[Page|label]]` refs), B-88 (editing row outlives its block) open. |
| m7-views | `mentions.link`, reference filters/sort (ADR 021), appearance, shelf outline. |
| m7-trash-history | `trash.list/restore`, `page.history`, Trash and History views, asset GC (`gc --asset-grace`), ADR 022 (no expiry). Coordinator: History link on the page (`1fc867b`), B-90 core fix (`18f9ff2`), B-91 (`64ecfbc`). |
| exposure-audit | `docs/review/2026-09-12-exposure-audit.md`; its D1 (mirror never written by serve) fixed as B-95 (`adc2b1a`), plus B-109 `--no-mirror` (`64ecfbc`). B-96–B-106 still open — the queue below. |
| research-collab | `docs/research/15`; shortlist presence → share links → conflicts UI → Tailscale hosting → membership → OT last. Not in PLAN as a milestone; a proposal when the owner wants it. |
| wiki | `docs/wiki/` — 21 pages, imports with 0 warnings, verified rendering. Found B-109/B-110 and seven doc-vs-code drifts (listed in its report; see queue). |

Coordinator's own commits after the agents: `adc2b1a` B-95, `1fc867b` History link, `34a5214` e2e
artifacts keyed by port + OUT-27, `18f9ff2` B-90, `c8da61c` templates unit 3, `64ecfbc`
B-91/B-109/B-110, `e86b1f8` PLAN M7 done + 29 fixed entries moved to Fixed, `da449c7` one
`callOp`, `a6c2859` e2e day-offset collision.

Final numbers on `a6c2859`: `pnpm -r typecheck` clean; unit 1,551 passing (331 core + 17 + 519
server + 684 web); full Chromium e2e 286 passed / 1 failed / 2 skipped — the one failure was the
day-offset collision fixed in `a6c2859` (22/22 on rerun of the two specs involved; the full suite
was not rerun after it); `pnpm nooklet verify` on a fresh copy of the real graph: OK, 20,411 ops.

## Queue (in order of worth), none started

1. Audit gaps: no page-delete in the UI (B-96 region — check the exact ids in BUGS.md), fake date
   picker, five dead palette rows, client plugin host (B-103; blocks `/mermaid` and every plugin
   slash command). Cheap wins from the audit: journal-day scheduled section, date chips,
   collapse/expand all, transcluding embeds, page export/print.
2. Core: B-85 cross-page `block.move` strands descendants (data integrity — the op layer works
   around it, the reducer does not); B-86 `[[Page|label]]` refs never resolve.
3. Doc drifts the wiki found: PLAN §5 NOW/LATER mapping (code keeps them distinct); ADR 016 says
   the desktop app does not bundle the server (it does, sidecar on 6100); ADR 017 `tagged_pages`
   group does not exist; ADR 004's UUID→id import table is in memory only; mcp-tools §3.9 says
   `mcp --stdio` goes over HTTP (it opens the DB). ADR 002 / PLAN §5 describe a file watcher
   (`chokidar` unused) — decide: build it or strike it.
4. Publish-a-graph (2–3 days per the audit) — the wiki is the first candidate. Owner's call.
5. `changes-since.ts`: classify asset rows beyond "uploaded" (GC deletions, dedupe touches).

## M8 run — 2026-09-13, done and integrated

One workflow (`wf_69b4f9a8-ee2`, 38 agents, 0 errors): 3 QA explorers on copies of the real graph →
3 fixers; 4 reviewers → a skeptic per dimension (35 of 37 findings survived) → 4 fixers; 10 builders
→ an adversarial verifier each in the same worktree (9 fixed defects on their branch, 1 solid).
All 17 branches `m8/*` merged into main (merge commits `…` through `db4f1eb`), inbox folded
(`5454b49`), 26 bugs open.

### What landed (by branch)
- QA editor: redo of a new block (B-240), undo after selection delete (B-241), Alt+Up/Down undo focus
  (B-242), fresh-client journal draft (B-243), `[[` New page mid-first-sync (B-244).
- QA views: Replace all stale fields (B-250), Restore/Undo overwriting later edits (B-251), references
  truncation (B-253), Turn into page names (B-254), Trash rename-on-conflict (B-255), alias restore (B-256).
- QA render/sync: live mirror follows renames/moves/markers/props (B-260), title rename through the
  server (B-261), export of missing files (B-262), `tag:task` (B-263), `$$` math (B-264), collapsed
  template (B-265), `javascript:` hrefs (B-268).
- Review server/core (B-120–B-124, plus B-85/86/90/91 follow-ups); server security (B-125 graph.replace
  in a worker with a 2 s budget, B-126 NAME_MAX mirror names, B-127 importer symlinks, B-128 `u` flag,
  B-129 query depth); web reactivity (B-130–B-133); web security (B-137 asset Alt+Enter, B-138 fence
  classes + KaTeX size, B-139 block-ref Alt+Enter).
- Builders: date picker + chips (B-96, B-102, B-141, B-143, B-145); numbered lists, visible
  properties, /image (B-99–B-101, B-150, B-152–B-154); dead commands, plugin list, open on shelf
  (B-97, B-98, B-105, B-106, B-160); client plugin host — /mermaid, word count (B-103, B-183…);
  template undo and edited-row-leaves (B-108, B-88); journal Scheduled-and-deadline section + midnight
  (B-94, B-170, B-174); alias routes, Pages tagged X, create props bag (B-104, B-111, B-89, B-202);
  read-only embeds (B-210, B-212, B-214…); copy/export/print/favourite (B-220–B-223); timestamps,
  find in page, read-only lock, random page, search filters (B-230–B-234…).
- Coordinator: B-146 `--help` (an agent served the owner's live graph for 10 min through it — no
  content changed; pre-incident copy at `~/.nooklet/backup-2026-09-13-before-accidental-serve.sqlite`).

### Integration choices (so nobody re-litigates)
- Parallel duplicate fixes: kept B-250 over B-134, B-240 over B-190, B-130/B-131 over B-135/B-136,
  B-143 over B-266 (both tests kept), B-268's scheme denylist over B-138's allowlist.
- Skipped from `m8/rv-web-security`: `6d1cb2e` (allowlist), `3d73b13` (one-POST-path refactor) and
  `373c654` (page paths module) — overlapping refactors that conflicted with the reactivity branch;
  worth redoing on the merged tree. `ff140b1`/`eb3face` were duplicates.
- `m8/impl-export` moved the page renderer to core; the security branch's NAME_MAX-safe
  `pageFilePath` was kept in `mirror/export.ts`.

### Numbers on the merged tree
Unit: core 393, plugin-api 17, server 608, web 1,000 — all green after `9f410e3`. `verify` on a
fresh copy of the live graph: OK, 20,411 ops. Fresh import of the Logseq graph: 127 pages + journals,
18,628 blocks, 171 assets, 0 dangling; verify OK; 24 scheduled dates (was 4), 0 leftover `SCHEDULED:`.
Full Chromium e2e on `4709bd8`'s tree: **439 passed, 0 failed, 2 skipped** (7.0 min). Worktrees
removed; the 17 `m8/*` branches are kept until the owner has looked.

### Owner decisions waiting
- Plugin host precache: +5 MB (mermaid's ELK layout, cytoscape) — keep, lazy-exclude, or drop mermaid.
- Repair the 20 blocks in the live graph that still hold `SCHEDULED:` text (re-import or one-off op).
- B-192: what wins when a remote rewrite meets unsaved typing.
- Journal agenda: include non-task dated blocks? cap the overdue list?
- Date picker built as a typed line, not the spec's time/repeat toggles.

## Pending on the owner

- B-42 (needs-repro): which runtime — `/Applications/nooklet.app` (built Sep 11 14:38, predates
  everything since) or the browser at 127.0.0.1:6100 — and whether it reproduces after a hard
  reload / rebuild. B-65 (fixed) is the likely explanation.
- Pushing: 60+ commits ahead of `origin/main`; nothing has been pushed this session.

## How to resume

- Ports in use by agents: 6350–6354, 6360–6362; the coordinator uses 6330. Default e2e 6188.
- `cd e2e && NOOKLET_E2E_PORT=<port> pnpm exec playwright test` — always set the port.
- Never open `~/.nooklet/default` with a `nooklet` command; copy it first
  (`sqlite3 ~/.nooklet/default/graph.sqlite ".backup '<scratch>/graph.sqlite'"`).
- Scratchpad: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/`.
- Attribution lines for commits are in the session's system reminder; all agents were given them.
