# Progress — remote-rewrite (B-192: a rewrite from elsewhere of the block being edited)

Branch `m11/remote-rewrite` from `52e5d20`, worktree
`<repo>/.claude/worktrees/wf_975bcd44-fae-3`. E2E port **6412**. Scratch:
`/private/tmp/claude-501/-Users-dan-work-vrite/aefea7d2-a93f-49e0-b7cc-b14be2c3a1c0/scratchpad/m11/remote-rewrite/`.
Bugs go to `docs/bugs-inbox/remote-rewrite.md` (NOT `docs/BUGS.md`), new numbers B-460..B-469.

Owner-approved behaviour (task brief, 2026-09-13): no unsaved typing → the editor takes the remote
text, caret kept sensibly; unsaved typing → local text kept, a small dismissible "This block
changed elsewhere" notice on the row with a way to take the other version. Stale read vs newer
write decided by HLC (`content_hlc` against this tab's last text write), never by timing.

## 1. Done (committed)

- `0badd3a` (B-192): `editor/remote-text.ts`
  (+17 unit tests), `BlockTree.tsx` (verdict in the tree effect, writes recorded, offer signal,
  `takeRemoteText`/`takeRemoteOffer`, typing-flush registration), `RemoteChangeNotice.tsx` + css,
  `BlockRowView.tsx` (`remoteChange` prop), `surface.ts` (`replaceContent` selection arg),
  `outline-registry.ts#flushTyping` (+1 test), `refactor-host.tsx` (flush before push),
  `refactor.ts` (`leaveEditing` removed; test rewritten), `e2e/tests/remote-rewrite.spec.ts` (7, all
  red on base, all green after), inbox entry. Web unit 1156/1156, typecheck clean.
- Whole e2e suite on 6412 in five chunks + storage: 543 tests, 541 passed, 2 skipped, 1 failure
  (`views.spec.ts` "the sidebar toggles with Cmd/Ctrl+\…") that passed on rerun (29/29) — load.
- `a628fb9` test(e2e): remote-rewrite page names per repeat: `--repeat-each=3` 21/21.
- `f824ee9` B-460 logged, open (a property-only rewrite stays stale in the editor until editing
  ends); probe `tools/probes/remote-property-while-editing.spec.ts`.
- `47f9859` (spec + tests): `commands-and-keymap.md` R32b corrected ("Both leave editing first"
  was wrong), R51b added; `remote-rewrite.spec.ts` now 9 tests (undo/redo of the take, leaving the
  block, Keep mine through a refetch while still typing, own writes after Tab never offered).
  Mutation checks: `hold` removed → Keep mine fails 2/2; own writes unrecorded → the Tab test fails
  2/2, while editing/focus/undo-redo/journal-day-start (46 tests) did NOT catch that mutation.
  `--repeat-each=2`: 18/18.
- `45029a3` Real graph (copy of `~/.nooklet/default/graph.sqlite` via `.backup`, served on 6413, killed after):
  `tools/probes/remote-rewrite-real-graph.mjs` on 2026-08-17 (20 rows, Czech block
  `[[@Robin]] co juli jí, jídlo, dieta`) — all 7 checks ok, no console errors (first run's 3 FAILs
  were the probe reading DOM text where live preview hides `[[ ]]`; fixed in the probe).
  `pnpm nooklet verify` on the copy: 20484 ops replayed, OK.
- `99f54ff` (skew): "Keep mine" under clock skew lost the typing — the editor clock never observed
  the offered HLC. Optional `Clock.receive` (`types.ts`, `clock.ts`), called on an "offer" in
  `BlockTree`. E2E "…kept even when this tab's clock runs behind" (`page.clock.setFixedTime`, 20 s
  behind) red before (stored `"theirs"`), green after. Device-dirty test's B-row check now reads
  `.vr-block-view`: one run at load average ~100 showed a `conflict_copy` chip (a keystroke gap
  outlasted the debounce and the sync layer's ADR 003 merge kept A's text) — rerun 20/20.
  Spec 10/10; web unit 1156/1156.

- Final sweep after `99f54ff`: 17 editor-related specs, 130 passed, 1 skipped.

## 2. In flight

- Nothing. Branch complete.

## 3. Not done / left open

- B-460 (logged, open): a property-only write from elsewhere stays stale in the editor until editing
  ends; needs the tree to carry `block_prop` HLCs (worker change) — left, as asked, for a later pass.
- Not covered: undo/redo while a notice stands (the step is recorded; not tested); the notice on a
  phone layout (not looked at); WebKit (the suite's WebKit project runs only `storage.spec.ts`).
- Pre-existing, not mine: `biome check` reports `noStaticElementInteractions` on
  `BlockRowView.tsx`'s row `<div onContextMenu>` on base `52e5d20` as well.

## Design notes

- "Known" HLC per block = max(HLC of text the screen/editor took from a fetch, HLC of every text
  op this tab wrote — `block.text`, `block.create`). A fetched `contentHlc` greater than that is a
  write the database holds and this tab never saw: LWW means the database's text is not ours.
  A refetch that read before this tab's own write carries an older `contentHlc` → not remote.
- A fetched row whose text is overridden by `unansweredText` is NOT noted as shown.
- Unsaved typing = a pending (unflushed) edit on the block whose payloads are non-empty (same test
  `flushPendingEdit` uses), so the no-op pending edit `replaceContent` streams does not count.
- Offered-but-not-taken versions are tracked separately, so a dismissed notice does not come back
  on every refetch, and a flush that loses LWW (skew) still gets taken on the next clean refetch.

## Verification pass (2026-09-13, second agent)

Scratch `…/scratchpad/m11/remote-rewrite-verify/`, same port 6412.

- Re-ran on d54fd48: `remote-rewrite.spec.ts` 10/10; web unit 1156/1156.
- Adversarial spec `e2e/tests/remote-rewrite-edges.spec.ts` (7). Against d54fd48, two failed and
  were logged before fixing: B-461 (tab clock 20 s behind: typing on a taken text, or on a text the
  row showed and was then clicked into, is dropped as stale — stored stayed `rewritten`) and B-462
  (an agent's `old_str: TODO → new_str: DONE` while typing showed the notice offering the untyped
  text). Passed on d54fd48 as well: undo while the notice stands, a second tab of the same browser,
  Czech text on a namespaced page with the caret mid-text, a block with a property line.
- Fix (one commit after 58597fa): `BlockTree#absorbFetchedHlcs` (every fetch's newest
  `content_hlc` into the editor clock, replacing the offer-only receive) and `decide`'s
  `sameAsBeforeTyping` → `untouched`. Both specs 17/17; mutation of each fix fails its tests
  (4/4 with both mutated); web unit 1158/1158; `pnpm -r typecheck` clean.
- `a1e3995` B-461/B-462 fix. Regression after it on 6412: editing, focus, undo-redo, redo,
  undo-gaps, remote-device, refactor, editing-row-leaves 64/64; journal-stream-editing,
  journal-day-start, journal-draft-sync, template-undo, templates, block-properties,
  merge-keeps-fields, reload-durability, context-menu, tasks 62 passed + 1 skipped; autocomplete,
  autocomplete-busy-replica, selection, replace-stale, trash-conflict, dates, connectivity,
  agent-ops, popups, a-fresh-journal, history, history-later-edits 98/98.
- B-463 (logged 814be5a): a take under an open `[[` popup garbled the pick (`ALPHA BETA sZz Target
  Page]]z Tar` written). Fix: an editor-fed popup counts as unsaved in the verdict → offered. Test
  in the edges spec, red before. Then remote-rewrite ×2 specs + autocomplete, autocomplete-busy,
  commands, context-menu, refactor, popups: 93 passed, 1 skipped; web unit 1158/1158; typecheck.
- Phone width (390 px, scratch run, not kept): the notice wraps inside the row (330 px wide, no
  horizontal scroll); "Use the other version" works there.
- Next: real-graph copy — the author's probe with these fixes, then `pnpm nooklet verify`.
