# Progress — pre-publication leak audit

Started 2026-10-04 by the leak-audit agent, branch `worktree-agent-a5608154727b50cb1` (based on
`70b60be`). Brief: before ~770 local commits are pushed to the public `hnykda/nooklet`, find
secrets, the owner's real notes, and personal infrastructure in (a) the working tree, (b) the
unpushed range `origin/main..main`, (c) the already-public `origin/main`; scrub what this agent owns;
write the history plan for the owner; add guards.

This file deliberately does **not** repeat the leaked strings. The full list (with replacements)
lives only outside the repo, in `~/.config/nooklet/leak-denylist.txt` (also a ready
`git filter-repo --replace-text` file) and `~/.config/nooklet/leak-scrub.py` (the same mapping as an
applier/checker). Both were written on the owner's Mac by this agent; they are the private half of
the guard.

## State

- [x] Verified: `git remote -v` = `hnykda/nooklet`, `70b60be` is a commit, branch fast-forwarded to it.
- [x] Scan working tree, unpushed range (769 commits, f7c9644..70b60be), public `origin/main` (59 commits).
- [x] Scrub internal docs, probes, CLAUDE.md, comments in 10 source files.
- [x] Blank the LAN address in `tools/probes/pairing-link-ui/pairing-confirm.png`.
- [x] Guards: `.gitleaks.toml`, `tools/leak-check.mjs`, `tools/git-hooks/pre-commit`, CLAUDE.md
      "Public repo hygiene"; B-652 logged.
- [x] Rehearsed history option (b) on a scratch clone: rewrite + full unit suite + typecheck green.
- [ ] Test strings in `apps/`, `packages/`, `e2e/` (feature agents' files) — list below.
- [ ] `deploy/k8s/` (infra agent) — see "For the infra agent".
- [ ] Owner: pick a history option; revoke the leaked token (below).

## Method (re-runnable)

- Shape regexes over `git grep` of the tree, every commit in each range (`git grep <re> <revs…>` in
  batches of 60), and `git log` messages: tokens (`nk_`/`nkroot_`/`nkb_` + hex), private keys, age
  keys, cloud keys, `/Users/…` paths, `*.ts.net`, `100.64/10`, `192.168/16`, mail addresses.
  gitleaks/trufflehog are not installed; `tools/leak-check.mjs` implements the same rules.
- **Real-note detection against the graph itself** (read-only): collect every page file name,
  `[[link]]`, `#tag`, `title::`/`alias::` from the real graph (448 terms ≥ 4 chars) and `git grep -F`
  them; then a second pass that takes every quoted/backticked/`[[…]]` span ≥ 10 chars in the repo and
  checks whether it occurs verbatim in the graph's text. The second pass found block text the
  first could not (task lines, headings, person-property values). Everything flagged was read and
  classified by hand; generic words that merely exist in the graph (journal, call, idea…) are not
  findings.
- All PNGs in the tree were viewed (7 probe screenshots, iOS splash/icons).

## Findings

Counts are distinct items, not occurrences. "Tree" = current working tree before scrubbing.

### Secret — 1

- **A device token** (`nk_` + 48 hex, `write` + `can_sync`) printed by a scratch server during the
  B-25 Host-forgery repro, quoted in `docs/BUGS.md` (B-25) and
  `docs/research/12-multi-user-and-pairing.md` §1.6(a). **Public since 2026-09-11** (`955e241`, in
  `origin/main`). It was minted on a throwaway data dir on port 6198, so it is very likely dead, but
  a token in public history is treated as compromised regardless — see "Rotate" below.
- Not found anywhere in tree or history: private keys (one `BEGIN OPENSSH PRIVATE KEY----- test`
  fixture in `importer/logseq.test.ts` is a fake by design), `.env` files, SOPS plaintext, age keys,
  cloud/GitHub/Anthropic/Slack keys, `nkroot_`/`nkb_` values. `deploy/k8s/.../secret.yaml` is a
  template (`required .Values.rootToken`); CI workflows reference `secrets.*` only.

### Personal content (the owner's real notes) — ~45 items, ~60 files in the tree

Worst first:
- **Page names revealing drug use** (3 distinct: a substance page, a "trip" namespace, a
  "drugs/…" namespace) in BUGS.md, progress notes and **test fixtures**; one substance name is also
  in a **code comment and a test in public `origin/main`** (`ops/page-backlinks.ts`,
  `ops/ops.http.test.ts`).
- **Relationship / therapy content**: a Czech heading about expectations in a relationship and a
  breadcrumb about fear for one's identity (quoted with its sibling headings), a couples-coaching
  page, a relationship-review page, a partner's person page with pages about being scared/sane
  and a Czech sentence about what she would like (BUGS B-254, B-257, refs counts, probes, tests).
- **Mushroom-growing namespace** (the B-441 / ADR 024 example) — in ADR, BUGS, tests, e2e.
- **People**: ~8 real people by full or first name (person pages, `participants::`/`people::`
  values, a child's/partner's name in a search hit "plan holidays with …").
- **A 20-row table of real Czech/English tasks** with dates (`docs/progress/repair-agenda.md`),
  incl. a family nickname, a drug errand, a named contact; two of those task texts also live in
  `core`/`server` tests.
- Employer name, a job-decision page, a home-location search ("she likes <district>"), affiliations
  (two rationality-community orgs), a "Worries" page, an article title from a reading list.
- Harmless and kept: generic page names that happen to be in the graph (`Balení`, `Taxes`/`daně`,
  `zahrada`, `journal`, `call`), a TTRPG namespace with a fictional character, a game-reference page
  title, public paper/article titles, the OmnivoreSync plugin name, synthetic Czech test names
  (`Šimon Dvořák`, `Čapek`, `Aleš`), the Czech pangram.
- Screenshots: all show seeded data (`SIM LOCAL NOTE 4821`, `something`) — no real notes.

### Personal infrastructure — 9 kinds

- The real graph's absolute path (user name + folder layout) — ~20 files, **public** in
  `origin/main` (rust-core proposal, grammar spec, two `.manual.ts` scripts, embeddings research).
- Agent worktree paths of the old repo name under the owner's home — ~35 progress files.
- The **tailnet name** (`<tailnet>.ts.net`) — `docs/progress/real-device-test.md` and 3 `deploy/k8s` files.
- The home server's **host name** and its storage/backup internals (backup tool, schedule,
  node memory, storage class, PVC sizes), the **infra repo's name** and its internal conventions —
  progress files, BUGS, `deploy/k8s`.
