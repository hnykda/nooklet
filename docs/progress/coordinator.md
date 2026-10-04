# Coordinator progress — session of 2026-09-12

Resume file. If you are reading this because the previous session was cut off, start here, then
`git log --oneline -30`, then every other file in `docs/progress/` (one per agent), then
`docs/BUGS.md`'s Open section.

## In flight — 2026-10-04 evening

| Slug | Task | Ports |
|---|---|---|
| releases | `pnpm release <v>`; Woodpecker images (owner registry + public GHCR, multi-arch); GitHub Actions release on `v*` tags: macOS (unsigned, signing-ready), Linux, Windows, Android APK (new Capacitor android project), checksums, draft→publish; RELEASING.md. Owner decisions 2026-10-04: CI split Woodpecker+Actions; no Apple program yet; targets GHCR, Linux, Android, Windows | 6475-6479 |
| qr-pairing | QR pairing with one-time, expiring pairing codes (not long-lived tokens in links); Settings → Devices (list/revoke, `admin`-gated per B-655); `nooklet pair` terminal QR; iPhone-camera custom-scheme check | 6470-6474 |

## Published — 2026-10-04 (READ THIS FIRST)

All agent work is merged; no worktrees or agents are running. Final verification on the scrubbed
tree (separate worktree): typecheck + biome clean, leak-check clean, unit core 479 / plugin-api 17 /
server 812 / web 1,623, site build OK, full e2e **777 passed, 0 failed, 2 skipped**.

History: rewritten with `git filter-repo --replace-text/--replace-message` (the leak audit's map,
kept privately outside the repo); final tree byte-identical to the scrubbed tree; leak-check clean
over every commit and message; cited commit hashes in docs remapped (1,369 refs). Force-pushed to
`origin/main` (`41666ee` → `5c665b1`) with lease; repo made public again the same day (owner's
choice: right after the push). A private backup of the old history is at
`~/nooklet-pre-rewrite-2026-10-04.bundle` (never push it). Old commits may stay reachable on GitHub
by exact hash until GitHub GCs them. The leaked `nk_` token (hash prefix `e2409163`) must be
revoked wherever it exists. `core.hooksPath = tools/git-hooks` runs the leak check before commits.

Owner decisions this round: deployment tiers (tailnet + HTTPS + per-device tokens default);
`admin` gates server administration (B-655, not implemented yet); empty test graph; Logseq parity
throughout. Still the owner's to do: the infra repo's draft deployment PR steps (DNS, SOPS root token,
Woodpecker activation with fork protection, merge, run), and the leaked-token check.

## Production round — 2026-10-04

Owner: bring nooklet to production. Plan agreed: the app server tailnet-only (Tailscale operator,
single replica, PVC, SOPS root token, `--no-loopback-token`, nightly backup); a public static
landing+docs site at nooklet.danielalder.cz (Next.js static export, docs/guide as single source,
search, llms.txt); deploy through the owner's Woodpecker + infra-repo (draft PR there).
**Deployment tiers (owner decision 2026-10-04):** (1) recommended default — tailnet-only + HTTPS +
per-device tokens; (2) possible with a checklist — public behind a TLS reverse proxy (pending the
security review); (3) unsupported — plain http beyond localhost.
**The GitHub repo is already public; local main is ~770 commits unpushed and contains personal
data — do NOT push until the leak audit's remediation is decided by the owner.**

| Slug | Task | Ports |
|---|---|---|
| leak-audit | **merged** (`59d84fc`); 246 hits left in test files/deploy → scrub after all merges; repo made PRIVATE 2026-10-04; owner chose: rewrite all history + force-push | — |
| public-docs | docs/guide (9 pages), README, SECURITY, CONTRIBUTING, **merged** (`018e917`); mismatches B-653..B-659 | 6440-6444 |
| site | apps/site, **merged** | 6445-6449 |
| b660 | real data loss after gc on a new device, **merged** (`b514ba6`) | 6465-6469 |
| b652 | real silent text loss, **merged** (`6484cd0`, ADR 027 am. 1); B-678..B-680 |  6460-6464 |
| security-review | **merged**: enforced route inventory, headers/CSP, body limits, loopback-token default; B-672..B-677; backlog H1-H12 in PLAN M13 | 6455-6459 |
| infra | generic deploy/ + .woodpecker, **merged**; infra-repo draft PR #59 | 6450-6454 |

