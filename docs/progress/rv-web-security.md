# rv-web-security: fix the M7 web security/cleanliness review findings (F1–F10)

Branch `m8/rv-web-security`, worktree `.claude/worktrees/wf_69b4f9a8-ee2-20`, started from
`da85cfb`. e2e port **6473** (always pass `--output <scratch>/pw-results`). Scratch:
`<scratchpad>/rv-web-security/` (also holds the reviewer's own probes and a real-graph copy in
`graph/`).

Brief: ten findings (F1 high, F2 medium, F3–F10 low) from an independent review of the web
client, each confirmed by a skeptic. For each: reproduce first (a failing test), fix the cause,
one commit per finding, high severity first. Bugs go to `docs/bugs-inbox/rv-web-security.md`
(B-135..B-139 only), never `docs/BUGS.md`. Review record:
`docs/review/2026-09-13-m7-rv-web-security.md`, committed last.

Bug numbers: F1 → B-135, F2 → B-136, F3 → B-137, F4+F5+F6 → B-138 (untrusted block text reaching
the render sinks unchecked), B-139 → found in passing: Alt+Enter on `((block ref))` does nothing
(`followLink` passes a block id to `resolvePageName`). F7–F10 are cleanliness, summarised in the
review doc only.

## Done

- Baseline (before any fix, `e2e-baseline.log` in scratch): the new specs
  `change-bus`/`load-errors`/`untrusted-content` fail 7 of 8 against `da85cfb`, each for the
  reason its finding names (History-first ordering in `change-bus` passed — kept as a guard).
  The full four-test `untrusted-content` spec is saved at `<scratch>/untrusted-content.full.spec.ts`;
  the committed file grows one test per finding.
- F1 / B-135 `ff140b1`: `db/client.ts` fan-out, store owns the sync-drain bump +
  `serverStampedFor`, `history.ts` stamps through it. `client.test.ts` 5/5; web unit 689/689; e2e
  change-bus+trash+history+diagnostics+query+pages+references+connectivity 46/46.
- F2 / B-136 `eb3face`: guarded resource reads. `load-errors.test.tsx` 3/3 (3/3 failed before);
  e2e load-errors+trash+history+query 21/21. Web unit: 691/692 — the one failure is the unchanged
  `data/page-title.test.ts` first test timing out at 5 s on a dynamic import under load average
  43; it passes 9/9 alone.
- F3 / B-137 `59f4da8`: `followLink` → `assetUrl`. `app/hosts.test.ts` 5/5 (4 failed before);
  e2e untrusted-content (F3 test) + assets 2/2. B-139 logged (open) in the same commit.
- F4 / B-138 (links) `6d1cb2e`: `safeHref` (http/https/mailto/tel/relative) in `asset-url.ts`,
  used by the rendered link (tokens.tsx, 2 lines) and `followLink`. Real-graph probe
  `tools/probes/link-schemes-in-graph.ts` shows those five are all the owner's 2,298 links use.
  Unit: `untrusted-content.test.tsx` + `hosts.test.ts` (new cases failed before); web unit
  717/717; e2e untrusted-content+rendering+render+assets 10/10.
- F7 (taken before F5, because F5 edits `highlight.ts` and its diff is unreadable while the file
  is "binary"; commit "chore: raw NUL bytes…"): the raw NUL in `highlight.ts` became the
  six-character escape, and the same defect was found and fixed in
  `packages/core/src/query.test.ts` and `packages/server/src/verify.ts`. Guard:
  `apps/web/src/source-text.test.ts` scans every tracked text file (it listed all 3 before the
  fix). Core 332/332, server 521/521, `nooklet verify` on the real-graph copy OK (20,411 ops).
  **Cause worth recording:** in this session the Write/Edit tool turned typed escape sequences
  (NUL, 0x01) into raw bytes twice. Write such escapes through `perl -pi -e` from Bash, and let
  the guard test catch any that slip.

- F5 / B-138 (fence classes): `highlight.ts#languageClass` (first word, `[\w+-]` only), 3 lines
  in tokens.tsx. `untrusted-content.test.tsx` 3 new cases (failed before); render unit 69/69; e2e
  untrusted-content+rendering+render 10/10.

## In flight

- nothing uncommitted.

## Next steps, in order

1. F6 (KaTeX maxSize + math.css containment; e2e math test from the full spec copy)
3. F8 (api-client consolidation, one undoBatch, describeError in FindReplaceView)
4. F9 (pageRoutePath everywhere)
5. F10 (stale comments)
6. B-139 if time: block-ref followLink (small, `hosts.ts`), with an e2e test
7. Review doc (copy the reviewer's probes that settled facts into `tools/probes/`), progress final.

## How to resume

`git log --oneline da85cfb..HEAD` shows what landed; each commit names its finding. Re-read this
file's "In flight" and check `git status` for uncommitted work in the files it names.