- Two real LAN addresses, `.81` (**public**: BUGS B-25, research 12, `http/app.ts` comment) and
  `.82` (tests, probes, real-device-test, and the pairing screenshot).
- In-cluster registry host and Woodpecker secret names — `deploy/k8s` only (low).
- The commit author mail address on all 1,538 commits (already public on the 59 pushed ones and on
  the owner's GitHub profile) — owner's call; harmless unless they want a `noreply` address.
- Harmless and kept: the owner's name in LICENSE, the GitHub handle in URLs/brew tap, documented
  example addresses (`192.168.1.5`, `100.101.102.103`, `example.ts.net`), `~/.nooklet`.

### Where it is

| | working tree (before) | unpushed range | public `origin/main` |
|---|---|---|---|
| token | 2 files | every commit since 955e241 | **yes** (2 files) |
| real-graph path | ~20 files | yes | **yes** (5 files) |
| LAN IP | ~15 files | yes | **yes** (`.81`, 3 files) |
| drug-related page name | 6 files | yes | **yes** (1 comment, 1 test) |
| people, relationships, tasks, other note content | ~55 files | yes (plus the deleted `docs/bugs-inbox/*.md`, 43 files that exist only in history) | no |
| tailnet, host name, infra repo | ~12 files | yes (from ~95 commits on) | no |
| commit messages | — | ~25 messages name people/pages | no |

## What was scrubbed (this branch)

Every file under `docs/` (except `docs/guide/`, the docs agent's), `tools/probes/`, `CLAUDE.md`,
plus comment-only hits in 10 source files (`referenceNesting.ts`, `reference-trees.ts`,
`PageTitleField.tsx`, `keptEdits.ts`, `ReferenceItem.tsx`, `block-to-page.ts`, `dry-run.ts`,
`trash-restore.ts`, `page-backlinks.ts`, `http/app.ts`). Replacements keep the technical shape —
a person stays an `@person`, a Czech heading keeps its diacritics, a namespace keeps its depth and
sort position, an IP stays a valid IP, multi-word names wrapped across lines are matched across the
wrap. Bug evidence (counts, timings, block ids, commit hashes) is unchanged. Probes that select real
pages by name now name the stand-ins, so re-running them against the real graph needs the real name
passed in (they already take `PAGES=`/argv for this).

## Still in other agents' files (run the scrubber, it is verified)

`python3 ~/.config/nooklet/leak-scrub.py apply <files>` makes exactly the substitutions the history
rehearsal made, and with them **all unit tests pass and typecheck is clean** (see below). Files:

- feature agents: `apps/web/src/data/{connect-graph,page-title}.test.ts`,
  `apps/web/src/views/{keptEdits.test.ts,PairingLinkPrompt.test.tsx}`,
  `e2e/tests/{page-title-fit,query-task-tag,ref-pages,references-cap}.spec.ts`,
  `packages/core/src/{journal,outline-org-dates,outline,query}.test.ts`,
  `packages/server/src/{auth/pairing-link,cli-first-run,serve-banner,ref-pages,ref-pages-migration,repair-org-dates,importer/logseq,mcp/server}.test.ts`,
  `packages/server/src/ops/{batch-undo-alias.http,block-to-page-name,ops.http,trash-restore-alias.http}.test.ts`.
- Two manual scripts default to the real graph's absolute path in **code**
  (`importer/verify-real-graph.manual.ts:22`, `embeddings/manual-verify-real-ollama.ts:33`): make the
  path a required argument/env var instead of a default (the scrubber's `~/notes-graph` would not
  expand in Node).

## History — options for the owner

Facts that shape the choice (checked 2026-10-04 with `gh api repos/hnykda/nooklet`): public, **0
forks, 0 stars**, pushed once (2026-09-11). Local `main` is 769 commits on top of public `f7c9644`.

**(a) Squash the unpushed range into fresh commits before the first push.**
Scrub the tip (this branch + the scrubber over the files above), then
`git reset --soft origin/main && git commit` (or a handful of thematic commits).
+ Simplest; nothing from the 769 commits survives; no tool needed.
− Loses all history: `git blame`, bisect and the ~hundreds of commit hashes BUGS.md/progress files
  cite as "Fixed in `abc1234`" all go dead. For a repo whose method is "every claim is re-runnable",
  that is a real cost.

**(b) `git filter-repo --replace-text` (+ `--replace-message`) over the unpushed range only.**
Ready to run, rehearsed:

```
# on a fresh clone of local main, never in the working checkout
git filter-repo --replace-text ~/.config/nooklet/leak-denylist.txt \
                --replace-message ~/.config/nooklet/leak-denylist.txt \
                --refs origin/main..main
node tools/leak-check.mjs --range origin/main..main     # must print "clean"
pnpm install && pnpm -r test && pnpm -r typecheck
```

Rehearsal on a scratch clone (2026-10-04, 769 commits, ~12 s): public `f7c9644` stays an ancestor
(so the later push is a fast-forward, **no force-push**); `leak-check --range` over the rewritten
range: clean; commit messages: clean; at the rewritten tip `pnpm -r test`: core 473, plugin-api 17,
server 783, web 1531 — all passed; `pnpm -r typecheck` clean. (A first rehearsal failed 3 tests —
a sort order, a regex-escaped IP, a lowercase alias — which is why the mapping now handles those.)
+ Keeps every commit, blame and bisect. − Commit hashes change, so hashes cited inside BUGS.md and
progress files point at the old commits; filter-repo leaves `.git/filter-repo/commit-map`, and a
second `--replace-text` pass built from it (old short hash → new short hash) fixes those
references. − Files untouched since `f7c9644` keep their public content (the token in research 12,
the graph path in the rust-core proposal…): they are fixed by this branch's commit, but remain in
the public commits. − Every other branch/worktree based on the old `main` must be rebased onto the
rewritten one (all agents should be merged or stopped first).

**(c) Leave as is.** Not acceptable for the unpushed range: it would publish relationship, drug and
family content and the home network layout.

**Already public in `origin/main`** (exposed since 2026-09-11): the token, the real graph's path
(user name, folder names), one LAN address, and one drug-related page name in a code comment and a
test. Only the token is a security matter, and revoking it neutralises it whether or not history is
rewritten. The rest is mildly personal. Because there are no forks or stars and only one push, a
rewrite of the 59 public commits is unusually cheap now: run (b) with `--refs main` (whole history)
and push once with `--force-with-lease`. GitHub may still serve the old commits by direct SHA URL
until GC; GitHub Support can purge cached views if that matters.

**Recommendation:** (b) over the **whole** history (`--refs main`), one force-push, done before the
first push of the 769 commits and after the in-flight agents' branches are merged; then the
commit-map pass for cited hashes. If the owner prefers never to force-push, (b) over the range only
— a fast-forward push — leaves just the four low-sensitivity public items above.

## Rotate

The leaked token must be treated as live until shown otherwise. Tokens are stored as
`sha256(token)`; its hash is `e24091630e2e5dab51d421a9551a57a82c1803f0c09c07e8a1e464eef0346620`.
For each data dir the owner has (`~/.nooklet`, any test dir, the server's PVC):
`sqlite3 <dir>/<graph>/graph.sqlite "SELECT id,label,created_at,revoked_at FROM token WHERE token_hash='e2409163…'"`
(the full hash above), and `nooklet token revoke <id>` if a row comes back. Expected: no row (it
came from a deleted scratch dir). No other credential was found in any range.

## Guards

- `.gitleaks.toml` — gitleaks default rules + nooklet shapes (token, home path, tailnet host,
  Tailscale IP, LAN IP, personal mail, age key) with allowlists for the documented placeholders.
  Contains no real strings.
- `tools/leak-check.mjs` — same shape rules without needing gitleaks; runs gitleaks too when
  installed; adds the private denylist when `~/.config/nooklet/leak-denylist.txt` (or
  `$NOOKLET_LEAK_DENYLIST`) exists, never echoing a denylisted string. Modes `--staged`, `--tree`,
  `--range A..B` (added lines only). `leak-check: allow` on a line exempts a deliberate example.
  Checked: `--range 955e241~1..955e241` flags the token and LAN IP; `--staged` on this branch: clean.
- `tools/git-hooks/pre-commit` — enable with `git config core.hooksPath tools/git-hooks`.
- CLAUDE.md "Public repo hygiene".
- Current `--tree` result on this branch: remaining hits are exactly the feature-agent test files
  and `deploy/k8s` listed above.

## For the infra agent

CI step (no secrets needed; the private denylist is local-only, CI runs the shape rules):

```
- name: leak check
  run: node tools/leak-check.mjs --range "${{ github.event.before || 'origin/main' }}..${{ github.sha }}"
```

(on PRs: `--range origin/${{ github.base_ref }}..HEAD` with `fetch-depth: 0`; or simply
`node tools/leak-check.mjs --tree`, which is fast — ~1,500 files.) Optionally also
`gitleaks/gitleaks-action` with `GITLEAKS_CONFIG=.gitleaks.toml`.

Audit of `deploy/` and `.github/` (no secrets found):
- `deploy/k8s/charts/nooklet/values.yaml`, `values/nooklet.yaml.gotmpl`, `helmfile-snippet.yaml`:
  the real tailnet host name — use `nooklet.<tailnet>.ts.net` and set the real one only in the
  infra repo.
- `deploy/k8s/README.md`, `helmfile-snippet.yaml`, `woodpecker-nooklet.yaml`, `values/*.gotmpl`,
  `charts/nooklet/templates/{pvc,backup-cronjob}.yaml`, `values.yaml`: the home server's host name,
  the infra repo's name, its internal paths/notes (an incident note, another app's chart, a
  CLAUDE.md rule), the backup tool and its 02:00 schedule, the storage class name. Keep the
  mechanism, drop the proper nouns ("the cluster", "your infra repo", "your nightly backup").
- `woodpecker-nooklet.yaml`: two secret names that embed the server's host name, and the in-cluster
  registry `registry.container-registry:5000` — not secrets, but they map the private setup; rename
  to generic (`kubeconfig`, `REGISTRY`) or move this file to the infra repo.
- `deploy/k8s/charts/nooklet/templates/secret.yaml`: fine (template only).
- `.github/workflows/release.yml`: Apple signing secrets referenced via `secrets.*` only — fine.
- The scrubber (`~/.config/nooklet/leak-scrub.py apply deploy/k8s/**`) does the host/tailnet/repo
  renames mechanically if you want a starting point.

## How to resume

1. `node tools/leak-check.mjs --tree` — anything left is in the "Still in other agents' files"
   list or `deploy/`.
2. Once feature agents are merged: `python3 ~/.config/nooklet/leak-scrub.py apply` over that list,
   `pnpm -r test`, commit.
3. Owner decision on history; if (b): run the block above on a fresh clone, verify, push.
4. To extend the denylist: edit `RULES` in `~/.config/nooklet/leak-scrub.py`, then
   `python3 ~/.config/nooklet/leak-scrub.py replace-text ~/.config/nooklet/leak-denylist.txt`.
