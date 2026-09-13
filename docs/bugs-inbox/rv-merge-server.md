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
