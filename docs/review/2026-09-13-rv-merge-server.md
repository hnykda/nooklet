# Code review follow-through, 2026-09-13 — M8 merge resolutions in server/core (rv-merge-server)

Brief from the M9 coordinator: fix four code-review findings (F1–F4) on the merge resolutions in
`packages/server` and `packages/core` and on the cherry-picks of the M8 run, each already confirmed
by an independent skeptic. Reproduce each one first with a failing test, fix the cause, one commit
per finding, high severity first; write this record last.

Branch `m9/rv-merge-server`, from `febfc23`. Bugs were written to
`docs/bugs-inbox/rv-merge-server.md` (not `docs/BUGS.md`); progress in
`docs/progress/rv-merge-server.md`. Numbers B-365..B-369.

## Scope

Read in full for this work: `packages/server/src/mirror/{live,export}.ts` and their tests;
`packages/server/src/ops/{batch-undo,later-edits,trash-restore,apply-all-or-nothing,dry-run}.ts`,
`ops/{batch-undo,batch-undo-later-edits,undelete-collision,trash-restore-alias,refactor-atomicity}
.http.test.ts` (the parts on undo and restore), `page-aliases.ts`, `rows.ts#snapshotPage`;
`packages/core/src/sync/page-outline.ts`, `core/src/page-alias.ts`, `core/src/page-name.ts`
(`pageNameToFileName`), `core/src/sync/apply-ops.ts` (page create/rename/delete and
`pageKeyCollision`); `apps/web/src/data/page-export.ts` and `e2e/tests/page-export.spec.ts`;
mcp-tools.md §4.3.17; BUGS.md B-126, B-251, B-256, B-260.

The reviewer's probes (`scratchpad/m9/rv-merge-server/*.probe.test.ts`) import from the main
checkout, so they were used as evidence only; every finding got a real test on this branch.

## Findings, by severity

Line numbers are at `febfc23`.

