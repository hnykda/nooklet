# M11 progress — ref-pages (pages exist once referenced)

Resilience log, updated after every meaningful step. If you are reading this after a restart: read
"Next steps" and continue from there.

Brief (coordinator, 2026-09-13): the owner's `[[Sprouts/Growing/Sixth Try]]` did not exist as a
page although referenced. Decision to implement and write up as an ADR ("pages exist once
referenced"): server mints `page.create` for newly dangling reference keys (+ namespace ancestors)
inside `serverApplyOps`; junk pages from half-typed links are deleted by the server in the same
call; one-time migration for existing graphs; mirror writes no file for an empty page; web opens an
existing empty page as a normal page; Playwright + http + verify tests.

Branch `m11/ref-pages` from `ac2528e`, worktree
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

- `570ad45` server minting/junk deletion (`packages/server/src/ref-pages.ts`), migration
  (`ref-pages-migration.ts`, run from `cli.ts#open`), importer skip + final mint, page.create claims
  an unclaimed page, trash.list hides them, trash.restore/import evict them. Tests: ref-pages.test.ts
  (17), ops/ref-pages.http.test.ts (6), ref-pages-migration.test.ts (3); 6 older tests updated to the
  new rule (each with a comment).
- `f5bf1bb` B-440 schema v7 indexes. Real-graph copy (17:34): migration 259 pages (248 keys + 11
  ancestors) in 464 ms (was 13,946 ms before the indexes), 17 keys left = journal days, second run
  no-op, `pnpm nooklet verify` OK 20,705 ops. Probe `tools/probes/ref-pages-migration-real-graph.ts`.
- `7f128b2` B-442 refused-page adoption: push response `refused_pages` + `apps/web/src/sync/refused-page.ts`
  (pull-time displacement too). Tests `apps/web/src/sync/e2e.test.ts` (2, fail without the fix).
- `e3f8bfc` mirror: no file for an empty page; removed when the last block goes. `live.test.ts` +1,
  4 fixtures given content.
- `724e6c6` `e2e/tests/ref-pages.spec.ts` (5 tests, all green on 6410).

Web: no PageView change was needed — an existing empty page already renders title + "Start typing…"
row (B-410) + references; verified in the e2e spec.

- `87a3e69` ADR 024 (`docs/adr/024-pages-exist-once-referenced.md`; 023 was taken).
- `b70da4a` MCP test (block_update link → page_list/page_read).
- `9ecaae1` three older e2e tests assumed a linked page does not exist (pages.spec #tag ×2,
  render-views B-200, B-326 → journal day). First full e2e run (before this): 536 passed, 3 failed
  (exactly these), 2 skipped, 15.9 min.
- `409d158` sql-schema.md (v7 indexes), mcp-tools.md (page_create fills in), PLAN.md.
- Real graph served (copy, port 6410): migration 312 ms at startup, writes 8–12 ms, no junk, verify
  OK 20,730 ops; mirror dropped 37 rows of pre-existing empty pages (see inbox B-441).
- Unit after all: core 408, plugin-api 17, server 704, web 1,140; `pnpm -r typecheck` clean.

- After the second full run started: `d4edfd6` ctx.data.pages.create claims; `949adf2` page.update
  rename onto a linked name; `72b613d` batch.undo evicts; `da18aa7` pull-time displacement only for
  unconfirmed local pages + no tombstone revival (B-443 open); ADR/inbox updates.
- Second full e2e run (code as of `409d158`): 536 passed, 3 failed (editing "typing immediately
  after Enter", review-reactivity B-131 ×2), 2 skipped, 13.3 min, load average ~77. Reruns: editing
  passed alone; B-131 tests flaky under load (B-444, open).
- Subset e2e on the final code (ref-pages, page-rename, trash, trash-conflict, undo-redo, history,
  history-later-edits, journal-draft-sync, remote-device, pages, refactor, agent-ops, connectivity,
  mirror-live, a-fresh-journal, editing): 67 passed, 1 failed (remote-device "paired remote device
  can read"), which passed 3/3 alone.
- Unit on the final code: core 408, plugin-api 17, server 709, web 1,142; `pnpm -r typecheck` clean.

## Next steps

None in scope. Left for the owner/coordinator: B-443 (tombstone gap on a replica), B-444 (flaky
B-131 tests under load), the 37 pre-existing empty pages whose mirror files the new rule removes.
