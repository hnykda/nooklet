# Coordinator progress — session of 2026-09-12

Resume file. If you are reading this because the previous session was cut off, start here, then
`git log --oneline -30`, then every other file in `docs/progress/` (one per agent), then
`docs/BUGS.md`'s Open section.

## Assessment — 2026-10-03 (READ THIS FIRST)

The 2026-09-14..16 work (ADR 025 multi-graph hosting, the Capacitor iOS shell, desktop remote mode)
had sat uncommitted for two weeks. It is now on `main` as `26e1f10` (generated iOS project) and
`cb79009` (everything else, with its docs). Nothing is pushed: `main` is ~635 commits ahead of
`origin/main`. All merged branches were deleted. Only `m8/rv-web-security` is kept, because it was
cherry-picked in part on purpose (see "Integration choices" under M8). No worktrees, servers or
agents are left running.

### In flight (started 2026-10-03, agents in git worktrees, branches not yet merged)
Each agent writes `docs/progress/<slug>.md`, including a "BUGS.md updates to fold in" section, and
commits on its own worktree branch. The coordinator merges the branches, folds in the BUGS text, and
runs the full e2e suite on the merged tree.
| Slug | Task | e2e port |
|---|---|---|
| b585 | B-585 fix, **merged** (`7784d54`); B-587 cause found, not fixed | 6301 |
| keys-small | B-450 (mimic Logseq), B-594, B-592 | 6302 |
| journal-headings | B-560, **merged** (`9f41585`) | 6303 |
| top-menu | the "⋯" top-right menu (B-541 follow-up) | 6304 |
| tag-autocomplete | B-380 option (c), **merged** (`c6fe3bc`) | 6305 |
| mermaid-lazy | mermaid out of precache, single sidecar copy | 6306 |
| real-device-test | readiness and runbook for the Mac + own server + physical iPhone test | 6307 |
| refs-count | references count like Logseq, **merged** (`7d34d03`, B-596) | 6308 |
| empty-journal | B-595, an editable empty journal day like Logseq | 6309 |
| sweep-core | readiness sweep: daily-use loop on a copy of the real graph → `docs/review/2026-10-03-sweep-core.md` | 6310 |
| sweep-devices | readiness sweep: multi-device/desktop/Simulator flows → `docs/review/2026-10-03-sweep-devices.md` | 6311-6313 |
| sweep-scope | readiness sweep: PLAN v1 vs reality → `docs/review/2026-10-03-sweep-scope.md` | — |
If cut off: `git worktree list` shows the branches; read each progress file.

### State of `main`
- `pnpm -r typecheck` clean. Unit: core 423, plugin-api 17, server 780, web 1,383, all green after
  B-590 (two calendar tests that failed on the 3rd of every month).
- Full Chromium e2e: 657 passed, 9 failed, 2 skipped (14.7 min). Known failures: B-585 (ref-page
  creation; ref-pages ×3, remote-rewrite ×1), the B-581/B-568 probe spec ×2, B-592 ×1, B-561's
  search flake ×1, and B-590's e2e sibling ×1 (fixed after the run). `cb79009`'s message credits
  B-585 with 5. Triage later showed the fifth (autocomplete-inside-link, the B-382 test) is B-592:
  since ADR 024 the "page that does not exist" precondition cannot hold, and it fails on `629f572`
  too. The probe spec is rewritten and passes 2/2. Its B-581 "hang" was a probe artifact
  (`isVisible` ignores its timeout), so B-581 is now "not reproduced". B-593 (a connectivity e2e
  race) was found and logged.
- Expected next full e2e: only B-585 ×4, B-592 ×1 and the B-561/B-593 order flakes. Not yet run.
- One web unit run showed 1 failure out of 1,383 that the next two runs did not repeat. Which test
  it was is unknown, because the output was not captured.
- `biome check . --diagnostic-level=error`: clean (B-591 fixed; B-594 found along the way).
- `pnpm nooklet verify` was NOT run this pass.

### Threads and where they stand
| Thread | State | Resume file |
|---|---|---|
| ADR 025 multi-graph hosting | M1–M6 done. M7 (graph switcher on the iOS Simulator) not started. A human click-through of the desktop picker has never been done | `multi-graph-hosting.md` |
| Capacitor iOS (PLAN M5) | Builds and runs on the Simulator, local-only works. No physical device, no native plugin call, no completed server connect, no Android | `mobile-ios.md` |
| Desktop remote mode | Superseded by ADR 025 M6 | `desktop-remote-mode.md` |

### Open bugs that matter most (high severity, all in BUGS.md Open)
- **B-585**: client-side ref-page creation loses keystrokes and mints junk pages. Silent data loss,
  and the main source of e2e red. Fix this first.
- **B-587**: server rebuild-parity divergence after a push-first name collision. Not investigated;
  possibly related to B-585.
- **B-581**: a cold navigation to a zero-block page hangs on "Loading…".
- **B-42**: the `[[` popup drops focus in the desktop app. Waiting on the owner's focus log.
- **B-491**: `confirm()`/`alert()` are dead in the desktop app.