Incident: the first launch of these four ran in **infra-repo** worktrees, because the coordinator's
shell had `cd`-ed into infra-repo and the worktree isolation follows the coordinator's cwd. Caught by
the leak agent before any writes landed; the stray worktrees and branches were removed and
infra-repo' main checkout was confirmed untouched. Rule: never `cd` the coordinator's shell into
another repo; use `git -C` / absolute paths.

## Real-device test feedback round — 2026-10-04 (in flight)

The owner ran the first real test (Mac desktop + iPhone against `~/nooklet-test` on 6200; still
running — agents must never touch 6100/6200, `~/nooklet-test` (except a read-only `sqlite3 .backup`),
or the main checkout's `apps/web/dist`). Fixed during the test: B-638 (serve on a new data dir).
Logged: B-639 (white screen after adding the server; suspected dist rebuild mid-load) and
B-640..B-651 from the owner's feedback. Agents in flight (worktrees, all based on `ae90be5`):

| Slug | Task | Ports |
|---|---|---|
| b640 | invisible text = WebKit content-visibility paint bug, **merged** (`7d92d6c`); B-660 FK log | 6400-6404 |
| b641 | offline references etc., **merged** | 6405-6409 |
| b642 | readable conflict copies, **merged** (`0c4a275`, ADR 027); B-652 race logged | 6410-6414 |
| phone-ui | B-646, B-648..B-651, **merged** (`c7c822a`); B-661..B-664 logged | 6415-6419 |
| desktop-local-graph | B-643/B-644, **merged** (`b2f737a`, ADR 028) | 6420-6424 |
| all-pages | B-645, **merged** (`7ee1b0e`) | 6425-6429 |
| icon-picker | B-647 emoji picker, **merged** (`4d055c3`) | 6430-6434 |

## Ready for the first real-device test — 2026-10-03 evening (READ THIS FIRST)

All agent work of 2026-10-03 is merged into `main`; no worktrees, no agents, no servers running.
Nothing pushed (`main` ~750 commits ahead of `origin/main`); pushing is the owner's call.

**Final verification on `main` (coordinator, `62abb3b`):** `pnpm install --frozen-lockfile` ok;
`pnpm -r typecheck` clean; `biome check . --diagnostic-level=error` clean; unit core 473,
plugin-api 17, server 781, web 1531 — all pass; full e2e (Chromium + WebKit projects)
**740 passed, 0 failed, 2 skipped** (19.4 min). `nooklet verify` was run by the sweeps and agents
on their scratch graphs (OK), not by the coordinator on this tree.

**Next:** the owner's test, per `docs/progress/real-device-test.md` (Option L: test server on the
owner's Mac, port 6200, `--data ~/nooklet-test`, empty graph; Mac desktop app at
`http://127.0.0.1:6200`; iPhone app at the LAN IP via a `nooklet://connect` link). Never touch
the owner's live server on 6100 or `~/.nooklet`.

**Never verified on real hardware:** a physical iPhone (signing, local-network prompt, plugin
bridges, background/resume, eviction/restore), the real Mac app window (the desktop picker has
never been clicked through), WKWebView specifics beyond Playwright WebKit.

**Open, worth knowing during the test:** B-636 (`sw-update` flake, possibly a real service-worker
takeover race; PWA only), B-605 (deferred), B-472 (deferred), B-597 (alias "New page"), B-603's
QR (no library; owner's call), B-628 (OpenAI-compat provider sends no API key), D2 (homeserver details +
Ollama for semantic search).

## Assessment — 2026-10-03 morning

