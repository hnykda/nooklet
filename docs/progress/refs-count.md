# refs-count: the linked-references heading counts the way Logseq does

Owner decision 2026-10-03 (`docs/progress/coordinator.md` "Owner decisions"): switch the heading
from "every block" to Logseq's count. History: B-550's fix note ("The heading still counts blocks
(what `page.backlinks` reports); Logseq counts top-level references instead — left as an open
question").

Branch `worktree-agent-ae1597b2ae1e1d9ab` (fast-forwarded to main `5006319` first — the worktree
had been cut from a stale commit). e2e port 6308.

## What Logseq counts (read from source, 2026-10-03)

Logseq 0.10.9 (the file-graph release `views/referenceNesting.ts` already cites), fetched from
`raw.githubusercontent.com/logseq/logseq/0.10.9/...`:

- `src/main/frontend/components/reference.cljs`, `references*`:
  - `ref-blocks (db/get-page-referenced-blocks page-name)` — every block on another page whose
    `:block/path-refs` include the page or an alias (`db/model.cljs#get-page-referenced-blocks`:
    `(:block/_path-refs (db-utils/entity id))` over `page-alias-set`, minus the page's own blocks).
    So children of a linking block are in it, as in nooklet's `path_ref`.
  - `top-level-blocks (filter (fn [b] (some aliases (set (map :db/id (:block/refs b))))) ref-blocks)`
    — despite the name, the blocks whose OWN `:block/refs` name the page or an alias, i.e. blocks
    that link it directly. A child that only inherits the link is not one; a direct link nested
    inside another direct link IS one (it is not "outermost only").
  - `total (count top-level-blocks)`.
  - `filtered-ref-blocks (->> (block-handler/filter-blocks ref-blocks filters)
    (block-handler/get-filtered-ref-blocks-with-parents ref-blocks))` — the filter runs over every
    path-ref block, then each survivor's ancestors (within `ref-blocks`) are added back.
  - `filtered-top-blocks (filter (fn [b] (top-level-blocks-ids (:db/id b))) filtered-ref-blocks)`,
    `filter-n (count filtered-top-blocks)`.
  - Heading: `(t :linked-references/reference-count (if (seq filters) filter-n nil) total)`.
- `src/resources/dicts/en.edn`: `:linked-references/reference-count` →
  `(str (when filtered-count (str filtered-count " of ")) total " Linked Reference(s)")`, so a
  filtered heading reads "F of T Linked References".
- Unlinked: `:unlinked-references/reference-count @n-ref` where `n-ref` is
  `(apply + (for [[_ rfs] (db/get-page-unlinked-references ...)] (count rfs)))` — every matching
  block, no nesting rule. nooklet already counts that way; unchanged.

Net rule implemented: **linked count = blocks that reference the page directly (own refs, aliases
included). Filtered: "F of T", F = direct blocks that pass the filter or have a listed descendant
that passes it.**

Source access: via WebFetch (a summarising fetch) — the quoted forms above are what it returned
verbatim; not cross-checked against a local clone.

## Still unverified

- Not compared side by side with a running Logseq on the same graph.
- Not measured on the owner's real graph: the copy the B-550 probes used comes from
  `~/.nooklet/default`, which this task's safety rules forbid touching. Re-run
  `tools/probes/references-shape-real-graph.sql`'s idea with `EXISTS (ref …)` on a copy to see
  the new numbers (expected: `@alex` drops from 756 to roughly its direct-link count).
- nooklet's filter keys are not Logseq's (ADR 021 / `referenceGrouping.ts`: own page + refs in the
  first line, not `:block/path-refs`); kept as is per the task. Only the counting rule on top of it
  follows Logseq.

## Decisions

- **Where "direct" is decided: the server.** `page.backlinks` items gain `direct` (an
  `EXISTS (SELECT 1 FROM ref WHERE src_block_id = b.id AND dst_page_key IN (keys))`, keys =
  the page's key + aliases, same keys `path_ref` is built from in `apply-ops.ts#rebuildPathRef`)
  and the output gains `linked_direct_total`. Rejected: deciding it client-side from the text —
  the wire text is the first line only and knows nothing of aliases. Block targets: always direct.
- **Filtered heading reads "F of T"**, as Logseq's `en.edn` string does, instead of the bare
  filtered number. F follows Logseq's parent add-back (a direct block counts when it or any listed
  descendant passes); the filter keys themselves stay nooklet's (ADR 021).
- Older server (no `direct`): every item reads as direct — the old "count every block" number.
- Row folding, sort, filter, Link all: unchanged. Only the heading number changed.

## Done

One commit on this branch (see `git log`):
- `packages/server/src/ops/page-backlinks.ts`: `direct`, `linked_direct_total`; spec
  `docs/spec/mcp-tools.md` §4.3.6 updated.
- `apps/web/src/data/api-client.ts`: `BacklinkRef.direct`, `BacklinksResult.linkedDirectTotal`.
- `apps/web/src/views/referenceNesting.ts#countDirectReferences`; `ReferencesPanel.tsx` heading.
- Tests: `page-backlinks-totals.http.test.ts` "page.backlinks direct references" (2: nested +
  alias; not-yet-created page), `referenceNesting.test.ts` "countDirectReferences …" (6: nested
  hits, two pages, filter add-back, no trees, old server), new `ReferencesPanel.test.tsx` (5:
  unfiltered, include filter "2 of 3", exclude filter "1 of 3", server total past the fetch cap,
  unlinked unchanged).
- e2e assertions changed: `references-render.spec.ts` (6→1; 4→3, 1→"1 of 3", 3→"3 of 3",
  after Link all 6→4, after undo 4→3), `references-filters.spec.ts` ("1 of 3", "2 of 3" ×2,
  "0 of 3"), `references-cap.spec.ts` ("5 of 205"). `references.spec.ts`, `pages.spec.ts`,
  `link-unlinked.spec.ts`, `views.spec.ts` unchanged (flat fixtures, same number either way).

Results (2026-10-03, port 6308): web unit 1394/1394, server 782/782, `pnpm -r typecheck` clean,
biome `--diagnostic-level=error` clean. e2e `references references-filters references-cap
references-render link-unlinked views review-reactivity pages` (the "pages" filter also pulled in
`ref-pages.spec.ts`): 80 passed, 4 failed → 1 was mine (`references-filters` "0" → "0 of 3",
fixed, spec re-run 3/3); the other 3 are `ref-pages.spec.ts`, the known B-585 failures listed in
coordinator.md "State of main" — no reference counts in that spec.

## Next steps

None for this task. Merge is the coordinator's call.

## BUGS.md updates to fold in

New entry (unnumbered):

### B-??? · Linked-references heading counted every block, not Logseq's number
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13 (B-550's open question); owner
decision 2026-10-03 · **Test:** `apps/web/src/views/ReferencesPanel.test.tsx`,
`apps/web/src/views/referenceNesting.test.ts` "countDirectReferences …",
`packages/server/src/ops/page-backlinks-totals.http.test.ts` "page.backlinks direct references",
`e2e/tests/references-render.spec.ts`

The heading counted every `path_ref` block, so a journal block linking `[[@Alex]]` with ten
children counted 11 (756 on `@alex`, shown as 91 rows). Logseq 0.10.9
(`frontend/components/reference.cljs`, `top-level-blocks` / `filter-n`) counts blocks whose own
refs name the page or an alias, and under a filter shows "F of T". **Fixed 2026-10-03**:
`page.backlinks` marks each linked item `direct` and returns `linked_direct_total`; the panel
counts direct blocks (`referenceNesting.ts#countDirectReferences`, with Logseq's parent add-back
under a filter) and reads "F of T" when filtered. Unlinked count unchanged (Logseq counts every
mention too). Details: `docs/progress/refs-count.md`.

Amend B-550's fix note: "The heading still counts blocks … left as an open question" → "resolved
by the entry above (refs-count)".
