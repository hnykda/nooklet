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
- F5 commit `dafa968`, F7 commit `8a1ccb8`.
- F6 / B-138 (formula sizes) `87a75b4`: `maxSize: 20` in `math.ts`. The suggested CSS
  (`inline-block; overflow:hidden`) NOT adopted — probe `tools/probes/inline-block-clip-baseline.mjs`
  shows an 11 px baseline lift in Chromium and WebKit. `\kern` stays uncapped by KaTeX (e2e checks
  it does not widen the page). `math.test.ts` with real KaTeX (failed before); e2e
  untrusted-content+rendering+render 11/11.
- F8 (cleanliness; commit "refactor(web): one POST path…"): `apiClient` calls `callOp` (no
  second `post`/`createApiClient`), one `undoBatch` in `refactor-api.ts` (History and References
  import it), FindReplaceView uses `describeError` (hint kept), headers rewritten. Tests
  `data/api-client.test.ts` (3 network cases failed before) and `views/FindReplaceView.test.tsx`
  (failed before); web unit 733/733; e2e views+references+replace+graph+history+link-unlinked
  49/50 — the failure is `views.spec.ts:461` "opening the palette while editing and closing it
  hands focus back to the editor", failing twice in a row; unrelated code path (palette focus),
  being checked against `da85cfb` next.
- F8 commit `3d73b13`. The palette-focus e2e failure (`views.spec.ts:461`) also fails at
  `da85cfb` (checked with `git switch --detach da85cfb`, 1/1 failed; 3 failures in a row in all):
  pre-existing, not caused here. No bug number left to log it under; reported to the coordinator
  and in the review doc.
- F9 (cleanliness; commit "refactor(web): page paths from one module…"): new
  `apps/web/src/routes/page-path.ts` (no imports) holds `pageNameToPath`/`pathToPageName`/
  `pageRoutePath`/`pageZoomRoutePath`/`historyRoutePath`; `navigateTarget.ts` keeps only
  `goToTarget`; `hosts.ts#pagePath` deleted; Sidebar, hosts, CommandLayer, tokens.tsx (3 hrefs),
  QueryFenceView and PageView build paths through it. A module with no imports so the renderer does
  not pull in `data/store.ts`. `editor/render/page-hrefs.test.tsx` (4/4 failed before with
  `%2F`); web unit 737/737; e2e navigation+pages+query+shelf+rendering+history+trash+refactor
  52/52.
- F9 commit `373c654`. F10 commit `b21352b`: the four stale comments (PageIcon CSP clause,
  BlockTree highlighter "DEFERRED" + block-ref gap, tokens.tsx block-ref gap, appearance.ts loader)
  rewritten after checking each claim against the code; the embed / `.vr-ref-new` / `list::
  number` gaps are still real and still listed. No CSP added (see review doc).
- B-139 (commit "fix(web): Alt+Enter on a ((block ref))…"): block case of `followLink` uses
  `resolveBlockPageName`. `e2e/tests/follow-link.spec.ts` failed on the old build (stayed on the
  source page), passes now; `hosts.test.ts` 9/9 (block case failed before); e2e
  follow-link+untrusted-content+navigation 12/12.
- B-139 commit `e2cd507`.
- Final verification at `e2cd507`: `pnpm -r test` core 332/332, plugin-api 17/17, server 521/521,
  web 739/739; typecheck clean; combined e2e over all 22 touched/affected specs 126/126 (the
  palette-focus test that failed three times earlier passed here: flaky under load, also failed at
  `da85cfb`).
- Review doc `docs/review/2026-09-13-m7-rv-web-security.md` and probes
  `tools/probes/javascript-href-sinks.mjs` / `katex-output-attributes.cjs` (both re-run; results in
  their headers) committed last.

## In flight

- Nothing. The brief is complete: all ten findings reproduced and fixed (F6's CSS half declined
  with a probe), B-139 found and fixed, review doc written.

## Next steps, in order

1. Coordinator: merge `docs/bugs-inbox/rv-web-security.md` (B-135..B-139) into `docs/BUGS.md`.
2. If `views.spec.ts:461` (palette focus) fails again, give it a bug number: it failed at
   `da85cfb` too.
3. Open follow-ups recorded in the review doc's "Not done": SPA CSP, `\kern` bound,
   `SearchView#errorText`.

## How to resume

`git log --oneline da85cfb..HEAD` shows what landed; each commit names its finding.