The 2026-09-14..16 work (ADR 025 multi-graph hosting, the Capacitor iOS shell, desktop remote mode)
had sat uncommitted for two weeks. It is now on `main` as `0af1fbf` (generated iOS project) and
`e3a2bf6` (everything else, with its docs). Nothing is pushed: `main` is ~635 commits ahead of
`origin/main`. All merged branches were deleted. Only `m8/rv-web-security` is kept, because it was
cherry-picked in part on purpose (see "Integration choices" under M8). No worktrees, servers or
agents are left running.

### In flight (started 2026-10-03, agents in git worktrees, branches not yet merged)
Each agent writes `docs/progress/<slug>.md`, including a "BUGS.md updates to fold in" section, and
commits on its own worktree branch. The coordinator merges the branches, folds in the BUGS text, and
runs the full e2e suite on the merged tree.
| Slug | Task | e2e port |
|---|---|---|
| b585 | B-585 fix, **merged** (`ec791f5`); B-587 cause found, not fixed | 6301 |
| keys-small | B-450, B-594, B-592, **merged** (`64fd85b`) | 6302 |
| journal-headings | B-560, **merged** (`5e9d772`) | 6303 |
| top-menu | "⋯" menu, **merged** (`1cefaf4`) | 6304 |
| tag-autocomplete | B-380 option (c), **merged** (`14ca14d`) | 6305 |
| mermaid-lazy | mermaid lazy + single sidecar copy, **merged** (`183b058`, `8f637ba`) | 6306 |
| real-device-test | runbook + CORS, bare-address, proxy-token fixes, deploy/ drafts, **merged** (`757dcf9`) | 6307 |
| refs-count | references count like Logseq, **merged** (`3568f91`, B-596) | 6308 |
| empty-journal | B-595, **merged** (`7506ea2`); B-605 deferred | 6309 |
| sweep-core | **done**: basic loop works; B-606..B-610 → `docs/review/2026-10-03-sweep-core.md` | 6310 |
| sweep-devices | **done**; B-611..B-619 → `docs/review/2026-10-03-sweep-devices.md` | 6311-6313 |
| sweep-scope | readiness sweep: PLAN v1 vs reality → `docs/review/2026-10-03-sweep-scope.md` | — |
| b587 | B-587, real divergence, **merged** (`af9968e`, ADR 026) | 6314 |
| b491 | B-491, **merged** (`5107b69`) | 6315 |
| pairing | D3, B-602, B-603, B-604, B-607, B-616, runbook, **merged** | 6316-6319 |
| b606 | B-606, **merged** (`d2320f0`) | 6320-6324 |
| tasks-workflow | B-608, B-610, B-617, **merged** (`4250be9`, `81fb0cb`); empty graph defaults to `now` | 6325-6329 |
| b609 | B-609, **merged** (`f31cfaf`, `b5609ff`) | 6330-6334 |
| local-graphs | B-611, B-612, B-619 + 2 more, **merged** (`03a8205`, `985f939`); B-631 open (discard deletes all) | 6335-6339 |
| connection-states | B-613, B-614, B-615, B-618 + B-632, **merged** (`a7ef909`) | 6340-6344 |
(B-617 → tasks-workflow; B-616 + runbook localhost fix → pairing.)
| b631 | B-631, **merged** (`984ee90`); B-633 found and fixed by the coordinator | 6355-6359 |
| e2e-green | B-623 (real regression), B-624, B-561, B-593 + shelf regression, **merged**; final runs 739/1 and 740/0 | 6350-6354 |
| server-search | local-first search + server semantic enrich, **merged** (`4a4ffe1`, `e09a4c9`) | 6345-6349 |
If cut off: `git worktree list` shows the branches; read each progress file.

### Incidents 2026-10-03 (so they are not repeated)
- An agent opened the iOS Simulator window in front of the owner, who closed it. Agents must use
  the Simulator headless only: `xcrun simctl boot <udid>`, never `open -a Simulator`.
- Two agents' servers collided on port 6315. Give each agent its own port range.
- Two agents shared one booted Simulator device. The app on it was still connected to the pairing
  agent's scratch server, so another agent's input wrote a page "something" there (not the owner).
  Each agent must `simctl create` its own device, address it by UDID (never `booted`, never
  `shutdown all`), and delete it when done. The pairing agent's final checks ran on a private
  device after the incident, so they stand.

