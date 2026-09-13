# Code review — merge resolutions in the web client (M8 integration), 2026-09-13

Part of the M9 review workflow (`docs/progress/coordinator.md`). A reviewer read the web client for
defects that the M8 merges created — two branches, each correct on its own, meeting in a merge that
resolved without a conflict or was resolved by hand — and an independent skeptic tried to refute
each finding and could not. This document is the fixer's record: what was found, what was
reproduced, what changed, and what was left. Branch `m9/rv-merge-web`, based on `cf08d19`. Bugs
are in `docs/bugs-inbox/rv-merge-web.md` (B-360–B-364, plus one unnumbered) for the coordinator to
fold into `docs/BUGS.md`.

## Scope

Dimension: **merge resolutions in `apps/web`** — where B-101 (the editing buffer holds a block's
property lines), B-108 (commands commit batches through the editor), B-234 (the read-only page
lock), B-241 (undo after a session ends), B-221 (print) and find in page met.

Read for the fixes: `editor/BlockTree.tsx` (`runStructural`, `doUndo`/`doRedo`, the editor host
backing, the `filtered`/`rows` memos, the header), `editor/editText.ts`, `editor/external-batch.ts`,
`app/editor-host.ts`, `app/page-find.ts`, `app/CommandLayer.tsx` (the `pageFind` wiring),
`commands/registrations/templates.ts`, `commands/hosts/editor-host.ts`, `views/PageFindBar.tsx`,
`views/page-find.css`, `styles/print.css`, `app/print.ts`, `render/tokens.tsx` (header only).

Method, per finding: reproduce first with a test that fails against the unfixed source, then fix
the cause, then the test green. Every UI finding got a Playwright case (real Chromium, real
`nooklet serve`, production build, port 6470); each was run red before the fix, and where a fix
had two or three independent parts each part was shown red on its own (details per finding). The
reviewer's probe (`<scratch>/m9/rv-merge-web/caret-probe.test.ts`, against the main checkout's
`editText.ts`/`external-batch.ts`) was re-run first: 2/2 pass, i.e. it confirms F1 and F2 at the
function level.

## Findings, by severity

Line numbers are at `cf08d19`.

| # | Bug | Severity | Where | What |
|---|---|---|---|---|
| F1 | B-360 | medium | `editor/BlockTree.tsx:626` (`runStructural`, same-block branch) | `/template` into an empty bullet commits through `commitOps` with focus on the same block, caret `{at: "end"}`. The branch set that content caret on the surface unmapped; the buffer is `text\nlist:: number`, so the caret landed after the property and the next keystroke edited it (`list:: number!`). `doUndo`/`doRedo` had been converted to `bufferCaret()` in the impl-render merge; this branch merged cleanly and was missed. |
| F2 | B-361 | low | `app/page-find.ts:56`; wiring `app/CommandLayer.tsx:325` | `openPageFind` saved `editing.end`, a buffer offset; Escape's focus request treats its caret as a content offset and maps it into the buffer again, so a caret below a property line came back that line's length further on. |
| F3 | B-362 | low | `editor/BlockTree.tsx:665,690` (`doUndo`/`doRedo`), reached from `:1021-1022` | Locking a page ends the session; Cmd/Ctrl+Z still reaches the tree through `historyEditorHost` (B-241) and `doUndo`/`doRedo` never checked the lock. The edit was reverted on the locked page, on the server too, and an editor reappeared in the locked block. |
| F4 | B-363 | low | `editor/BlockTree.tsx:311-330` (`filtered`, `rows`); `styles/print.css:94-124` | An active find filter won over printing's `expandAll`, so paper got only the matches and faded ancestors, collapsed children folded, under the find bar, which `print.css` did not hide. |
| F5 | B-364 | low | `editor/BlockTree.tsx:25-27` | The header said `{{embed}}` renders a placeholder; it renders read-only through `EmbedView` (B-210). |

All five reproduced (F5 by reading: it is a comment). None was refuted.

## Changes

One commit per finding, each with its test, the inbox entry and this branch's progress file:

1. `e0eb2c7` docs: B-360–B-364 logged before any fix.
2. `c3bb9f7` **F1 / B-360** — `surface.setCaret(bufferCaret(res.focus.id, res.focus.caret))` in the
   same-block branch. Test: `e2e/tests/templates.spec.ts` "/template into an empty numbered item:
   what is typed next extends the text, not the list property (B-360)". Red before: stored
   `{content: "Daily plan for [[Sep 13th, 2026]]", properties: {list: "number!"}}`.
3. `bed80fc` **F2 / B-361** — `openPageFind(editing: EditorSelection | null)` saves
   `contentOffsetOf(editing.content, editing.end)`; `CommandLayer.tsx` unchanged (it already passed
   the whole selection). Tests: `app/page-find.test.ts` "puts back a content offset when the editing
   buffer shows property lines (B-361)" (red: `{offset: 31}` for 17) and `e2e/tests/page-find.spec.ts`
   "Escape puts the caret back in the same place in a block that shows a property line (B-361)"
   (red: caret 41 for 31).
