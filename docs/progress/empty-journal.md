# B-595: an empty journal day's page is editable, as in Logseq

Branch: `worktree-agent-a78a5d6e8e3d75057` (reset to main `4b0a291` first; it had no commits).

## Done
- `apps/web/src/views/PageView.tsx`: a whole-day route (`/page/<date>`, any title format the
  parser accepts, no `?block=`) whose page does not exist renders the journal stream's own draft,
  `VirtualJournalDay`, under the day's title, with its agenda and references. It replaces
  "This page doesn't exist yet / Create". Typing (Enter or blur) creates the page, the journal
  template and the blocks in one batch, exactly as in the stream. Nothing is written by viewing.
- Once the draft has written the day it stays mounted and renders the day's tree itself (B-411's
  rule). The page branch's chrome (actions, properties, History) appears around it. `startedDay` is
  a day number, not a flag, and is cleared when the draft unmounts. Otherwise coming back to the
  day later would show a fresh draft for a day that already has a page, and typing into it would
  make a second page.
- **Bug found and fixed on the way:** the first version lost the caret right after Enter in
  Chromium. As a bare fragment inside `<Show>`, the header going from one node to several made
  Solid reconcile the sibling list and *move* the draft's DOM node. Moving a node blurs the focused
  editor inside it. Evidence came from a MutationObserver and focus timeline in the e2e test
  (`focusin cm-content` at 14 ms, `focusout` at 47 ms, `- page-view-draft` / `+ page-view-draft` at
  55 ms; no remount logged). The fix wraps the section in `<div class="page-view-body">`, so each
  part has its own insertion marker. The unit test below fails without the wrapper.
- Ordinary pages are unchanged. The decision is below.
- Tests:
  - `apps/web/src/views/PageView.test.tsx` (new, 4 tests). 3 fail on the pre-fix PageView, and
    the leak test fails without the `onCleanup` reset. The "not even moved" assertion fails
    without the wrapper.
  - `e2e/tests/empty-journal-page.spec.ts` (new, 2 tests). (1) A date URL: viewing it, focusing
    the draft and leaving creates no page on the server. Then type, Enter, keep typing: the caret
    stays in the editor, the server has both blocks, and a reload shows the real page. (2) In a
    fresh graph, today's heading opens the draft. Viewing creates no page (`page.list kind:all`).
    Type and Enter keep focus, the server has the blocks, and there is exactly one page for the day.
  - Updated for the new view: `journal-agenda.spec.ts` (day with no page),
    `pages.spec.ts` ("writing into a journal-titled page that does not exist makes a journal"),
    and `render-views.spec.ts` (B-200 and B-326 date pages now `.page-view-draft`).

## Verification (2026-10-03)
- `pnpm --filter @nooklet/web test`: 163 files, 1388 tests passed.
- `pnpm -r typecheck`: exit 0. `pnpm exec biome check . --diagnostic-level=error`: exit 0.
- e2e (port 6309): a-fresh-journal, empty-journal-page, journal-agenda, journal-day-start,
  journal-display-names, journal-draft-sync, journal-heading-link, journal-midnight,
  journal-stream-editing, journals, navigation, pages, ref-pages, render-views. 70 passed,
  3 failed. All 3 failures are in `ref-pages.spec.ts` (:123, :171, :280) and are **pre-existing**:
  the same 3 fail with main's `apps/web/src/views` restored (checked by checking those files out
  from `4b0a291` and re-running `ref-pages` alone, 3 failed / 4 passed). Logged below.
- Also run: page-identity, page-delete, page-rename, local-page-creation,
  desktop-page-creation-probe, parity. These passed apart from the two render-views tests,
  since updated and passing (9/9).