### The 2026-09-13 to-dos: none started (audited 2026-10-03)
B-560 (date headings open the day), the B-541 "⋯" top-right menu, B-380 option (c), mermaid out of
the precache plus a single sidecar copy, the references heading count. The order below still stands.

### Owner decisions (answered 2026-10-03)
B-534: keep the allowlist, no `zotero://`. B-450: mimic Logseq. B-472: deferred ("no for now").
"Synced via another tab" label: keep. References heading count: Claude to decide, owner leaning Logseq → switch to Logseq's count (agent refs-count).

### Suggested next steps, in order
1. B-585 (then re-check B-587 against it). B-592 is a quick test fix.
2. A human click-through of the desktop picker and ADR 025 M7 on the Simulator. Both are short,
   and both are verification gaps rather than code work.
3. The 2026-09-13 to-do list below.
4. Push: `main` has never been pushed since the M8 runs. That is the owner's call.

## Session end — 2026-09-13 evening

Everything from the M8–M11 runs is merged into `main` and nothing is running. No agent, workflow or
server of this session is left. Nothing has been pushed: `main` is 626 commits ahead of `origin/main`.
All 43 `m8/*`–`m11/*` branches are merged except `m8/rv-web-security`, of which only a subset was
cherry-picked on purpose (see "Integration choices" under M8); the branches are kept, the worktrees
are removed.

### State of `main` at the end
- Unit: core 423, plugin-api 17, server 744, web 1,300 — all green (web 1,300 before `0d7ae24`'s one
  test-only change). `pnpm -r typecheck` clean.
- `pnpm nooklet verify` on a fresh copy of the live graph: OK.
- Full Chromium e2e on `0d7ae24`: **634 passed, 1 failed, 2 skipped** (11.8 min). The failure is B-561
  (search-fallback keyword test, order-dependent: passes alone). The first full run on the merged tree
  had 11 failures; 9 were real merge interactions fixed in `0d7ae24` (tests reading the old text sync
  indicator; the delete dialog vs ADR 024), 1 passed alone (autocomplete, load/order).