### State of `main`
- `pnpm -r typecheck` clean. Unit: core 423, plugin-api 17, server 780, web 1,383, all green after
  B-590 (two calendar tests that failed on the 3rd of every month).
- Full Chromium e2e: 657 passed, 9 failed, 2 skipped (14.7 min). Known failures: B-585 (ref-page
  creation; ref-pages ×3, remote-rewrite ×1), the B-581/B-568 probe spec ×2, B-592 ×1, B-561's
  search flake ×1, and B-590's e2e sibling ×1 (fixed after the run). `e3a2bf6`'s message credits
  B-585 with 5. Triage later showed the fifth (autocomplete-inside-link, the B-382 test) is B-592:
  since ADR 024 the "page that does not exist" precondition cannot hold, and it fails on `77b1fee`
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

### Owner decisions pending for the real test (from `docs/progress/real-device-test.md`)
D1 **answered 2026-10-03: the owner's Mac** (runbook option L, LAN) for the first test, **empty graph** (no import); homeserver later; D2 homeserver
details (namespace, hostname, volume size, memory limit, image build trigger). D3 decided by the
coordinator: add `--no-loopback-token` (agent pairing). D4 is checked by runbook step H6.

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
- Unit: core 423, plugin-api 17, server 744, web 1,300 — all green (web 1,300 before `3b90a35`'s one
  test-only change). `pnpm -r typecheck` clean.
