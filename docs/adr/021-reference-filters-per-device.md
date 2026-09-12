# ADR 021: Linked-reference filters are remembered per device, not as a page property

Date: 2026-09-12. Status: accepted.

## Context

M7 adds Logseq's linked-references filter (research/13 §4.2 item 5: "Filters for note body", 140
votes, "Sort linked references", 78): on a page's references panel, the set of other pages the
referencing blocks mention, click to include, click again to exclude, and the count on the heading
follows. The filter has to be remembered — a filter that resets every time you open the page is
one you set up again every time — and there are two obvious places to remember it.

Logseq stores it in the page file, as `filters:: {"aurora" true, "done" false}`. research/13's own
shortlist says "stored as a page property so it syncs". That is the alternative this ADR rejects.

## Decision

The filter is per device, in `localStorage`, under one key (`nooklet.referenceFilters`) holding a
map from the page's normalized name (ADR 004) to `{include, exclude}`; empty entries are removed on
save. The sort (most recent / by name) is one preference for the whole panel, not per page.
`apps/web/src/views/referenceFilters.ts` owns both; `ReferencesPanel.tsx` only reads and writes
through it.

## Why

- **A filter is a fact about this screen, not about the notes.** It is the same kind of thing as
  the theme (`app/theme.ts`), the journal title format (ADR 018) and the shelf (`app/shelf.ts`),
  all of which this codebase already keeps per device for the same reason: syncing them would make
  one device's choice fight another's, and none of them is content.
- **A page property turns every click into a graph write.** Each toggle in the popover would mint
  an op, land in the op log, rewrite the page's file in the markdown mirror, appear as a
  `changes.since` event to every agent watching, and be a batch someone could `batch.undo`. Logseq
  users know this as the `filters::` line cluttering their git diffs. ADR 003 wants the mirror to be
  a clean copy of the notes; a reading preference is not a note.
- **It would show in the page's properties block**, next to `tags::` and `icon::`, where it means
  nothing to anyone reading the page and invites "what is this and can I delete it".
- **Refetch churn.** The references panel is a server-computed view stamped on local page writes
  (B-83); writing a page property on every toggle would refetch the very list being filtered,
  once per click.

## What it costs

- The filter does not follow you to another device. Someone who curates a heavy page's references
  on a desktop sees the unfiltered list on their phone. This is the one thing the page-property
  design bought, and it is given up knowingly: the demand behind the feature is "let me hide the
  noise while I read", which is per sitting, not per graph.
- Clearing browser storage clears the filters. Same as the theme; nobody has asked for the theme to
  survive that either.
- Agents cannot see a human's filter. They have no use for it — `page.backlinks` returns
  everything, and an agent that wants a subset filters the result itself.

## Alternatives considered

- **`filters::` page property (Logseq).** Rejected above. If cross-device filters are ever wanted,
  the right shape is a per-user, non-content setting synced outside the page (a settings table
  that does not touch the mirror), not a page property — that keeps the reasons above intact.
- **Server-side per-token preference.** The server has no notion of "a user's settings" yet; adding
  one for a filter would be building the settings table above for one feature. Not now.
- **Remember nothing.** Rejected: the forum thread's complaint is precisely that the filter is
  fiddly to set up; making it ephemeral makes it fiddly every time.

## Consequences

- `docs/spec/`: no API change; `page.backlinks` is unchanged and the filter is computed client-side
  from the block's source page plus the `[[refs]]`/`#tags` in its returned text (first line). Refs
  only on continuation lines are not filter candidates — a known limitation noted in
  `referenceGrouping.ts`; if it matters, `page.backlinks` can grow a `refs` field later.
- Appearance settings (M7 item 6: text size, content width, custom CSS, `data/appearance.ts`)
  follow the same rule for the same reasons and cite this ADR rather than repeating it.