- Schema is v7 now (ADR 024's indexes). A desktop `.app` built before this is v6 and its bundled
  server would refuse the migrated graph (B-430's case) — rebuild the app after the owner's server
  has run the new code.

### What the owner does to see today's work (in this order)
1. Stop the running `pnpm nooklet serve` (port 6100) and quit the desktop app.
2. `pnpm install && pnpm --filter @nooklet/web build` in the repo, then `pnpm nooklet serve`.
   First start runs the migrations: pages for the 259 referenced-but-missing names (ADR 024), schema
   v7. The service-worker fix (B-532) means the next app/browser load picks up the new client.
3. Optional, the SCHEDULED text repair (owner approved): with the server stopped,
   `pnpm nooklet repair org-dates` (dry run, expect 20 blocks, 0 left alone), then
   `pnpm nooklet repair org-dates --apply` (keep the batch_id; `batch_undo` reverses it), then
   `pnpm nooklet verify`. Backups: `~/.nooklet/backup-2026-09-13-before-accidental-serve.sqlite`.
4. Desktop app: `export PATH="$HOME/.cargo/bin:$PATH"; pnpm --filter @nooklet/desktop sidecar &&
   pnpm --filter @nooklet/desktop exec tauri build --bundles app`, then
   `open apps/desktop/src-tauri/target/release/bundle/macos/nooklet.app`. Never copy it into
   /Applications unless the owner asks.
5. B-42 (focus lost in the desktop app): Diagnostics (click the sync cloud) → Focus log → "Record
   focus changes" → reproduce → Copy log → hand it to the next session. Not reproducible in
   Playwright WebKit or Chromium (dozens of scenarios, real-graph copy).
6. `/goal clear` — the "maximize the last hour" goal is still set and will keep a session going.

### To-dos agreed with the owner but NOT started (do these next, in this order)
1. B-560: journal date headings open that day's page.
2. B-541 follow-up: a top-right "⋯" menu — Settings, All pages, Graph, Trash, Keyboard shortcuts /
   Help, Diagnostics — next to the sync cloud and agent icon.
3. B-380 option (c): no `#` autocomplete when the caret is inside an existing tag.
4. Mermaid out of the PWA precache (lazy on first use) and the desktop sidecar reusing the web
   build's copy instead of shipping a second (~12 MB).
5. The references heading count: stays "blocks" unless the owner picks Logseq's top-level count.

### Owner decisions still open (each in its BUGS.md entry)
- B-534: app links (`zotero://`) from the desktop app — prompt, allowlist, or stay dead.
- B-450: Enter on a focused button while a block selection stands.
- B-472: a typed `foo:: bar` line becoming a real property on first edit.
- "synced via another tab" label: keep or drop (sync indicator is now an icon; the text is its tooltip).

### Incidents today (so they are not repeated)
- An agent ran `nooklet serve --help`, which served the live graph for ~10 min (content unchanged,
  verified; B-146 fixed). Every agent prompt now exports `NOOKLET_DATA=<scratch>` first.
- SendMessage to a running workflow agent resumed a duplicate in the same worktree; the duplicate
  was stopped. Do not message running workflow agents.
- A devtest desktop app took keyboard focus from the owner's window (~17:56); a few keystrokes went
  into a scratch graph. Devtest launches must not steal focus while the owner works.
- The inbox fold script duplicated 120 BUGS.md entries once (section boundary found by any "## "
  line); fixed and redone from the pre-fold copy.

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

## M11 runs — 2026-09-13 evening (in flight)

- `wf_975bcd44-fae` (base `52e5d20`, branches `m11/<slug>`, ports 6410–6415): ref-pages (pages exist once
  referenced — owner request; ADR 023), keys-in-fields (B-300 option c), remote-rewrite (B-192),
  mirror-escape (B-342 option b), repair-agenda (SCHEDULED text repair tool — coordinator applies it
  to the live graph after reading the report; agenda non-task dated blocks + overdue collapse),
  delete-launcher (Delete page; B-430). Each verified adversarially.
- `wf_b8e786c1-020` (base `52e5d20`, ports 6416–6418): webkit-focus (B-42 — owner: desktop app only,
  on sync refresh mid-`[[dru`), ref-label-flash (B-500 — `((id))` on every refresh), search-fallback
  (explain why search fell back; embeddings were never configured on the owner's graph; Ollama +
  bge-m3 available).
- Still from M10 (`wf_ced35de1-fb8`): `m10/editor-keys` (verifier running), `m10/tests-desktop`
  (finishing). Merged already: `m10/core-ops`, `m10/qafix-regression`.
- `wf_dd1ff6ba-1f5` (m11c, port 6419–6421): desktop-shell — B-541 title bar over the toolbar, Settings/Graph
  reachability, native menu, service-worker updates in WKWebView; builds its own devtest app (never the owner's).
- B-540 (sync must be silent): a duplicate agent instance was stopped; its recorder and notes are in
  `scratchpad/m11b/sync-quiet-handoff/`. Owner: "don't over do it" — when `m11/ref-label-flash` lands, keep only a proportionate fix (the block-ref cache no longer emptied on every write, one test) and drop broad re-render changes; the B-540 follow-up is just the quiet indicator.
- `wf_1121291a-729` (m11d, port 6422): quiet-topbar — cloud sync icon with a status dot, agent-access badge as an icon (B-540).
- Follow-up after desktop-shell + quiet-topbar land: top-right "⋯" menu (Settings, All pages, Graph, Trash, Help, Diagnostics) — owner request, B-541.
- Held until M10 lands: B-380 option (c) (no tag popup inside an existing tag), mermaid out of the
  PWA precache, sidecar reusing the web build's mermaid.
- Owner decisions recorded 2026-09-13: all twelve recommendations accepted (see BUGS.md B-194,
  B-291; spec R38). `/Applications/nooklet.app` removed (in the Trash); never copy builds there.
  A fresh desktop build from `adadff1` is at `apps/desktop/src-tauri/target/release/bundle/macos/`.

## M10 run — 2026-09-13 (in flight)

Workflow `wf_ced35de1-fb8`, base `70c9bb9`, branches `m10/<slug>`. editor-keys (B-282/294/295/344/346,
port 6400, B-380–389), core-ops (B-310/311/322/324/370, 6401, B-390–399), tests-desktop
(B-292/323/333/335/356/371/336/337, 6402, B-400–409), each verified adversarially; plus a final
regression QA pass on the real graph (serve 6450) → fixer (6460, B-410–419). Integration: as M8/M9.

## M9 run — 2026-09-13, done and integrated

Workflow `wf_e473942f-106`: 22 agents, 0 errors. Six bug-area branches each verified adversarially
(5 fixed-up, 1 solid); two QA explorers on the M8 features (6 + 6 findings, all handled); two
reviewers of the M8 merge resolutions (5 web + 4 server findings, all confirmed and fixed). All ten
`m9/*` branches merged into main (`…` through `0aabb86`); inbox folded (`1cc25b1`).

Integration choices: B-225 was built twice (render-views: `page-icon-request.ts` + `page-actions.css`;
qafix-m8-views: a signal in `PageIcon.tsx` + "Change icon"). Kept render-views'; re-applied
qafix-m8-views' `PageTitleField` (B-350) in `PageView.tsx` by hand. `PageActions` history link now
uses `routes/page-path.ts#historyRoutePath` (cleanup removed `navigateTarget#pageNameToPath`).

Numbers on the merged tree: unit core 398, plugin-api 17, server 667, web 1,126 — green.
Full Chromium e2e: **524 passed, 0 failed, 2 skipped** (7.3 min). `verify` on a fresh copy of the
live graph: OK. 24 bugs open.

Owner decisions added by this run: B-194 (undo skips steps on blocks that left the page — reversible
in two lines), B-300 (how a standing block selection and a focused text field share keys), B-291
(IME composition while the date picker is open — needs the picker to own focus), B-342 (typed
property-shaped lines vs real properties in the mirror), cleanup's +12 MB mermaid client bundle in
the desktop sidecar.

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