4. `12fa9a7` **F3 / B-362** — `refuseHistoryWhenLocked()` at the top of `doUndo` and `doRedo`: on a
   locked page they do nothing and show the read-only notice, like the tree's other writers. Test:
   `e2e/tests/read-only.spec.ts` "after a page is locked, Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z no longer
   write to it (B-362)". Red before, each half separately: against the unfixed build the undo made
   the row `editable` (and a temporary `readBlocks` poll, since removed, read `editable` from the
   server); with only the redo guard disabled the redo made it `editable text more`.
5. `5e16080` **F4 / B-363** — `filtered` returns null while `isPrinting()` (so `rows` expands and no
   row carries a find class; `afterprint` restores the filter), and `print.css` hides `.page-find`
   and makes `::highlight(nooklet-find)` / `::highlight(nooklet-find-current)` transparent. Test:
   `e2e/tests/page-export.spec.ts` "printing with find in page open prints the whole page and no find
   bar" — DOM read from a `beforeprint` listener around a real `page.pdf()`, then back on screen the
   find is still there as it was. Red at each part in turn: the bar visible under print media; with
   only the CSS fixed, the printed rows `parent of apple`, `hidden child` with one context and one
   match row; the highlight backgrounds under print media the find colours
   (`color(srgb 0.541176 0.360784 0 / 0.28)`, `… 0.831373 / 0.34`).
   Choice: printing wins over the find, rather than closing the bar on `beforeprint`, because the
   find comes back unchanged when the dialog closes. The highlight part goes one step past the
   finding's text (bar + rows): the marks are ranges that survive the print's re-render, and they
   are the same leftover of the find on paper.
6. `7634832` **F5 / B-364** — the header names the one remaining gap (`.vr-ref-new`, which nothing in
   `apps/web/src` emits) and says embeds render read-only through `render/EmbedView.tsx`. No test.
7. This document.

## Test runs

- e2e (chromium, port 6470), after all five: templates, template-undo, template-collapsed,
  block-properties, page-find, read-only, undo-redo, redo, focus, editing, page-export,
  journal-stream-editing, embeds, selection, parity, editing-row-leaves, context-menu —
  **156 passed, 0 failed** (2.7 min).
- Per fix: templates + template-undo + template-collapsed + block-properties 24/24; page-find 9/9;
  read-only + undo-redo 14/14, then + focus 44/44; page-export + page-find 19/19.
- Web unit (`apps/web`, vitest) at HEAD: **1001/1001**. Two intermediate full runs under load
  average 58–72 had 4 and 8 timeouts in `data/page-title.test.ts`, `views/SearchView.test.tsx`,
  `editor/render/embed.test.tsx`, `editor/render/render-seams.test.tsx` — none imports the changed
  code; each passed rerun on its own, and the final full run had none.
- `pnpm -r typecheck` clean before every commit; `biome check --write` on every touched file.
- `pnpm nooklet verify` not run: nothing here touches ops, sync or schema.

## Not done

- **B-154's entry in `docs/BUGS.md`** still says the template text goes in "through `onContent`" and
  "the caret ends after the text". This branch may not edit `BUGS.md`; the correction is noted in
  B-360 for the coordinator.
- **`EditorSelection`'s doc comment** (`commands/hosts/editor-host.ts`) still calls its text the
  block's content; since B-101 it is the editing buffer, which is exactly the misreading behind F2.
  Logged unnumbered in the inbox, not changed here (found while fixing F2; a second bug is logged,
  not silently fixed).

## Found in passing, checked, not a bug

- `commitOps` in `BlockTree`'s host checks `props.readOnly` but not the page-property lock
  `readOnly()`. It cannot matter from the editor: a locked tree ends editing and selection, so it is
  never the active host `commitOps` goes to. A `/template` whose picker was open when the lock
  arrived falls back to `applyOps` in `templates.ts` (the "no editor shows the block any more"
  path) and writes into the now-locked page — consistent with the lock being UI-only
  (`docs/spec/markdown-grammar.md` OUT-21a), and not exercised by a test.

## Still unverified

- F4 on paper: the test checks the DOM at `beforeprint` and computed styles under emulated print
  media, and that `page.pdf()` runs; nobody looked at the PDF or at a real print dialog's preview.
  Chromium's `page.pdf()` is assumed to lay out like File > Print (the existing B-221 test makes the
  same assumption).
- F4 highlights: that `::highlight()` backgrounds are painted on paper at all (and so needed
  hiding) was not observed; only their computed style under print media was.
- F3 on other paths to a locked page's history: only the page view with focus on `<body>` was
  driven. The journal stream (one tree per day) and Cmd/Ctrl+Z from the palette go through the
  same `historyEditorHost` → `doUndo`, so the guard covers them by code reading, not by test.
- F1 for templates whose first block itself carries properties (the other case the review named):
  the fix is the same line, but only the `list:: number` bullet was driven in a browser.
- WebKit / the Mac app: nothing here was run outside Chromium.
