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

## M8 run — 2026-09-13 07:55 (in flight)

One workflow, run `wf_69b4f9a8-ee2` (script:
`~/.claude/projects/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/workflows/scripts/m8-verify-review-build-wf_69b4f9a8-ee2.js`;
resume with `Workflow({scriptPath, resumeFromRunId})` — finished agents return cached results).
Base for every branch: `da85cfb`.

| Track | Agents | Branches (`m8/<slug>`) | e2e ports | New bug numbers |
|---|---|---|---|---|
| QA on a copy of the real graph → fixer per area | qa-editor, qa-views, qa-render-sync | `m8/qafix-editor`, `m8/qafix-views`, `m8/qafix-render-sync` | serve 6450–6452, fix 6460–6462 | B-240–269 |
| Review → skeptic refutes each finding → fixer per dimension | rv-server-sync, rv-server-security, rv-web-reactivity, rv-web-security | `m8/rv-*` | 6470–6473 | B-120–139 |
| Build → adversarial verify in the same worktree | impl-dates (B-96/102), impl-render (B-99/100/101), impl-commands (B-97/98/105/106), impl-plugins (B-103), impl-editor (B-88/108), impl-journal (scheduled section, B-94), impl-refs (B-89/104/111), impl-embeds, impl-export (md/print/favourites), impl-small (timestamps, find-in-page, read-only, random page) | `m8/impl-*` | 6400–6409 | B-140–239 |

Conventions for this run: agents never edit `docs/BUGS.md`; each writes `docs/bugs-inbox/<slug>.md`
(BUGS.md entry format; `### B-NN (existing)` for fixes to existing entries). Each keeps
`docs/progress/<slug>.md` on its branch.

### Integration (coordinator, after the run)
1. For each branch in priority order (qafix, rv, impl-editor, impl-dates, impl-render,
   impl-commands, impl-plugins, then the rest): `git merge --no-ff m8/<slug>` on main; resolve
   conflicts (expected in shared files only); typecheck + unit after each merge.
2. Fold `docs/bugs-inbox/*.md` into BUGS.md (existing → move to Fixed with the note; new → Open or
   Fixed by status), delete the inbox dir, one commit.
3. Full unit, full e2e, `verify` on a fresh real-graph copy; record numbers here.
4. Remove the worktrees (`git worktree list`), keep branches until the owner has seen the result.

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