## What Logseq does (source, file-based 0.10.9)
`src/main/frontend/components/page.cljs` at tag `0.10.9`
(https://github.com/logseq/logseq/blob/0.10.9/src/main/frontend/components/page.cljs):
- The `page` component, around L436–442: when the route's page has no entity it **transacts one
  just by being viewed**: `(when-not (db/entity repo [:block/name page-name]) (let [m
  (block/page-name->map path-page-name true)] (db/transact! repo [m])))`. This applies to journal
  and ordinary names alike.
- `page-blocks-cp`, around L167–184: `(if (empty? page-blocks) (dummy-block page-name) …)`.
  `dummy-block`, around L113–149, is a bullet with "Click here to edit...". A click or Enter calls
  `editor-handler/insert-first-page-block-if-not-exists!`, which publishes `[:page/create …]` (in
  `handler/editor.cljs` around L649–655). So in Logseq **both** a missing journal day and a
  missing ordinary page open as an editable empty page.
- Logseq has no "doesn't exist" view at all. Its cost is that a page entity exists in the DB as
  soon as someone looks. Nooklet deliberately does not copy that half: per ADR 024 and B-579, a
  page made by looking is junk with no cleanup path. The draft writes only on typing.

## Decision: ordinary pages keep "doesn't exist yet / Create" (for now)
The owner's decision covered journal days. Applying it to ordinary names was weighed and not done
here:
1. **The gap is small after ADR 024.** Any referenced ordinary name already *exists* with zero
   blocks and already opens as an editable page with a "Start typing…" row (ADR 024 §8, B-410).
   That is Logseq's behaviour. The missing view is left only for names nothing references: a typed
   URL, a deleted page, or a link this device has not synced yet.
2. **The missing view is a signal in those cases.** A deleted page shows as missing
   (`page-delete.spec.ts`). The two-device race and local-only mode show "doesn't exist yet" while
   the server's page is unknown (`ref-pages.spec.ts`, ADR 024 §7, B-577). An editable draft there
   would invite a second `page.create` that the server then refuses (`page-key-collision`), with
   recovery via `refused-page.ts`. Today an explicit Create click is what takes that risk.
3. **The draft component is journal-specific** (ISO name, `journalDay`, journal template, the
   stream's B-410/B-411 handling). Reusing it for ordinary names means generalising it into a
   page draft. That is doable, but it is a feature with its own tests, not part of B-595.

If the owner wants full Logseq parity, the change is: generalise `VirtualJournalDay` to take
`{name, journalDay, template?}`, use it in PageView's missing branch for every name, and decide
what a deleted page's URL should show. Logged as a new entry below.

## Still unverified
- WebKit / the Mac app's WKWebView: the e2e ran in Chromium only. The focus-loss-on-move cause is
  engine-generic DOM behaviour, but it was not run in WebKit.
- A fresh client's first sync (B-410) on the page route: the draft shows only once the page
  lookup has settled to `null`. I relied on the worker answering only after the first sync (as
  for the stream) and did not re-measure it on the page route.

## BUGS.md updates to fold in

**B-595**: move to Fixed. Replace Status/Test with:
**Status:** fixed (2026-10-03) · **Severity:** low · **Found:** 2026-10-03, while doing B-560 ·
**Test:** `apps/web/src/views/PageView.test.tsx` (4 tests; 3 failed before the fix);
`e2e/tests/empty-journal-page.spec.ts` (2 tests: date URL, and today's heading in a fresh graph,
both checking that viewing creates no page and typing creates the blocks on the server).
Append:
**Fixed 2026-10-03**: `PageView` shows a whole-day date route with no page as the journal stream's
draft (`VirtualJournalDay`). Typing creates the day (page, template, blocks) in one batch, and
viewing writes nothing. After the first write the draft stays mounted (B-411). Logseq does the same
(`components/page.cljs` 0.10.9, `dummy-block`), although Logseq also creates the page entity on
view, which nooklet does not. Found along the way and fixed in the same change: as a bare fragment,
the page header growing after the first write *moved* the draft's DOM node and blurred the editor
(caret lost right after Enter). The section is now wrapped in one element. Ordinary missing pages
keep "doesn't exist yet / Create". See the new entry below and `docs/progress/empty-journal.md`.

**New (open) · An ordinary page nothing references still opens as "doesn't exist yet / Create";
Logseq opens every missing page as an editable empty page**
**Status:** open, owner's call · **Severity:** low · **Found:** 2026-10-03, while doing B-595 ·
**Test:** none
Logseq 0.10.9 (`components/page.cljs`, `page` and `dummy-block`) gives any missing page a
"Click here to edit..." row. B-595 did this for journal days only. For ordinary names the gap is
small since ADR 024: a referenced name already exists and opens editable. The missing view is
also the signal for a deleted page, an unsynced name, and the two-device race (ADR 024 §7). Doing
it means generalising `VirtualJournalDay` into a page draft that writes nothing until typed.
Reasoning is in `docs/progress/empty-journal.md`.

**New (open) · Three `ref-pages.spec.ts` tests fail on main**
**Status:** open · **Severity:** medium (test or real regression, not yet known) · **Found:**
2026-10-03, while verifying B-595 · **Test:** the tests themselves
On `4b0a291` (main's `apps/web/src/views`, run alone on port 6309) these fail: `:123` "editing an
existing link one character at a time leaves no junk pages" (`Received: ["edit me … [[Junk Probe
… F]]"]`: the server never got past the first typed character within 10 s), `:171` "deleting the
only link removes the empty page it made…" and `:280` "…survives another device removing the link
(B-445)" (both `expect.poll … Expected: false, Received: true`). Not caused by B-595 (identical
with and without it). Not investigated.