| # | Sev | Where | What | Bug | Outcome |
|---|---|---|---|---|---|
| F1 | medium | `packages/server/src/mirror/live.ts:63` | The live mirror moves its `changes.seq` cursor whenever `exportAll` returns, and `exportAll` now reports page write failures instead of throwing (B-126 × B-260): a page that failed once is never retried until it changes or the server restarts, while the log says it will be. | B-365 | fixed `6d51dd9` |
| F2 | low | `packages/server/src/ops/batch-undo.ts:204` | `batch.undo`'s page-name pre-check uses the before-image and ignores `keep_later_edits`, so History's Undo is refused over a name the undo would not write. | B-366 | fixed `9aeb801` |
| F3 | low | `packages/server/src/ops/batch-undo.ts:208` | The same pre-check checks page keys only; B-256's alias refusal reached `trash.restore` (`trash-restore.ts:144`, `assertNameFree`) but not `batch.undo`, so undoing a delete takes a name back from a live page's alias. | B-367 | fixed `55e772b` |
| F4 | low | `packages/core/src/sync/page-outline.ts:176` | Core `pageMirrorPath` (the web export's file name) lacks the NAME_MAX shortening the server's own `pageFilePath` has, and the download lacks the mirror's `title::`. | B-368 | fixed `76c9e19` |

All four reproduced. None was left as "does not reproduce".

## Changes, in order

Each commit was green on `pnpm exec biome check`, `pnpm -r typecheck` and the unit suites of the
packages it touched before it was made.

1. `6d51dd9` fix(server): the live mirror retries a page file it could not write (B-365) — the
   sweep keeps the ids in `exportAll`'s `failed` and passes them to the next sweep through a new
   `exportAll` option, `alsoPageIds` (candidates on top of the pages touched since the cursor); the
   cursor still advances. **Changed from the suggestion:** the smallest version (`if
   (r.failed.length === 0) cursor = head`) was rejected. One page that can never be written would
   pin the cursor forever, and every sweep would re-render every page touched since. With the
   carry-over, a page that keeps failing costs one render per sweep and is logged each time.
   Test: `mirror/live.test.ts` "retries a page it could not write on the next sweep, without that
   page changing again (B-365)". It fails at `febfc23`, where the second sweep logs nothing about
   the page.
2. `9aeb801` fix(ops): batch.undo checks the name the page will have after the undo (B-366).
   `pagePlan(row)` works out the name and tombstone the undo leaves, and whether it writes a
   `page.rename`. Both the pre-check and the op builder read it, and `laterEdits` is memoized per
   entity. **Changed from the suggestion:** checking the post-undo name alone was not enough. In
   the "deleted since, name reused" case the undo still wrote `page.rename` to the page's own name
   on a page that stays in the trash. Core's `pageKeyCollision` rejects any rename onto a key a
   live page holds, whether or not the renamed page is live, so the call went from 409 to 400 with
   nothing undone. That rename is no longer written. Side effect, tested: undoing
   `trash.restore … new_name` after the old name was taken again used to get core's 400
   `page-key-collision`, and now gets the pre-check's 409. mcp-tools.md §4.3.17 errors updated.
   Tests: `batch-undo-later-edits.http.test.ts` "a later rename or delete it keeps does not make
   the undo fight over the page's old name (B-366)", which answers 409 at `febfc23`, and
   `undelete-collision.http.test.ts` "batch.undo of a restore under new_name, after the old name
   was taken, is conflict (B-366)", which answers 400 at `febfc23`.
3. `55e772b` fix(ops): batch.undo refuses a name a live page uses as an alias (B-367).
   `trash-restore.ts#livePageAliasing` is exported and takes a list of page ids to leave out
   (`json_each`, so a large batch needs no variable per id). `batch.undo` calls it for pages
   outside the batch. **Changed from the suggestion ("exclude pages in `firstByEntity`"):** a page
   the batch touched is judged by the aliases the undo leaves it, through a lazily built index. A
   merge's own alias is removed by its undo, but with `keep_later_edits` a later edit of that alias
   is kept, and a blanket exclusion would have let the restored page shadow it. A page that is live
   under the same key before and after the undo is not checked, because the undo moves no name.
   Otherwise an undo of a property change on a page an alias already shadowed (allowed by
   `page.create`) would be refused. Tool description and mcp-tools.md updated. Test: new
   `ops/batch-undo-alias.http.test.ts` with 4 tests. Two answered 200 before the fix; the other two
   guard the exemptions.
4. `80806e1` test(probes): `tools/probes/undo-names-real-graph.ts`, which runs F2 and F3 on a copy
   of the real graph (results below) and logs B-369.
5. `76c9e19` fix(core,server,web): one mirror file name for the server and the web export (B-368).
   Core `pageMirrorPath` now shortens names with B-126's rules: 200 UTF-8 bytes, cut on a code
   point, never inside `%XX`. The new core `pageMirrorOutline` adds the leading `title::` for a
   shortened name. Server `exportPage` and web `renderPageMarkdown` both use them. The server's
   private `pageFileBase` and `pageFilePath` are gone, and the tests use `pageMirrorPath`. The
   download gets `title::`; "Copy page as markdown" does not, since it has no file name to lose.
   **Decision:** the suffix is now 32-bit FNV-1a of the UTF-8 name, not `sha256(name)[0..8]`. Core
   runs in the browser, where the only SHA is async `crypto.subtle`. A file shortened under the old
   suffix is renamed on its next export by `exportPage`'s path-change cleanup, and the owner's graph
   has none. Tests: core `page-outline.test.ts` "shortens a name past NAME_MAX to a prefix and a
   hash, as the mirror names its file (B-368)" (fails at `febfc23`) and "puts the full name in
   title:: when, and only when, the file name was shortened (B-368)"; server `export.test.ts` "the
   web export's file name and text are the mirror's, long names included (B-368)"; e2e
   `page-export.spec.ts` "Export of a page whose name is past NAME_MAX downloads the mirror's
   shortened file, title:: included (B-368)". With the three source files put back to their pre-F4
   versions and the test kept, that e2e test failed: Chromium suggested the full 345-byte name while
   the mirror wrote `…čtvrtlet~6d458ccb.md`.
6. `728bd11` fix(ops): batch.undo's outline names a page as the undo leaves it (B-369). See below.

## Found while fixing

| Where | What | Outcome |
|---|---|---|
| `ops/batch-undo.ts` summary line | With `keep_later_edits`, the outline said `restored page "<before-image name>"` for a page left renamed, and "restored" for a page that stays in the trash. Seen on the real graph ("Plánování zahradních úprav", Garden). | B-369, fixed `728bd11`; test in `batch-undo-later-edits.http.test.ts` |
| `ops/batch-undo.ts` (F2's suggested fix) | A rename to the page's own name, on a page that stays trashed, is rejected by core. | folded into B-366 |
| `ops/batch-undo.ts` op order | **Not fixed, needs a number.** `batch.undo` cannot reverse a single batch that renamed page A to B and then created a new A (`batch` op, or a plugin). The undo writes the rename back to A before it deletes the new A, core rejects the rename, and the call answers 400 `page-key-collision (page.rename …); nothing was written`. Reproduced with a scratch probe (`scratchpad/m9/rv-merge-server/undo-rename-and-recreate.probe.test.ts`). Not introduced here: by reading, `febfc23` behaves the same (the pre-check exempts clashing pages inside the batch, and ops are minted in `changes.seq` order); the probe ran on this branch only. A fix would order page deletes before renames/un-deletes, or check the batch's post-undo keys as a whole. | open; coordinator to number |
| `page.delete` / `page.create` with an alias name | `page.delete {page: "Nick"}` while "Real" has `alias:: Nick` deletes "Real", and `page.create {name: "Nick"}` returns "Real" with `existed: true` and does not add its markdown. The first run of the real-graph probe hit this: `page.delete {page: "Daně"}` deleted Taxes. Both responses name the real page, so this is not silent. It looks like the intended alias resolution of `requirePage`, but it is surprising on a destructive op. | not changed; noted for the owner |

## Not done

- **The key-clash exemption for pages inside the batch** (`clash && !firstByEntity.has(clash.id)`)
  is still a blanket exemption. With `keep_later_edits`, a clashing page of the batch can be kept
  live under the key. Core then rejects the op and the savepoint answers 400 `invalid` instead of a
  409. Nothing is written either way. It was left alone because it is not part of F2/F3 and causes
  no data harm (see Still unverified).
- `page.create` still does not check aliases (B-256's note). Unchanged.

## Tests run

- Unit, final tree: core 395/395, server 617/617, web 1000/1000. `pnpm -r typecheck` clean. Biome
  clean on every changed file. One earlier full run after F4 had 2 core failures
  (`sync.property.test.ts`) and 11 server failures (`plugins/host.test.ts`,
  `plugins/built-ins.test.ts`), all "Test timed out", at load average 84. They were green once load
  fell to about 40, with no code change.
- e2e (Chromium, port 6471), final tree: history-later-edits, history, trash-conflict, trash,
  page-export, mirror-live, replace, link-unlinked, undo-redo, template-undo, 42 passed and 0
  failed. Earlier runs: 23/23 after F3 and 13/13 (page-export + mirror-live) after F4.
- The new e2e long-name export test against the pre-F4 sources: 1 failed, as expected (above).
- Real graph (copies of `~/.nooklet/default/graph.sqlite`, 952 pages):
  - `tools/probes/undo-names-real-graph.ts` on a fresh copy, final tree:
    - Undoing a "Daně" delete while Taxes has `alias:: daně` gives 409, the same answer as
      `trash.restore`.
    - Merging "Balení" (98 linked references) into Taxes and undoing it gives 200, with 98 links
      before and after.
    - With the later alias edit kept, the same undo gives 409; LWW gives 200.
    - A kept rename of a Czech-named page gives 200 with the outline naming its new name; LWW
      gives 409.
    - A kept delete gives 200 with "(in the trash)".
    - The probe's own verify found 0 divergences, and `nooklet verify` then read "OK" (20,808
      ops).
  - `nooklet export` of another fresh copy with the F4 code: 952 exported, `failed: []`, 0 shortened
    names, longest `pages/` file name 114 bytes.
  - `nooklet verify` on an untouched copy after F2: OK (20,411 ops).

## Still unverified

- **What a real browser saves for an over-long download name.** Playwright reported the full
  345-byte `suggestedFilename` at `febfc23`, but Playwright saves downloads under its own GUID
  names. Chromium's and WKWebView's behaviour when writing a name over 255 bytes to disk (cut,
  rename, fail) was not observed. After the fix the name is at most 203 bytes, so the question no
  longer arises for nooklet's own export.
- **The kept-clash 400 in "Not done"** comes from reading the code; there is no test for it.
- **F1 on a real full disk.** Tested with a non-empty directory where the file goes (EISDIR), not
  with ENOSPC or EACCES. `exportAll` catches every per-page throw the same way, so it should behave
  the same.
- **A graph with a mirror written under the old sha256 suffix** was not exercised. The rename on
  next export follows from `exportPage`'s existing path-change cleanup
  (`export.test.ts` covers renames), but no such file existed to test with.
- **B-369's wording** is covered by a unit test only. The History view does not show the undo's
  outline (no `.outline` read in any of its `batch.undo` callers in `apps/web/src`), so no e2e covers it.
