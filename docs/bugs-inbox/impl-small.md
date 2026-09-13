# Bugs inbox — impl-small (M8)

Entries in `docs/BUGS.md` format, for the coordinator to merge. Numbers B-230..B-239 are this
branch's. The audit items these come from are `docs/review/2026-09-12-exposure-audit.md` §2.

---

### B-230 · A block's created/edited time is stored but shown nowhere
**Status:** fixed · **Severity:** low · **Found:** 2026-09-12, exposure audit §1.1 ("Block
timestamps … not rendered anywhere") and §2 #15 · **Test:** `e2e/tests/block-timestamps.spec.ts`,
`apps/web/src/app/block-times.test.ts`

Every block row carries `created_at` and `updated_at` in both the server and the client replica
(`BlockRow.createdAt/updatedAt`), but no surface renders them: right-clicking a bullet lists
commands only, and there is no tooltip. "Block Timestamps" has 46 votes on the Logseq forum
(research/13 §3.1).

**Fixed 2026-09-13.** The block context menu ends in a muted, non-clickable line — "Created today
14:03", plus "· Edited 5 minutes ago" once the text changed after creation — with the exact local
times as its tooltip (`app/BlockTimestamps.tsx`, `app/block-times.ts`, `data/block-times.ts`;
one-line hookup in `app/BlockContextMenu.tsx`). Wording reuses `views/historyText.ts#formatWhen`.
Caveats written into `block-times.ts`: an imported block's "Created" is its markdown file's mtime
at import, and "Edited" moves only on a text change (`block.text`), not on marker/collapse/move.
Tests that would have caught it: `e2e/tests/block-timestamps.spec.ts` (both tests; the second
fails with `activeElement is body` when the footer's mousedown guard is removed — checked) and
`apps/web/src/app/block-times.test.ts`.

---

### B-231 · Pressing on a context-menu separator or its padding ends editing while the menu stays open
**Status:** open · **Severity:** low · **Found:** 2026-09-13, impl-small, while adding B-230 ·
**Test:** none yet

The menu items guard their `mousedown` (B-71), but the menu's other content does not: a press on a
`.ctx-sep` line or on the `.ctx-menu` padding moves focus to `<body>`, which ends editing (B-74),
and the menu's own dismiss listener ignores presses inside the menu, so it stays open over a row
that is no longer being edited. Inferred from the same mechanism the B-230 footer hit (its e2e test
failed with `activeElement is body` without the guard); not separately reproduced on a separator.
Likely fix: `onMouseDown={(e) => e.preventDefault()}` on the `.ctx-menu` container itself in
`app/BlockContextMenu.tsx`, plus an e2e test pressing on a separator.
