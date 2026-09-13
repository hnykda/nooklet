# Bug inbox — rv-merge-server

Entries from the M9 fix pass over the server/core merge review (findings F1–F4). Folded into
`docs/BUGS.md` by the coordinator. Numbers B-365..B-369.

---

### B-365 · The live mirror never retries a page file it failed to write
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, merge review of server/core (F1) ·
**Test:** `packages/server/src/mirror/live.test.ts` "retries a page it could not write on the next
sweep, without that page changing again (B-365)"

While `nooklet serve` runs, a page whose `.md` could not be written (a full disk, a permission
error, a sync client holding the file) stays missing from `pages/` until that page is edited again
or the server restarts. The log says "could not write 1 page file(s), will retry after the next
commit", and the next commit's sweep writes the other page it touched but says nothing about the
failed one and never tries it again. On a full disk every page in the sweep fails, so all of them
are dropped silently.

Cause: two fixes merged into one. B-126 made `exportAll` catch a page's write error and report it
in `failed` instead of throwing; B-260 made the sweep follow a `changes.seq` cursor and move it to
the head whenever `exportAll` returns. Each was right alone (before B-126 the throw kept the cursor
where it was; before B-260 the `updated_at > written_at` test picked the page again). Together, a
failed page falls behind the cursor, and later sweeps only look at pages touched after it.

