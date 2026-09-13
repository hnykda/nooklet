# M11 progress — ref-pages (pages exist once referenced)

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief (coordinator, 2026-09-13): the owner's `[[Sprouts/Growing/Sixth Try]]` did not exist as a
page although referenced. Decision to implement and write up as an ADR ("pages exist once
referenced"): server mints `page.create` for newly dangling reference keys (+ namespace ancestors)
inside `serverApplyOps`; junk pages from half-typed links are deleted by the server in the same
call; one-time migration for existing graphs; mirror writes no file for an empty page; web opens an
existing empty page as a normal page; Playwright + http + verify tests.

Branch `m11/ref-pages` from `52e5d20`, worktree
`<repo>/.claude/worktrees/wf_975bcd44-fae-1`. Scratch
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/ref-pages/`
(`graph/graph.sqlite` = `.backup` of the owner's graph taken 17:34; `data/` = NOOKLET_DATA). E2E
port 6410. Bugs go to `docs/bugs-inbox/ref-pages.md` (new numbers B-440..B-449).

## Baseline measured (copy taken 17:34)

- 953 live pages; `ref` rows with `dst_page_id IS NULL`: 265 distinct keys, 1,355 rows. Top: `task`
  (tag, 686 — the derived Task tag), `quick capture` 89, `acmecorp` 24, `call` 21, `idea` 21,
  `@eva svobodová` 17. 17 of the 265 keys are ISO journal days. `page_tag` dangling: 2 (`book`,
  `design`). A `Journal` page already exists.

## Plan (units, in order)

1. Measure typing behaviour (probe in `tools/probes/`), journal-stream effect of an empty journal page.
2. Server: `packages/server/src/ref-pages.ts` — mint/delete inside `serverApplyOps`; reserved device
   id marks "created from a reference"; trash.list hides them; page.create claims them.
3. Server: rejected `page.create` (key collision) — redirect same-batch/later block ops to the live
   page; client adopts (two-device race).
4. Migration (`journal-names.ts` shape), importer runs it at the end; measure on the real graph.
5. Mirror: no file for a page with no blocks and no properties.
6. Web: empty existing page = normal page; All pages / graph / search / autocomplete include them.
7. ADR, Playwright specs, verify.

## Measured (unit 1) — `tools/probes/ref-link-typing.spec.ts`, e2e port 6410, 2026-09-13

- `[[` does NOT auto-insert `]]`: the buffer is `start see [[` after typing it, and nothing closes
  until the popup's selection or a typed `]]`. A half-typed `[[Sprouts/Gr` holds no reference.
- New link typed at 80 ms/char: one push, with the finished link. At 700 ms/char: 32 pushes, every
  one `[[P`, `[[Pr`, … without `]]` (no reference), then the finished link — 1 distinct link.
- Existing link `[[Probe Foo]]` edited to `[[Probe Foobar baz]]` at 700 ms/char: 7 pushes, 7
  DISTINCT complete links (`Probe Foob`, `Probe Fooba`, …). `#probetag` typed at 700 ms/char: 8
  distinct tags (`#p` … `#probetag`). So junk comes from editing inside a link and from tags.
- Empty journal page: a day (today−3) with its only block deleted shows in the journal stream
  (`["Sep 13th, 2026 · Today","Sep 10th, 2026"]`, one "Start typing" row). So no journal pages from
  date references.

## Design decisions so far

- Reserved device `refpages` (not hex → never a real device) marks ops the server mints for
  references. "Unclaimed" = minted by it, no other device's op except `page.delete`, never a block
  row, no properties. Unclaimed pages: deleted with their last reference, hidden from the trash,
  taken over by `page.create` (rename + props + markdown, same id), pushed aside by
  `trash.restore`, by an importer file of that name, and by an `alias::` naming them.
- A still-referenced name whose page is deleted or renamed away gets an empty page again.
- Importer writes with `referencedPages: "skip"`, then `mintDanglingReferencedPages` at the end.
- The two-device race (offline Create vs server-minted page) cannot be fixed by the server
  rewriting the late device's ops onto the live page: `verify` replays in HLC order and an offline
  block.create is OLDER than the server's page.create → rejected on replay. Plan: the push response
  names the live page for a `page-key-collision`; the client re-mints its unpushed ops for the
  refused page with fresh HLCs onto the live page (pull-first order handled at pull time).

## Done (committed)

(see git log; hashes filled in after each commit)

## Next steps

1. Commit unit 1 (server minting). 2. Migration on the real-graph copy: count, time, verify.
3. Refused-page adoption (push response + sync-client). 4. Mirror. 5. Web + e2e. 6. ADR + inbox.
