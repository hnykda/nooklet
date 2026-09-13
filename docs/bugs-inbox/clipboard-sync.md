# Bug inbox — m9/clipboard-sync

Entries for `docs/BUGS.md`, written here so parallel branches do not conflict on one file. New
numbers from B-300..B-309 only.

---

### B-233 (existing)

**Cause, found 2026-09-13 (clipboard-sync).** Not a product bug, and not simply "a-fresh-journal
leaves two blocks". Whether it leaves ANY depends on a race: its two blocks are applied to the
browser context's own OPFS replica and pushed to the server after a 300 ms debounce, and the test
ends (context closed, replica thrown away) right after its last local assertion. Measured on
`cf08d19` with a throwaway spec between the two that read `page.read <today>` from the server:
3 runs out of 3, the server had **no** page for today at all, and `editing.spec.ts` passed 5/5 —
its `openJournal` found a virtual day and seeded exactly one block. When the push does land first
(a loaded machine, as on the day it was found), today already has two blocks and "Enter creates a
second bullet" counts 3 rows, because it asserted an absolute count of 2 against a journal every
spec shares. Deterministic reproduction: seed `- first thought\n- second thought` into today via
`page.append` from a spec that runs before `editing.spec.ts` → "Expected: 2, Received: 3".

**Fixed 2026-09-13.** The test was wrong, not the product: Enter on the first of N journal blocks
correctly adds one row. `editing.spec.ts` "Enter creates a second bullet and both keep their text"
now counts the rows it starts with and expects one more, and `a-fresh-journal.spec.ts` "Enter on a
brand-new journal day continues into the next bullet" waits until the server holds its two blocks,
so the journal every later spec sees is the same on every run instead of depending on a push
debounce. Verified: with the seeded two-block today, the old assertion fails (3 ≠ 2) and the new
one passes; `a-fresh-journal` + `editing` together passed 3 runs of 3 after the change. The test
that would have caught it is the seeded run above; it is not kept as a spec because it only
exists to prove the assertion was state-dependent.

In one of those runs, `editing.spec.ts` "typing immediately after Enter is not discarded" failed
once after the reload (1 row, expected 2: the new block and its text both gone) and passed on the
two reruns — the same loss mechanism as B-247, not this bug; see there.

---