- `pnpm nooklet verify` on a fresh copy of the live graph: OK.
- Full Chromium e2e on `3b90a35`: **634 passed, 1 failed, 2 skipped** (11.8 min). The failure is B-561
  (search-fallback keyword test, order-dependent: passes alone). The first full run on the merged tree
  had 11 failures; 9 were real merge interactions fixed in `3b90a35` (tests reading the old text sync
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
  every bug it found fixed: B-64–B-84 (`e3bfbe9`, `db188ba`, `1b4a8b9`, `b7686df`, `fe3273e`,
  `19255fc`). Whole e2e suite: 222 passed, 3 skipped by design. Unit: 1,320.
- research/13 (Logseq usage and demand) committed; PLAN.md M7 added; PLAN.md's four
  contradictions with the code fixed.

## M7 — all eight workstreams done (evening of 2026-09-12)

| Slug (`docs/progress/<slug>.md`) | Landed |
|---|---|
| m7-query | `core/query.ts` + ```` ```query ```` fence view, `/query`; highlight.js + KaTeX behind lazy seams; ADR 011 amended; research/14 (bundle numbers). B-94 open (query `today` after midnight). |
| m7-templates | `/template` picker, `template::` blocks, journal template via `journal-template:: true`, `<% today %>` on both birth paths, Settings section, ADR 019. Agent hit its usage limit with unit 3 written and green; coordinator landed it as `763eab8` (B-107 fix + `templates.spec.ts`). B-108 open (template insert not in Cmd+Z). |
| m7-refactors | `block.to_page`, `block.move_to_page`, `page.merge`, `graph.replace` (+ MCP), context-menu entries, `/replace` view, ADR 020; registry allows `_` in a segment with a tool-name collision check. B-85 (core cross-page `block.move` strands descendants), B-86 (`[[Page|label]]` refs), B-88 (editing row outlives its block) open. |
| m7-views | `mentions.link`, reference filters/sort (ADR 021), appearance, shelf outline. |
| m7-trash-history | `trash.list/restore`, `page.history`, Trash and History views, asset GC (`gc --asset-grace`), ADR 022 (no expiry). Coordinator: History link on the page (`54f106d`), B-90 core fix (`b9a1871`), B-91 (`cf652bc`). |
| exposure-audit | `docs/review/2026-09-12-exposure-audit.md`; its D1 (mirror never written by serve) fixed as B-95 (`2d4c31b`), plus B-109 `--no-mirror` (`cf652bc`). B-96–B-106 still open — the queue below. |
| research-collab | `docs/research/15`; shortlist presence → share links → conflicts UI → Tailscale hosting → membership → OT last. Not in PLAN as a milestone; a proposal when the owner wants it. |
| wiki | `docs/wiki/` — 21 pages, imports with 0 warnings, verified rendering. Found B-109/B-110 and seven doc-vs-code drifts (listed in its report; see queue). |

Coordinator's own commits after the agents: `2d4c31b` B-95, `54f106d` History link, `e9fbda1` e2e
artifacts keyed by port + OUT-27, `b9a1871` B-90, `763eab8` templates unit 3, `cf652bc`
B-91/B-109/B-110, `6c14697` PLAN M7 done + 29 fixed entries moved to Fixed, `a34e59c` one
`callOp`, `b9023e9` e2e day-offset collision.

Final numbers on `b9023e9`: `pnpm -r typecheck` clean; unit 1,551 passing (331 core + 17 + 519
server + 684 web); full Chromium e2e 286 passed / 1 failed / 2 skipped — the one failure was the
day-offset collision fixed in `b9023e9` (22/22 on rerun of the two specs involved; the full suite
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

- `wf_975bcd44-fae` (base `ac2528e`, branches `m11/<slug>`, ports 6410–6415): ref-pages (pages exist once
  referenced — owner request; ADR 023), keys-in-fields (B-300 option c), remote-rewrite (B-192),
  mirror-escape (B-342 option b), repair-agenda (SCHEDULED text repair tool — coordinator applies it
  to the live graph after reading the report; agenda non-task dated blocks + overdue collapse),
  delete-launcher (Delete page; B-430). Each verified adversarially.
- `wf_b8e786c1-020` (base `ac2528e`, ports 6416–6418): webkit-focus (B-42 — owner: desktop app only,
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
  A fresh desktop build from `c30cb37` is at `apps/desktop/src-tauri/target/release/bundle/macos/`.

## M10 run — 2026-09-13 (in flight)

Workflow `wf_ced35de1-fb8`, base `007052a`, branches `m10/<slug>`. editor-keys (B-282/294/295/344/346,
port 6400, B-380–389), core-ops (B-310/311/322/324/370, 6401, B-390–399), tests-desktop
(B-292/323/333/335/356/371/336/337, 6402, B-400–409), each verified adversarially; plus a final
regression QA pass on the real graph (serve 6450) → fixer (6460, B-410–419). Integration: as M8/M9.

## M9 run — 2026-09-13, done and integrated

Workflow `wf_e473942f-106`: 22 agents, 0 errors. Six bug-area branches each verified adversarially
(5 fixed-up, 1 solid); two QA explorers on the M8 features (6 + 6 findings, all handled); two
reviewers of the M8 merge resolutions (5 web + 4 server findings, all confirmed and fixed). All ten
`m9/*` branches merged into main (`…` through `9b60f5c`); inbox folded (`e569262`).

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
All 17 branches `m8/*` merged into main (merge commits `…` through `ccaf23f`), inbox folded
(`8b5c38b`), 26 bugs open.

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
- Skipped from `m8/rv-web-security`: `48e0a9a` (allowlist), `5d12eaa` (one-POST-path refactor) and
  `24ee675` (page paths module) — overlapping refactors that conflicted with the reactivity branch;
  worth redoing on the merged tree. `5eee913`/`2fd98ad` were duplicates.
- `m8/impl-export` moved the page renderer to core; the security branch's NAME_MAX-safe
  `pageFilePath` was kept in `mirror/export.ts`.

### Numbers on the merged tree
Unit: core 393, plugin-api 17, server 608, web 1,000 — all green after `d6dda8c`. `verify` on a
fresh copy of the live graph: OK, 20,411 ops. Fresh import of the Logseq graph: 127 pages + journals,
18,628 blocks, 171 assets, 0 dangling; verify OK; 24 scheduled dates (was 4), 0 leftover `SCHEDULED:`.
Full Chromium e2e on `29323dc`'s tree: **439 passed, 0 failed, 2 skipped** (7.0 min). Worktrees
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
