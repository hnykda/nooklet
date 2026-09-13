# ref-label-flash — progress

Branch `m11/ref-label-flash` from `52e5d20`, worktree
`.claude/worktrees/wf_b8e786c1-020-2`. e2e port **6417**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11b/ref-label-flash/`
(`data/` = NOOKLET_DATA for any nooklet command; `graph/` = real-graph backup when made).

Task: B-500 — every refresh turns `((block refs))` back into the `((id))` placeholder until the
lookup answers. Bug entries go to `docs/bugs-inbox/ref-label-flash.md` (new numbers B-510..B-519),
never `docs/BUGS.md`.

## Plan

1. Reproduce with a MutationObserver text recorder (e2e, Chromium + WebKit).
2. Fix: resolved labels stay across refreshes (stale-while-revalidate cache); check the other
   things a refresh may flash (page names/icons, embeds, query fences, date chips, references
   panel, word count).
3. Measure row renders / resolver calls per refresh on a real-graph page, before and after.
4. Playwright test: across N refreshes no snapshot holds an unresolved `((` for a resolvable ref.

## Done

- Step 1, reproduced (`e2e/tests/ref-label-flash.spec.ts`, 3 tests, all FAIL on `52e5d20`; the
  webkit project's `testMatch` now includes this spec). MutationObserver on `.page-view`:
  - 5 pulls (API `block.update` of an unrelated block on the page): **25 of 30** DOM snapshots show
    every `((ref))` label as `((id))`; Chromium and WebKit identical (25/30).
  - typing ` typed` into another block: **4 of 13** snapshots; Chromium and WebKit identical.
  - rows and ref spans are NOT remounted in the outliner (0 new `.vr-row`, 0 new `.vr-block-ref`):
    the span stays, its content swaps to the placeholder and back.
  - "Flash Rich" page (icon, SCHEDULED + property, embed, query fence, references panel, word
    count), 5 pulls: outliner rows with refs and the query result with a ref flash `((id))` on
    every pull; title/icon, embed, date chip text, references panel text, word count keep their
    text. But per 5 pulls: 10 `.vr-query-hit` remounted (all hits, every pull), 5 `.reference-item`
    (every pull), 5 `.vr-date` chips and 5 `.vr-prop` rows in the outliner (every pull) — DOM
    rebuilt with identical content.
  - Found in passing: the references panel never resolves `((id))` at all (InlineContent passes no
    resolver) — not a flash; to log.
- Cause, from the evidence (all 4 labels go to placeholder together, no remount): `data/store.ts`
  calls `invalidateBlockRefs()` on every change event naming `block`, which empties the whole
  `block-ref-cache.ts` record, so every `lookupBlockText` returns `undefined` until its refetch.

- Step 3 "before" numbers (instrumented build of `52e5d20` + the B-500 test commit, real-graph
  copy `<scratch>/graph`, `tools/probes/refresh-render-count.mjs`, 5 API writes per page, Chromium,
  per refresh): see the table in "Measurements" below. Raw: `<scratch>/before.json`.
- Step 2a, B-500 cache fix: `data/block-ref-cache.ts` rewritten (per-id signals, generation-stamped
  stale-while-revalidate, batched `IN` reads, watcher-counted revalidation).
  `data/block-ref-cache.test.ts` 8/8 (8/8 fail against the old file); e2e `ref-label-flash.spec.ts`
  3/3 chromium, 3/3 webkit; web unit 1146/1146; typecheck clean.

- `158b893` B-500 fix committed. `5e57646` B-510 + B-511 committed.
- Step 3 measured before/after (table below); probe gained a Chromium main-thread pass and a
  `treeUpdateMs` counter; both patches regenerated (before → `3f070e9` sources, after → `5e57646`).
- Step 2b, B-510 + B-511: `data/same-json.ts` (`sameJson` memo equality, unit test 2) on
  `DateChips` chips, `BlockProperties` entries, `QueryFenceView` latest, `ReferencesPanel` data;
  `InlineContent` gets an optional `resolveBlockRef`, `ReferencesPanel` passes
  `block-ref-cache.ts#resolveBlockRef`. e2e spec now 4 tests (B-510 test and the mount assertion
  failed on `158b893`); 4/4 chromium, 4/4 webkit; related e2e (references ×3, query ×3, embeds,
  dates, block-properties, shelf ×2, render, rendering) 66/66; web unit 1148/1148.
  Checked and not flashing: page title + icon, embed text, word count, sidebar (0 remounts).

- Per-row re-runs cut: `editor/same-fields.ts` (+ unit test, 3) as `equals` on `BlockTree`'s
  per-row `row`/`block` memos — a 7-line hunk inside the row `<For>`, nothing in the tree effect
  (m11/remote-rewrite changes the effect). Web unit 1151/1151; e2e 156/156 across 16 editing-heavy
  specs. Measured (rows "after + row equality" below).

- `935d1fb` row-memo equality committed.
- Journals view checked on the real-graph copy (`tools/probes/refresh-journals-flash.mjs`, HEAD
  `935d1fb`): 256 rows on screen, 5 pulls writing a block in the first day (the owner's real
  `((ref))` block, shown as "travel/trip-planning"): no region or row but the written one ever showed a
  second text, the written row went straight between its two texts (never `((id))`), 0 rows / date
  chips / property rows / agenda items / sidebar entries created; 5 `.vr-block-ref` created = the
  written block's own label re-rendering with its text. Chromium and WebKit identical. Page probe
  in WebKit on HEAD: `Ref Heavy` and `2022-12-16` 0 flashed snapshots, 4 records per refresh.

- `d762804` journals probe committed. Spec test 5 added ("a label changes when its target's text
  does, and never passes through ((id))"); seeding made re-runnable on one server. Spec 5/5
  chromium, 5/5 webkit (run as separate invocations — one invocation with both projects shares a
  server). Against the old `block-ref-cache.ts` (with a `resolveBlockRef` shim): tests 1, 2, 4, 5
  fail, 3 (B-510) passes — as expected.

## Measurements (per refresh, averages of 5)

Real-graph copy (`<scratch>/graph`, backup of the owner's graph 2026-09-13 17:42), `nooklet serve`
on 6417, Chromium, `tools/probes/refresh-render-count.mjs`: 5 API `block.update`s of the last
visible block on the page. "before" = client source of `3f070e9` (pre-fix) +
`refresh-render-count.before.patch`; "after" = `5e57646` + `refresh-render-count.after.patch`.
`Ref Heavy` is a page the probe adds to the copy (150 rows, 50 `((refs))` to real blocks) — the
real graph has only 43 blocks with a block ref, at most 2 on a page. Raw JSON:
`<scratch>/before-full.json`, `<scratch>/after-full.json`.

| page (rows shown) | build | resolver calls | ref queries | DOM mutation records | elements created | snapshots with a resolved label back at `((id))` | main-thread task ms | layout ms |
|---|---|---|---|---|---|---|---|---|
| Ref Heavy (150; 50 refs) | before | 2,550 | 50 | 3,206 | 1,883 | 53 (max 50 labels at once) | 22.1 | 1.7 |
| | after | 0 | 1 | 4 | 3 | 0 | 6.6 | 0.1 |
| OmnivoreSync (57; 556 props) | before | 0 | 0 | 402 | 856 | 0 | 17.3 | 1.7 |
| | after | 0 | 0 | 4 | 4.6 | 0 | 11.2 | 0.2 |
| Megapage (201; big references panel) | before | 0 | 0 | 7 | 306 | 0 | 11.1 | 0.4 |
| | after | 0 | 1 | 5 | 3 | 0 | 9.5 | 0.1 |
| 2022-12-16 (90; 2 refs, 33 tasks) | before | 6 | 2 | 16 | 29.6 | 5 | 7.9 | 0.5 |
| | after | 0 | 1 | 4 | 8.6 | 0 | 5.2 | 0.2 |
| 2023-01-11 (252) | before | 0 | 0 | 4 | 3 | 0 | 8.2 | 0.1 |
| | after | 0 | 0 | 4 | 3 | 0 | 7.6 | 0.1 |

"resolver calls" is `lookupBlockText` calls after the first render (0 after: a label whose text
did not change never re-runs). "task ms" is DevTools' `TaskDuration` delta on a second pass with no
MutationObserver, fixed 1.5 s waits; it includes the sync round trip's own main-thread work, which
is the same before and after. `contentView` stays at 1 (only the edited row re-renders) and
`treeEffect` at 1 in both builds. Unchanged by these fixes: `rowBlockRead`, `dateChips`,
`propEntries` still run once per row per refresh, and the synchronous tree update
(`setLocalBlocks` to the end of Solid's flush) is 1.3 / 2.9 / 3.3 ms on 90 / 201 / 252 rows, before
and after alike — addressed by the next change, below.

After the row-memo equality (same probe, `<scratch>/after-rows.json`): `rowBlockRead`, `dateChips`,
`propEntries` 1 per refresh on every page (was one per row); synchronous tree update 0.7 / 1.5 /
1.1 / 2.2 ms on 90 / 201 / 150 / 252 rows (was 1.3 / 2.9 / 2.1 / 3.3); main-thread task ms 4.8 /
10.0 / 5.5 / 6.1 (was 5.2 / 9.5 / 6.6 / 7.6 — Megapage within noise); OmnivoreSync 11.3 (11.2).

## In flight

Nothing. Task complete; see "Not done" below.

## Final state (HEAD after the last commit)

- Web unit (`apps/web`): 1151/1151 on `935d1fb`; nothing in `apps/web/src` changed after it.
- Typecheck (`pnpm -r typecheck`): clean.
- e2e Chromium, full suite in 4 batches on `52ac1a6` (each batch its own server): 148 + 1 skipped;
  110 + 1 failed → rerun 111/111; 143; 137 + 1 skipped. The one failure was `pages.spec.ts:175`
  "the sidebar's Recent list shows the most recently edited pages first" (15 s wait for the page in
  the sidebar) — passed alone (`pages.spec.ts` 14/14) and on the batch rerun; the same batch on
  the `52e5d20` client failed a different test instead (`page-find.spec.ts:181`), and
  `docs/progress/qafix-render-sync.md` records the same sidebar test failing once then passing. The
  Sidebar and its data are untouched here. Treated as a pre-existing flake, not investigated.
- e2e WebKit project (storage + ref-label-flash): 7/7.
- `nooklet verify`: not run — no sync, op or schema code changed.

## Not done

- B-512 (logged, open): tasks view, search hits, property values (and very likely the journal
  agenda) still show `((id))`.
- When a query result or a reference really changes, its lists are still rebuilt whole (keyed by
  object). Only the no-change refresh is free now.
- The change bus still names tables, not block ids, so every block write re-reads every ref label
  on screen (one `IN` query, ~50 ids on the heaviest page measured). Narrowing it means widening
  `ChangeEvent` in the worker; not needed at these numbers.
- Not verified in the Tauri desktop app (WKWebView), where the owner saw it: Playwright's WebKit is
  not WKWebView. The fix is engine-independent logic (a cache no longer emptied), and WebKit and
  Chromium recorded identical before/after behaviour.

## How to resume

`git log --oneline 52e5d20..` shows what landed. Before each commit: biome check on the files,
`pnpm -r typecheck`, `pnpm --filter @nooklet/web test`. e2e:
`cd e2e && NOOKLET_E2E_PORT=6417 pnpm exec playwright test <specs> --project=chromium`.

Measuring: `<scratch>/serve.sh` serves the real-graph copy on 6417 (refuses if busy),
`<scratch>/stop.sh` stops it (only a process from this worktree), `<scratch>/measure.sh` runs the
probe with the `Ref Heavy` ids. Apply `tools/probes/refresh-render-count.<before|after>.patch`,
`pnpm --filter @nooklet/web build`, measure, then check the patched source files back out —
never commit the counters. The e2e global setup rebuilds `apps/web/dist`, so rebuild after any e2e
run before measuring.
