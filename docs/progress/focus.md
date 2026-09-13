# M9 progress — focus (B-161, B-195, B-231, B-147, B-203)

Resilience log, updated after every meaningful step. If you are reading this after a restart:
read "Next steps" and continue from there.

Branch `m9/focus`, worktree `<repo>/.claude/worktrees/wf_e473942f-106-6`, based on
`cf08d19`. E2E port 6401. Bug entries go to `docs/bugs-inbox/focus.md` (new numbers B-290..B-299),
never `docs/BUGS.md`. Scratch: `/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m9/focus/`
(`burn.sh N` / `unburn.sh` start and stop N busy node loops for "under load" runs).

Brief, in order: B-161 (palette Escape leaves the editor unfocused — find the timing-dependent
refocus, make product and test deterministic, prove with a loop under artificial CPU load before
and after); B-195 (Move to page… onto its own page while editing); B-231 (press on a context-menu
separator/padding ends editing); B-147 (date picker type-ahead and keydown-less text); B-203
(Alt+Enter under Playwright on macOS: real bug or harness artifact).

## 1. Done (committed)

- **B-161 + new B-290** — `d69414f` "fix(web): the palette gives focus back when it closes; a late
  frame no longer steals it (B-161, B-290)". Web unit 1005/1005 after the commit. Diagnosis: nothing gave
  focus back when the palette closed; the test passed only when `surface.attach`'s
  requestAnimationFrame backstop (armed by the click that entered editing) landed after Escape —
  i.e. on a machine loaded enough for frames to lag input. The same backstop stole focus from an
  open palette (B-290). Files: new `apps/web/src/commands/focus-return.ts` (+ `.test.ts`), hookup in
  `commands/palette/CommandPalette.tsx`, backstop guard in `editor/surface.ts`, new
  `e2e/helpers/focus.ts#delayAnimationFrames`, `e2e/tests/views.spec.ts` test made deterministic,
  new `e2e/tests/focus-return.spec.ts` (4 tests), probe `tools/probes/palette-escape-focus.spec.ts`.
  Numbers: see the inbox entry. Broad e2e (19 specs): 214 passed, 1 skipped. Typecheck clean.

- **B-195** — `8d08778` "fix(web): the Move to page picker gives focus back when it closes (B-195)". `app/refactor-host.tsx#pickPage` uses `rememberFocus`; two e2e tests in
  `focus-return.spec.ts` (context menu path, palette path), both failed on `cf08d19`'s
  refactor-host. focus-return + refactor + context-menu + editing-row-leaves: 29 passed, 1 skipped.

- **B-231** — `78dc611` "fix(web): a press anywhere in the context menu keeps editor focus (B-231)". `onMouseDown` preventDefault on `.ctx-menu`; e2e in
  `focus-return.spec.ts`. Note: `biome check` reports a pre-existing `useSemanticElements` error on
  the `.ctx-sep` div (present at `cf08d19`, like several others repo-wide) — left alone.

- **B-147 (type-ahead + insertText) and new B-291 (composition, open, owner's call)** — commit
  `f4d63d9` "fix(web): the date picker takes keys typed before it listens, and text with no
  keydown (B-147)". New `commands/date-picker/type-ahead.ts` (+ test); hookups in
  `date-picker/host.ts` (hold starts in `open()`) and `DatePicker.tsx` (shared key reading,
  `beforeinput`, replay after render). e2e `date-picker-type-ahead.spec.ts` (4; chunk delayed with
  `page.route`, service workers blocked) failed on `cf08d19`; probe
  `tools/probes/date-picker-composition.spec.ts` shows composition still lands in the block.
  Broad e2e (13 specs): 133 passed. Date-picker unit: 47/47.

- **B-203 diagnosis** — REAL bug, not the harness (probe `tools/probes/alt-enter-follow-link.spec.ts`,
  entry in the inbox). Arrowing into a link opens the `[[` autocomplete; the global keymap yields
  every Enter to it, Alt+Enter included, and the editor never offers the popup modified keys.

  Diagnosis commit `6d5fff7`.
- **B-203 fix** — `990d14e` "fix(web): Alt+Enter follows a link while the autocomplete is open
  (B-203)". `commands/popup-keys.ts` (`editorFed` claims,
  `popupTakesKey`), `keymap/dispatch.ts` step 2, `provider/CommandProvider.tsx`,
  `AutocompletePopup.tsx`/`SlashMenu.tsx` claim `editorFed`, spec R12 step 2 note. e2e
  `follow-link-popup.spec.ts` (2), unit `popup-keys.test.ts` (4) + a dispatch test. Commands unit
  409/409. Broad e2e (16 specs): 176 passed, 1 skipped, 1 failed — editing.spec "typing immediately
  after Enter" at load ≈16-30; passed on rerun of the same spec sequence (112/112), and a late-frames
  copy of it under 16 busy loops passed 5/5. Logged B-292 (that spec cannot `--repeat-each`).

- **Final verification (on `990d14e`)** — web unit 1022/1022 (126 files); `pnpm -r typecheck`
  clean. Full Chromium e2e, all 79 specs in three runs on port 6401 (one server per run, the
  spec order of a full run): 146 passed + 1 skipped + 2 failed / 163 passed / 141 passed + 1
  skipped. The 2 failures were `editing.spec.ts` "types a whole sentence…" (`openJournal`'s
  `virtualDraft.blur()` timed out on a textarea that had already detached) and "Enter creates a
  second bullet…" (row count, B-233's journal-state shape); the same 15-spec sequence re-run
  straight after: 70 passed, 1 skipped. So 452 of 452 non-skipped tests passed on first run or
  its one rerun (439 at base + 13 new). WebKit project (storage.spec) not run — nothing here
  touches storage.

## 2. In flight

(nothing)

## 3. Next steps / left for others

1. B-291 (composed text into the block behind the date picker): owner's call — keep "editor keeps
   focus", or have the picker own focus with a hidden input and give it back on close.
2. B-292: give `editing.spec.ts` "typing immediately after Enter" a page per repeat (not this
   branch's spec).
3. Not asked, noticed: walking the caret into an existing `[[link]]`/`#tag` opens the
   autocomplete at all — whether it should is a UX question, not logged as a bug.
4. `biome check .` reports pre-existing errors at `cf08d19` (e.g. `BlockContextMenu.tsx`
   `useSemanticElements` on `.ctx-sep`, `BlockRowView.tsx`, `DiagnosticsPanel.tsx`,
   `packages/plugin-api` `noConfusingVoidType`) — untouched.

## 4. Decisions

- Focus return is synchronous and owns no timers — the whole point is that the next input event
  already finds focus back, whatever the machine load.
- `rememberFocus` lives in `commands/` (plain DOM, no editor import) so the palette can use it
  without breaking the command package's host-agnostic seam; `.cm-content` is one element
  re-parented between rows, so `isConnected` == still editing.
- Frame-timing bugs are tested by delaying frames on purpose (`delayAnimationFrames`), not by
  hoping the machine is loaded.

## 5. How to resume

`git switch m9/focus` in the worktree; `pnpm install --frozen-lockfile --prefer-offline`; read
this file and `docs/bugs-inbox/focus.md`.
