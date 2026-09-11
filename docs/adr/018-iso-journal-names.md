# ADR 018: Journal pages are stored by ISO date; the title format is a setting

Date: 2026-09-11. Status: accepted.

## Context

A journal page has three names at once today:

- its **day**, `journal_day = 20260907`, which is the identity;
- its **stored name**, whatever title format the graph was written with — `Mon, 07.09.2026` in the
  imported Logseq graph, `Sep 7th, 2026` in a graph nooklet created itself;
- its **wire name**, the ISO date, because `journalDayFromWire` and rule 18 address journals by ISO
  everywhere in the API.

The second of those is the odd one out, and it has now caused three separate bugs:

- **B-22** — a search result or block reference hands out the ISO date, `usePageByName` looked the
  name up by key, found nothing, and said "This page doesn't exist yet" about a page with 40 blocks
  in it. Patched by falling back to `parseJournalTitle` → `journal_day`.
- **B-23** — `page.create` guarded only against ISO names, so an agent calling it with
  `"Sep 8th, 2026"` minted an ordinary page that shadows the journal day forever.
- A quieter one, never filed: `ref.dst_page_key` is the reference text folded to lower case, so
  `[[Mon, 07.09.2026]]`, `[[Sep 7th, 2026]]` and `[[2026-09-07]]` are three different keys pointing
  at three different (mostly non-existent) pages. A journal's backlinks were whichever subset
  happened to use the same spelling as its stored name.

Every one of these is the same defect wearing a different hat: **the format a date is displayed in
had become part of its identity.**

## Decision

**A page with a journal day is stored under its ISO name. The displayed title is a preference.
Every recognised way of writing a date resolves to the same key.**

Three changes carry it:

1. **`packages/core`'s `applyOps` derives the name.** `applyPageCreate` and `applyPageRename` both
   run the proposed name through `storedPageName(name, journalDay)`, which returns
   `isoJournalName(day)` for any page with a valid journal day and the proposed name otherwise. The
   op log keeps whatever name the op carried — that is history — while live state has exactly one
   answer.

2. **Reference keys canonicalise.** The server's `normalizeKey` (`apply-ops.ts`) is now
   `normalizePageName(canonicalRefName(name))`, and `canonicalRefName` collapses anything
   `parseJournalTitle` recognises to its ISO name. `page_tag`'s tag keys go through the same
   function. Block text is *not* rewritten: `[[Mon, 07.09.2026]]` stays as the person typed it and
   simply resolves.

3. **Display is a setting.** `apps/web/src/data/page-title.ts` owns a `journalTitleFormat`
   preference and the `displayPageName` / `displayRefName` helpers every view now renders through.
   The importer no longer stores the source graph's `:journal/page-title-format`; it reports it as
   an import note instead, so the person can choose it in settings and see the dates they are used
   to.

An existing graph is migrated by `packages/server/src/journal-names.ts`, run from `open()` in the
CLI and guarded by a `setting` row.

## Why the migration mints ops rather than updating rows

A raw `UPDATE page SET name = …` is one line and would be wrong twice over. Live state is a
projection of the op log, so `nooklet verify` — which replays the log and compares — would flag
every renamed page. And a client bootstraps from a *state snapshot* and then follows the op stream,
so a rename that is not an op is a rename no other device ever hears about: the desktop app would
show `Mon, 07.09.2026` forever while the server had moved on.

So the migration mints real `page.rename` ops with the server's device id. They apply locally,
replicate through sync, and apply identically on the other side because the coercion in (1) lives
in the shared reducer. That is also why `applyPageRename` coerces rather than refusing: a rename to
the ISO name has to be something that can actually happen.

Minting ops needs an HLC and a device id, which exist a layer above `schema.ts`, so this is a
startup task rather than a schema migration. It is idempotent and costs one `setting` read once the
graph is canonical.

The derived indexes are re-keyed in place rather than rebuilt from block content. The mapping (old
key → `canonicalRefName`) is a pure function of the key, so re-parsing 18k blocks would compute the
same answer about a hundred times more slowly.

## Why not the alternatives

**Keep storing the display format; keep patching lookups.** This is the status quo, and B-22's fix
is exactly it — `usePageByName` falls back to the day number when the name misses. It works, one
call site at a time, and every new consumer of page names starts out broken until someone notices.
The three bugs above are three such call sites; the reference index was a fourth nobody had looked
at yet.

**Store the ISO name but leave references uncanonicalised.** Half the change, and strictly worse
than doing nothing: renaming the pages without re-keying `ref` would empty every journal's
backlinks on the spot.

**Canonicalise references but leave names alone.** The other half. References would all agree on
`2026-09-07` and resolve to nothing, because no page is stored under that key.

**Make the display format a server setting rather than a per-device one.** Tempting — it is a
property of the graph, and it would follow you between machines. Left for later because it needs
the settings API that does not exist yet, and because "what my dates look like on this screen" is
genuinely defensible as a device preference. Moving it is a small change when there is somewhere to
move it to.

**Rewrite `[[Mon, 07.09.2026]]` in block text to `[[2026-09-07]]`.** Consistent, and it would let
references resolve with no canonicalisation at all. Rejected: it edits 18k blocks of a person's
prose to make a storage decision visible, and it destroys the thing the format setting is for. The
words in a note belong to whoever wrote them.

## Consequences

- The page title is no longer editable on a journal page — it renders as a heading. There is
  nothing for a rename to mean, and `applyPageRename` would undo it anyway.
- The page switcher and the all-pages filter match against the displayed title *and* the stored
  name, so a journal is found by `2026-09` and by `Sep 7th` alike. Matching one or the other alone
  would have quietly lost half the ways people look for a day.
- `LogseqConfig.journalPageTitleFormat` no longer affects import. It is parsed, reported, and
  otherwise informational — like `journalFileNameFormat` already was.
- The markdown mirror is unaffected: `pageFilePath` already derives a journal's file name from its
  day (`journals/2026_09_10.md`), so no file moves and no `title::` changes.
- A page named `11.12.2024` with no journal day keeps its name and stays reachable by it — both in
  the op layer, which never guesses from a string, and in `resolvePageRef`, which checks for a real
  page before reading a name as a date. What you cannot do is *create* one through `page.create`:
  B-23's guard reads any parseable date as a journal, on the grounds that a date-shaped page name
  is far likelier to be a misdirected journal write than a deliberate title. An imported graph can
  still contain one, which is why the name-before-date order matters.
- One thing to watch: a graph in which someone had already created an ordinary page named
  `2026-09-07` blocks that day's journal from taking its name. The migration reports it rather than
  guessing; the journal keeps its old name and works as before.
