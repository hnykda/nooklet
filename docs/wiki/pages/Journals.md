type:: guide
summary:: The journal stream, how a day is named and stored (ISO), and the display-format setting.
tags:: guide

- The Journals view (`/journals`, Cmd/Ctrl+Shift+J, the app's start page) is a stream: today at the top, earlier non-empty days below, newest first, loading fourteen more days each time you reach the bottom. Cmd/Ctrl+J opens today's journal.
- Today is virtual until it has a block. Nothing is stored for an empty day, so the stream, page lists, search and the API never show one. A day ahead of today exists only because something was written or scheduled there, so it shows above today rather than being hidden (B-24).
- The calendar in the stream opens any day. A day with no page opens as an empty page and exists once you type into it.
- ## How a day is named
  - A journal page is stored under its ISO date, `2026-09-07`, always (ADR 018). Its title on screen is a per-device setting — Settings → Appearance → Journal date format — with presets such as `Sep 7th, 2026`, `Monday, 07.09.2026` and the ISO date itself. See [[Settings]].
  - A reference written in any recognised format — `[[Sep 7th, 2026]]`, `[[Mon, 07.09.2026]]`, `[[2026-09-07]]`, `[[07.09.2026]]` — resolves to the same page and displays in your chosen format. The text you typed is left alone; only the reference key is canonicalised (`canonicalRefName`; `JOURNAL_TITLE_FORMATS` in `packages/core/src/journal.ts` lists the sixteen formats tried).
  - Over the API and MCP a journal is addressed as `YYYY-MM-DD`, or as `today`, `yesterday`, `tomorrow`, anywhere a page name is accepted.
  - A journal's title cannot be edited: the day is its identity, and the reducer would undo a rename. The app and the API refuse to create an ordinary page with a date-shaped name, so nothing can shadow a day (B-23, B-52, B-77); an imported graph may still contain one, and it stays reachable by its name.
  - Why it is this way: before ADR 018 the display format was the stored name, so the same day written three ways was three pages with three backlink lists (B-21, B-22).
- ## Journals in the graph
  - Every journal page carries an intrinsic `Journal` tag (ADR 017), derived from the page having a day rather than written into it — it cannot be removed, and an imported graph's journals are journals without any property saying so.
  - Imported Logseq journals take their day from the file name (`journals/2026_09_07.md`). The graph's `:journal/page-title-format` is not stored; it is offered as the initial display format so the dates keep looking the way you are used to. See [[Import from Logseq]].
- ## Not built yet
  - A "Scheduled and deadline" section on each journal day, listing tasks due that day plus overdue ones, is in `docs/PLAN.md` §8 and not built as of 2026-09-12. The [[Tasks]] view filters by date instead.
  - Journal templates are M7 work in flight in the tree at the time of writing; not documented here until they land.
- Related: [[Tasks]], [[Settings]], [[Concepts]].