**Fixed 2026-09-13.** The live mirror keeps the ids of the pages the last sweep could not write
and passes them to the next one (`exportAll`'s new `alsoPageIds`, candidates on top of the pages
touched since the cursor); the cursor still moves to the head. Rejected: leaving the cursor where
it was while anything failed (the reviewer's smallest version). One page that can never be
written (a directory in its place, a read-only file) would then pin the cursor, and every sweep
would re-render every page touched since, for as long as the server runs. With the carry-over a
page that keeps failing costs one render per sweep and is logged every time, and the log line's
"will retry after the next commit" is true. The test that would have caught it:
`mirror/live.test.ts` "retries a page it could not write on the next sweep, without that page
changing again (B-365)" — it failed at `cf08d19` on the second sweep, which logged nothing about
the page.

---

### B-366 · History's Undo is refused over a page name the undo would not touch
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge review of server/core (F2) ·
**Test:** `packages/server/src/ops/batch-undo-later-edits.http.test.ts` "a later rename or delete
it keeps does not make the undo fight over the page's old name (B-366)";
`ops/undelete-collision.http.test.ts` "batch.undo of a restore under new_name, after the old name
was taken, is conflict (B-366)"

Set a property on page "Alpha", rename the page to "Beta", create a new "Alpha", then Undo the
property change from History: "cannot restore page "Alpha": a live page is already named "Alpha"",
and nothing is undone. The undo would only have removed the property — History sends
`keep_later_edits`, which leaves the later rename alone — so there was nothing to collide with.
The same happens when the page was deleted after the change and its name reused: the page would
stay in the trash, yet the undo is refused.

Cause: `batch.undo`'s "is the restored name free" pre-check (added for B-90) compares the page's
name and tombstone from *before* the undone batch with live pages, and runs without asking which
fields `keep_later_edits` (B-251) will leave as they are. The two landed on parallel branches and
neither tested both.

**Fixed 2026-09-13.** `batch.undo` works out, once per page, what the undo will leave: the name
(the before-image's, or the current one when a later rename is kept), the tombstone (likewise),
and whether it writes a `page.rename` at all. The pre-check and the op builder both read that, so
the check asks about the name the undo actually claims. Doing only that (the reviewer's suggested
fix) was not enough for the delete case: the undo still wrote `page.rename` to the page's own name
on a page that stays in the trash, and core rejects any rename onto a key a live page holds, trashed
page or not — the call went from 409 to 400 with nothing undone. Such a rename is now not written;
it would have restored nothing. Side effect, tested: undoing a `trash.restore … new_name` after the
old name was taken again answered 400 `page-key-collision` from core, and now answers the
pre-check's 409 conflict. Tests that would have caught it:
`ops/batch-undo-later-edits.http.test.ts` "a later rename or delete it keeps does not make the undo
fight over the page's old name (B-366)" (409 at `cf08d19`) and `ops/undelete-collision.http.test.ts`
"batch.undo of a restore under new_name, after the old name was taken, is conflict (B-366)" (400 at
`cf08d19`).

---

### B-367 · Undoing a page delete takes the name back from a live page's alias
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge review of server/core (F3) ·
**Test:** `packages/server/src/ops/batch-undo-alias.http.test.ts`

Delete page "Alex", add `alias:: Alex` to "@Alex", then undo the delete (History's Undo, or
`batch_undo` with the delete's `batch_id`): "restored page "Alex"". `page.read Alex` now returns the
restored page instead of "@Alex", and every `[[Alex]]` link goes there — the harm B-256 fixed for
the Trash view. `trash.restore` of the same page is refused with 409 "a live page, "@Alex", uses
"Alex" as an alias"; the undo is not.

Cause: B-256 added the alias check to `trash.restore` (`assertNameFree`) while another branch added
a parallel "restored name must be free" pre-check to `batch.undo`, copied from `trash.restore`'s
older key-only check. The merge kept both and gave the alias half to `trash.restore` only. Undoing
a `page.merge` itself is not affected: the merge adds the alias in the same batch, so its undo
removes it again — unless `keep_later_edits` keeps a later change to that alias.

**Fixed 2026-09-13.** `batch.undo`'s pre-check refuses a page name that a live page uses as an
alias, with the same `conflict` as a taken name ("cannot restore page "Alex": a live page,
"@Alex", uses "Alex" as an alias"), through `trash-restore.ts#livePageAliasing`, now exported and
taking a list of pages to leave out. Two things the reviewer's suggested fix ("exclude pages in the
batch") would have got wrong, both tested: a page the batch touched is judged by the aliases the
undo leaves it, not skipped — undoing a merge removes the alias the merge added, but with
`keep_later_edits` a later edit of that alias is kept and still shadows the restored page; and an
undo that moves no name (the page is live under the same key before and after) is not refused over
an alias that page already shadowed, which `page.create` allows. Test that would have caught it:
`ops/batch-undo-alias.http.test.ts` (4; the delete-then-alias case and the kept-alias merge case
answered 200 before this fix, at `d4f1335`; the other two guard the exemptions).

---

### B-369 · A keep_later_edits undo says "restored page "Old name"" for a page it left renamed or in the trash
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, while checking B-366 on a copy of the
real graph (`tools/probes/undo-names-real-graph.ts`) · **Test:**
`packages/server/src/ops/batch-undo-later-edits.http.test.ts` "the outline names a page as the undo
leaves it, not as it was before the batch (B-369)"

Set a property on "Plánování zahradních úprav", rename the page to "Plánování (přejmenováno)",
then undo the property change with `keep_later_edits` (History's Undo): the call succeeds, the page
keeps its new name, and the outline — the text an agent reads, and the MCP tool result — says
`restored page "Plánování zahradních úprav"`. Likewise for a page deleted since: `restored page
"Garden"` while Garden stays in the trash. The summary line names the before-image's name whenever
the undo wrote any op for the page, whatever it left the name and tombstone as.

**Fixed 2026-09-13.** The line uses the name the undo leaves the page with (B-366's `pagePlan`),
and says `(in the trash)` when the page stays there. Without `keep_later_edits` nothing changes for
a live page: the rename is undone too and the old name is the right one. Test that would have
caught it: `ops/batch-undo-later-edits.http.test.ts` "the outline names a page as the undo leaves
it, not as it was before the batch (B-369)" (said `restored page "Named Before"` before).

---

### B-368 · "Export page as markdown" names a long page's file differently from the mirror, and leaves out its title
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, merge review of server/core (F4) ·
**Test:** `packages/core/src/sync/page-outline.test.ts` "shortens a name past NAME_MAX to a prefix
and a hash, as the mirror names its file (B-368)", "puts the full name in title:: when, and only
when, the file name was shortened (B-368)";
`packages/server/src/mirror/export.test.ts` "the web export's file name and text are the mirror's,
long names included (B-368)"; `e2e/tests/page-export.spec.ts` "Export of a page whose name is past
NAME_MAX downloads the mirror's shortened file, title:: included (B-368)"

For a page whose name is longer than the mirror's 200-byte file-name limit (B-126) — easy with
`block.to_page`, which names a page after a block's first line — the web client's Export page as
markdown suggests a file name of the full, unshortened name (352 bytes for a 300-character Czech
name, past the 255-byte limit of APFS and ext4), while the server's mirror writes
`…oznámky z porady o~30f11c5a.md` with a `title::` line carrying the full name. The download has
no `title::`. `page-export.ts` promises the mirror's file "byte for byte", and core's
`pageMirrorPath` says the download and the mirror "carry the same name"; for such a page neither
is true, and a browser that cuts the over-long name leaves a file whose name no longer says what
the page is called.

Cause: the B-126 fix (security branch) shortened names in the server's own `pageFilePath` and
injected `title::` in `exportPage`; the impl-export branch had made the server call core's
`pageMirrorPath`. The merge kept the server's copy, so core's function — now used only by the web
export — never learned the limit.

**Fixed 2026-09-13.** One implementation, in core: `pageMirrorPath` shortens past 200 UTF-8 bytes
(code-point-safe, never inside a `%XX` escape, as B-126 did) and the new `pageMirrorOutline` adds
the leading `title::` for a shortened name. The server's `exportPage` and the web's
`renderPageMarkdown` both call them; the server's private `pageFileBase`/`pageFilePath` are gone.
The download gets `title::` (it is the mirror file); "Copy page as markdown" does not, having no
file name to have lost the page's name from. The suffix hash changed from the first 8 hex of
`sha256(name)` to 32-bit FNV-1a of the name's UTF-8 bytes, because core runs in the browser too,
where the only SHA is async (`crypto.subtle`). A mirror file shortened under the old suffix is
renamed on its next export by `exportPage`'s path-change cleanup; the owner's graph has none
(`nooklet export` of a copy: 952 pages, `failed: []`, 0 shortened names, longest file name 114
bytes). Tests that would have caught it: `core/src/sync/page-outline.test.ts` "shortens a name past
NAME_MAX to a prefix and a hash, as the mirror names its file (B-368)" (failed at `cf08d19`: the
path had no suffix) and "puts the full name in title:: when, and only when, the file name was
shortened (B-368)"; `server/src/mirror/export.test.ts` "the web export's file name and text are the
mirror's, long names included (B-368)"; `e2e/tests/page-export.spec.ts` "Export of a page whose
name is past NAME_MAX downloads the mirror's shortened file, title:: included (B-368)" — at
`cf08d19` Chromium suggested the full 345-byte name while the mirror wrote
`…čtvrtlet~6d458ccb.md`.
