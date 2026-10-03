# B-560 — journal date headings open that day's page

Branch: `worktree-agent-ac55010db96ab6707` (fast-forwarded from 41666ee to main `fd779f4` first —
the worktree had been created on a stale commit that had no B-560 in it).

## Done
- `apps/web/src/views/JournalStreamView.tsx`: a `DayTitleLink` wraps the date text of all four
  `h2.journal-day-title` sites (upcoming, today incl. virtual today, pinned, earlier) in a router
  `<A href={pageRoutePath(isoJournalName(day))}>`. Router `<A>` (not raw `<a>` + `rawAnchorHref`):
  `<Router base>` adds ADR 025's `/g/<slug>` prefix itself. The pinned day's "Back to stream"
  button stays outside the link.
- `apps/web/src/styles/views.css`: `.journal-day-link` inherits the heading colour (accent for
  Today), no underline except on hover; focus ring is the global one.
- Unit: `JournalStreamView.test.tsx` "links every day heading to that day's page, under the graph
  prefix too (B-560)" — failed against the pre-fix view, passes now.
- E2E: `e2e/tests/journal-heading-link.spec.ts` (3 tests: click earlier day → URL + h1 + content,
  no reload, link styled as heading; today via keyboard Enter → URL + h1; non-default graph
  `/g/<slug>` → href has the prefix once, click lands on `/g/<slug>/page/<iso>`).

## Verification (2026-10-03)
- e2e: journal*, a-fresh-journal, dates, views, graph-switcher, journal-heading-link — 70 passed.
- `pnpm --filter @nooklet/web test` — 162 files, 1384 tests passed.
- `pnpm -r typecheck` — exit 0. `pnpm exec biome check . --diagnostic-level=error` — clean.

## Behaviour of a virtual (no-page) day
Clicking today's heading before today has a block opens `/page/<today ISO>`, which PageView shows
as its "doesn't exist yet" view: the day's formatted title as h1, the day's agenda, references,
and a Create button (which creates it as a journal, B-77). Sensible, but not Logseq's editable
empty journal — possible follow-up below. Not a hang (B-581's concern); the e2e today test ran
against a fresh server where today had no page.

## BUGS.md updates to fold in

B-560 — replace Status/Test lines with:
**Status:** fixed (2026-10-03) · **Severity:** low · **Found:** 2026-09-13, owner request ·
**Test:** `apps/web/src/views/JournalStreamView.test.tsx` "links every day heading to that day's
page, under the graph prefix too (B-560)" (failed before the fix); `e2e/tests/journal-heading-link.spec.ts`
(3 tests, incl. keyboard and a non-default `/g/<slug>` graph).
Append: Fix: each day heading's text is a router `<A>` to `pageRoutePath(isoJournalName(day))`
(`JournalStreamView.tsx#DayTitleLink`) — upcoming, today (also while virtual), pinned and earlier
days. Styled as the heading (`.journal-day-link`: inherited colour, underline on hover only).

New (unnumbered, low, owner's call): Opening a not-yet-created journal day's page (e.g. today's
heading before today has a block, or any date link) shows the generic "This page doesn't exist yet
/ Create" view instead of the journal stream's draft input (`JournalDayOutline`'s virtual day).
Logseq shows an editable empty journal there. Found 2026-10-03 while doing B-560. Test: none yet.
