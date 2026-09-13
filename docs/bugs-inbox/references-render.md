# Bug inbox — references-render (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-551..B-559.

---

### B-550 (existing)

**Fixed 2026-09-13.** Each linked reference and unlinked mention now renders as the block looks
in its page, read-only: the full content through the outline's renderer (marker, priority,
multi-line text, fences, math, property chips, date chips), its children nested under a bullet
that folds in the panel only (stored `collapsed` honoured, root included; the toggle writes
nothing), and a breadcrumb of its parent blocks when it is not top-level. A row opens its block,
a link inside opens its target, a breadcrumb step opens that parent.

- The renderer is the embed's: `editor/render/ReadOnlyOutline.tsx`, moved out of `EmbedView.tsx`
  and shared by both (rows gained property and date chips, so embeds show them too; a date chip in
  a read-only row opens the block instead of the picker).
- Children and parents come from the replica, one read per list (`data/reference-trees.ts`: ancestor
  chains, subtrees of the outermost references, properties, ancestor text). `page.backlinks` still
  says which blocks reference the page.
- A reference inside another listed reference is not a row of its own (`views/referenceNesting.ts`):
  every descendant of a linking block is a `path_ref` reference, so without folding each child
  appeared twice. On the owner's graph `@alex`'s 756 references are 91 rows. Folding is against the
  filtered list — a child whose parent the filter hides becomes a row, with that parent in its
  breadcrumb. The heading still counts blocks (what `page.backlinks` reports); Logseq counts
  top-level references instead — left as an open question.
- A breadcrumb identical to the row above's is left out (`task`: 169 breadcrumbs → 66).
- Rows are keyed by page name and block id, so a backlinks refetch (one per typing pause) keeps
  them and their folds; before, every row was rebuilt on each refetch.

Measured on a copy of the owner's graph (`tools/probes/references-render-real-graph.mjs`, shape in
`tools/probes/references-shape-real-graph.sql`): first reference row 87–99 ms → 120–202 ms after
navigation on `@alex`/`task`/`camp`/`weekly review`/`@robin`; no main-thread stall over
50 ms while loading or on a refetch; 34–200 references, 179–456 outline rows rendered (row cap 50
per reference, 200 references per window, `content-visibility: auto` on rows).

Tests: `e2e/tests/references-render.spec.ts` › "a referencing block renders nested and formatted
under a breadcrumb; a child row opens that child" and › "with nested references, the filter, the
sort and Link all still work" (both fail on the old panel: 6 flat rows instead of 1; 4 instead of
3); `apps/web/src/views/ReferenceItem.test.tsx` (8, incl. the breadcrumb: order, one line each,
step → block, page link → page, none at top level, left out under an identical one);
`apps/web/src/views/referenceNesting.test.ts` (8); `apps/web/src/data/reference-trees.test.ts` (4).
`e2e/tests/views.spec.ts` › "a reference's page name opens that page, and the item opens the block
zoomed" now clicks the rendered row.

Not done: a ```` ```query ```` fence inside a reference renders as code, not live results (the
renderer's depth rule, as in embeds); references are not editable (by request).

---

### B-551 · Numbered blocks (`list:: number`) show plain bullets, no ordinals, in embeds and the references panel
**Status:** open · **Severity:** low · **Found:** 2026-09-13, references-render (B-550) · **Test:** none

`editor/render/ReadOnlyOutline.tsx` (the read-only outline `{{embed}}` and the references panel
share) renders a bullet for every row; `BlockRowView` numbers `list:: number` siblings through
`editor/numbering.ts#deriveNumbering`, and the read-only rows never do. The owner's graph has 705
`list:: number` blocks, so a referenced or embedded numbered list reads as an unordered one (`list`
is also a hidden property key, so nothing else says it is numbered).

Children are easy — their siblings are all in the tree. The root is not: its ordinal depends on
siblings on its page that the view does not have (a reference to item 3 of a list would read "1."),
which is why this was logged rather than folded into B-550.

---

### B-552 · A breadcrumb step whose parent is a heading (`## Articles`) renders empty — the breadcrumb vanishes or starts with a stray "›"
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of B-550 on a
copy of the owner's graph · **Test:** `apps/web/src/views/ReferenceItem.test.tsx` › "a heading, a fence
or an empty parent still reads as a step with text (B-552)"; `apps/web/src/views/referenceNesting.test.ts`
› "drops a heading's #s and skips lines that render as nothing inline (B-552)"

`views/ReferenceItem.tsx#ReferenceBreadcrumb` renders each step as
`<InlineContent content={breadcrumbLabel(parent.content)}>`, and `breadcrumbLabel` is the parent's
first non-blank line as written. `tokenizeContent` returns NO tokens for a heading line
(`## 🔖 Articles`, `### Content`, `# [[@Alex]]`), a fence's opening line (```` ```js ````, `~~~`) or a
thematic break (`---`) — they are block-level — so the step is an empty, zero-width, focusable
`<span>` with only its `title` saying what it was. On the real graph that is 94 steps on 62 target
pages: every OmnivoreSync article referenced from a journal day sits under `## 🔖 Articles` and shows
no breadcrumb at all (`/page/2024-10-23`), and `/page/arguments` shows `› Poznámky k rekonstrukci a … › Rozpočet a materiál`, the first step (`## Plánování zahradních úprav`) missing.
An empty parent block (2 on the real graph) gives the same stray separator.

**Fixed 2026-09-13.** `views/referenceNesting.ts#breadcrumbLabel` drops a heading's `#`s, skips fence
delimiter lines and thematic breaks, and says `(empty)` (as the zoom trail does) when nothing is
left. Both tests failed before the change (the component rendered `["", "", "", ""]`). Checked on the
graph copy: `/page/2024-10-23` shows `🔖 Articles` over its OmnivoreSync article, `/page/arguments`
shows `Plánování zahradních úprav › Poznámky k rekonstrukci a … › Rozpočet a materiál`.
