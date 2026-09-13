# Bug inbox — m9/render-views

Entries in `docs/BUGS.md`'s format, folded in by the coordinator. New numbers B-320..B-329 only.

### B-224 (existing)
**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("a multi-line block renders each
line on its own line"), `apps/web/src/editor/render/tokens.test.tsx` ("a multi-line paragraph keeps
a <br> at each newline…", "quote -> <blockquote class=vr-quote>, one <br> between its lines")

Cause (read, then confirmed by a failing unit test and a failing e2e): `render/tokens.tsx#BlockContentView`
rendered a paragraph's and a quote's `lines` back to back with no `<br>` between them. The `br`
tokens exist only in `tokenizeContent`'s flat stream (used by `InlineContent`), never in
`classifyBlockContent`'s per-line arrays, which is what every outliner row, query hit, embed and
shelf card renders. It had been that way since the renderer was written (`b957731`); the existing
unit test `quote -> <blockquote class=vr-quote>` asserted the run-together text
`"line oneline two"`, so the defect was codified rather than caught.

**Fixed 2026-09-13.** `tokens.tsx#Lines` renders each line's tokens with a
`<br data-from data-to>` between consecutive lines, the offsets being that newline's own position in
`ctx.source` (read from the source rather than the neighbouring tokens, since an empty line has no
tokens). Heading trailing lines were already one `<p>` each and are unchanged. The e2e seeds the
entry's own two blocks through `page.create` markdown, checks `page.read` stores the `\n`, then
asserts one `<br>` per row and that the second line's first glyph sits below the first line's; it
failed on `cf08d19`'s `tokens.tsx` (`br` count 0) and passes with the fix. The unit tests failed
before (no `<br>`) and pin the offsets `27`/`39`/`40` for `Poznámka: **žluťoučký kůň**\nsecond
line\n\nfourth`. Real graph (backup copy, production build, `tools/probes/render-views-real-graph.mjs`):
on `2023-02-17` (26 rows, 19 multi-line) and `TTRPG/VTM-alpha` (88 rows, 10 multi-line) every
paragraph row's `<br>` count equals its stored text's newline count; no console errors beyond one
image asset the sqlite copy does not carry.

---

### B-211 (existing)
**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("revealing a block lands on its
row, not on a query result above it"), `apps/web/src/editor/render/render-seams.test.tsx` ("lists
hits grouped by page with a count…")

Reproduced in a browser before fixing (Chromium, production build, `cf08d19`'s
`QueryFenceView.tsx`): a page whose first block is a ```` ```query TODO tag:rvreveal ```` fence
and whose third is the matching task. Shelving the page, switching the card to its outline and
clicking the task's entry put `shelf-reveal-target` on the `li.vr-query-hit` and never on the
task's `.vr-row`; `document.querySelectorAll('[data-block-id=<id>]')` returned
`["vr-query-hit", "vr-row"]`, in that order.

**Fixed 2026-09-13.** `QueryFenceView.tsx#HitView` marks a result `data-query-hit-id`, the way
embedded rows already use `data-embed-block-id`, so `[data-block-id]` only ever names outliner
rows. The e2e asserts that invariant for the task's id and then runs the real shelf-outline reveal;
both parts failed on the old file (the invariant with the two-element list above, the reveal with
the row's class never gaining `shelf-reveal-target`) and pass with the fix. The component test now
also asserts no `[data-block-id]` inside a rendered query. Moving hits off the attribute changed
what `PluginFence` finds for a fence inside a result — handled with B-320.

---

### B-320 · A plugin-drawn fence inside an embedded block is handed the host block, not its own
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, reading `PluginFence.tsx`
while fixing B-211 · **Test:** `apps/web/src/editor/render/PluginFence.test.tsx` ("a fence inside
an embedded row / a query result is handed that block, not the host row's")

Not reproduced in a browser — found by reading. `render/PluginFence.tsx#fenceContext` finds the
fence's block as `el.closest("[data-block-id]")`. An embedded row (`EmbedView.tsx`) deliberately
carries `data-embed-block-id` instead, so a ```` ```mermaid ```` fence inside an `{{embed}}`
walks past its own row to the outliner row that holds the embed, and the renderer's
`RenderInfo.block`/`page` describe the host block and page. The B-211 fix moves query hits off
`data-block-id` too, which would give fences inside query results the same wrong answer (today they
get the right one, by the very attribute that causes B-211).

**Fixed 2026-09-13.** `fenceContext` looks for the nearest
`[data-query-hit-id], [data-embed-block-id], [data-block-id]` and reads whichever of the three the
match carries. The component test renders a fence inside an `li` carrying each inner attribute,
inside a `[data-block-id]` host: the embed case failed before (renderer got `bhost000000001`);
both pass. Not checked in a browser with a real mermaid plugin inside an embed —
`e2e/tests/plugins.spec.ts` (outliner rows only) still passes.

---

### B-321 · A journal agenda item carries `data-block-id`, so reveal and the agent flash can land on it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, `grep data-block-id` while
fixing B-211 · **Test:** `apps/web/src/views/JournalAgenda.test.tsx` ("a row click navigates to
the task, a heading click to its page")

Same trap as B-211. `views/JournalAgenda.tsx#EntryRow` puts `data-block-id="<task id>"` on each
`li.journal-agenda-item`. On the journal stream (`JournalStreamView.tsx`) Today's agenda is
rendered after Today's outline and before every older day's, so a task written on an older day and
scheduled for today appears in document order before its real row: `shell/Shelf.tsx#revealOnPage`
and `live/RemoteFlashOverlay.tsx#findBlockRow` (`document.querySelector('[data-block-id=…]')`)
pick the agenda entry. Nothing reads the attribute on the agenda item.

**Fixed 2026-09-13.** The item is marked `data-agenda-block-id`. The component test asserts no
`[data-block-id]` in the rendered agenda (failed before) and the new attribute's value. Believed
rather than browser-verified for the stream ordering itself: no e2e seeds a task on an older journal
day scheduled for today (journal-day offsets are shared across specs), and the agent flash has no
browser-side trigger short of a plugin; `e2e/tests/journal-agenda.spec.ts` still passes (6/6).

---

### B-225 (existing)
**Status:** fixed · **Test:** `e2e/tests/render-views-phone.spec.ts` ("a phone's title row has no
invisible controls; History and Add icon are in the … menu"), `e2e/tests/render-views.spec.ts` ("on
a desktop the title row keeps History and the icon slot behind hover; the menu has both")

Measured before fixing (iPhone 13 descriptor, production build, `cf08d19`): in a 366 px title row
the invisible empty icon slot took 39 px and the invisible History link 55 px, leaving the title
input 164 px; forcing both visible showed the name clipped to "RV Phone Prob".

**Fixed 2026-09-13.** Revealing both on a coarse pointer (the `all-pages.css` recipe) would have
made them reachable but kept the title at 164 px, so instead: under `@media (pointer: coarse)`
`views/page-actions.css` takes `.page-history-link` and `.page-icon-button-empty` out of the row
(`display: none`; a page that has an icon keeps it, it was never hidden), and the "…" page actions
menu gains "Page history" (a link to `/history/<name>`) and, while the page has no icon, "Add icon",
which opens the row's own editor through `views/page-icon-request.ts` (a page-id-keyed signal the
editor consumes). The menu items are there on a desktop too; the desktop row is unchanged (hover
reveal, checked by the desktop e2e). One hookup line in `PageView.tsx` passes `pageId` and `icon` to
`PageActions`. The phone e2e taps through both menu items and checks the title now takes over 60% of
the row; with the old `page-actions.css` it failed at "History link hidden" (received: visible —
an opacity-0 element is a live tap target). Ran under the descriptor's own engine, as
`phone.spec.ts` does; not tried on a physical iPhone, where focusing the icon input from a menu tap
depends on WebKit's user-gesture rule.

---

### B-200 (existing)
**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("a page that does not exist yet
shows what links to it and what is tagged with it", "a journal day nobody has written shows the
links to it, whatever date format the URL uses")

**Fixed 2026-09-13.** `PageView.tsx`'s missing-page branch mounts `ReferencesPanel` under the
"doesn't exist yet" message (and the agenda, for a date), so a referenced-but-uncreated page lists
its tagged pages and linked references the way Logseq does — the product question the entry left
open was settled by the brief ("that is how Logseq behaves"). Two details: the target is
`canonicalRefName(name)`, because references to a day are indexed under its ISO name and the
server's missing-page branch matches the raw title (B-322 — with the raw name the date test failed,
"received []"); and the panel gets `unlinked={false}`, a new `ReferencesPanel` prop, because its
"Link all" runs `mentions.link`, whose `requirePage` would only answer 404 for a page that does not
exist. Once Create is pressed the ordinary view's panel, unlinked half included, takes over (checked
in the same e2e). The first test cannot pass on `cf08d19` — nothing under the missing view rendered
a panel. Real graph (backup copy, `tools/probes/render-views-real-graph.mjs`): `/page/book`, which
the owner never created, now shows "Pages tagged book" 1 and "Linked references" 9 with 9 rows —
exactly `page.backlinks {target: "book"}`'s `tagged_total` 1 and `linked_total` 9 — and no unlinked
section.

---

### B-322 · `page.backlinks` for a not-yet-created journal day named by a non-ISO title finds no linked references
**Status:** open · **Severity:** low · **Found:** 2026-09-13, reading `ops/page-backlinks.ts`
while fixing B-200 · **Test:** none

Found by reading, then reproduced through the web client: with the B-200 panel asking under the
raw route name, `/page/<Mmm do, yyyy>` for an uncreated day linked as `[[<iso>]]` listed no linked
references (the second B-200 e2e, run against that variant, "received []"). References are indexed under
`normalizePageName(canonicalRefName(name))` (`apply-ops.ts#normalizeKey`, ADR 018), so
`[[Sep 20th, 2026]]` is stored under `2026-09-20`. When the target has no page row,
`page-backlinks.ts` matches linked references (and excludes linked blocks from unlinked mentions)
with `normalizePageName(input.target)` — the raw title — while the tagged-pages lookup a few lines
below already uses `refKeyOf`. An agent asking for `target: "Sep 20th, 2026"` before that day's page
exists therefore gets `linked: []` even though blocks link to it; `target: "2026-09-20"` works. The
web client's missing-page view (B-200) sidesteps it by asking with `canonicalRefName`. Likely fix:
`const key = refKeyOf(input.target)` in that branch, with an http test. Not done here: a server op,
outside this branch's rendering scope.

---

### B-323 · `references.spec.ts` "shows a count and collapses" once sat on the page view's "Loading…"
**Status:** open (seen once) · **Severity:** low · **Found:** 2026-09-13, e2e run on
`m9/render-views` · **Test:** —

In one combined run (render-views, pages, references, references-cap, references-filters,
tagged-pages, journal-agenda, journals, page-rename, navigation, link-unlinked — 51 of 52 passed) the
test's `/page/Refs%20Target` showed only `p.page-view-loading` "Loading…" for the whole 10 s
expectation: the ARIA snapshot had the top bar, "Loading…" and Help, no title and no outline. The
spec alone passed straight after (4/4), and the same combined set passed 52/52 on the next run. The
machine was shared by about a dozen agents, so load is the first suspect; recorded because
`page.loading && page() === undefined` holding for 10 s is also what a page-by-name resource that
never settles would look like. Not investigated; the failed run's trace was overwritten by the rerun.

---

### B-171 (existing)
**Status:** fixed · **Test:** `e2e/tests/render-views.spec.ts` ("the Tasks view's due window finds a
deadline on a task that is also scheduled"), `apps/web/src/views/taskFilters.test.ts` ("the due
window looks at the scheduled date AND the deadline", 4 cases)

**Fixed 2026-09-13.** `views/taskFilters.ts#inDueWindow` matches when the scheduled date or the
deadline lies in the window, one date satisfying both bounds (a task scheduled before a window with
its deadline after it is not in it); `filterTasks` uses it instead of comparing `dueDay`. The e2e
seeds three tasks in 2031 — scheduled 03-01 with deadline 03-20, scheduled 03-18, scheduled 03-01
only — and sets the window 03-15..03-25 in the real Tasks view: 2 rows expected; on `cf08d19`'s
`taskFilters.ts` it got 1 (the deadline task missing). The unit cases "a deadline inside the
window…" and "an open-ended bound…" failed before. The existing fixture task that had only
`dueDay` now also carries the `scheduledDay` it would have in real data. Left as it was: the row's
date label (B-324).

---

### B-324 · A Tasks view row shows only one date, so a task found by its deadline shows its scheduled date
**Status:** open · **Severity:** low · **Found:** 2026-09-13, fixing B-171 · **Test:** none

`views/TasksView.tsx` renders `formatDueDay(t.dueDay)` in `.task-due`, and `dueDay` is
`coalesce(scheduled_day, deadline_day)`. Since B-171 the Due from/to window matches either date,
so with a 2031-03-15..25 window the task "scheduled 2031-03-01, deadline 2031-03-20" is listed
with the label "2031-03-01" — outside the window the reader just typed, with nothing saying why it
is there. The row does not say whether its one date is a scheduled date or a deadline either. Likely
fix: show both dates when both are set, labelled as the journal agenda does
(`views/JournalAgenda.tsx`). Not done here: a display change beyond the filter bug.

---

### B-161 (existing)
**Status:** still failing (not fixed here)

Another data point, 2026-09-13 on port 6404: "opening the palette while editing and closing it hands
focus back to the editor" failed in every run on this branch — inside a 4-spec run, `views.spec.ts`
alone (28/29), and the full n–z half (295 passed, 1 failed) — and then failed 2/2
(`--repeat-each=2`) with every `apps/web/src` source file this branch changes restored to
`cf08d19`. So it fails on `cf08d19`'s client here too, though the coordinator's full run on the same
commit passed it; machine load (a dozen agents) is the difference in sight.

---
