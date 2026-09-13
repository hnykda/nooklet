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
- next commit (spec + tests): `commands-and-keymap.md` R32b corrected ("Both leave editing first"
  was wrong), R51b added; `remote-rewrite.spec.ts` now 9 tests (undo/redo of the take, leaving the
  block, Keep mine through a refetch while still typing, own writes after Tab never offered).
  Mutation checks: `hold` removed → Keep mine fails 2/2; own writes unrecorded → the Tab test fails
  2/2, while editing/focus/undo-redo/journal-day-start (46 tests) did NOT catch that mutation.
  `--repeat-each=2`: 18/18.

## 2. In flight

- Real-graph check (next step 1).

## 3. Next steps, in order

1. Real graph: copy `~/.nooklet/default/graph.sqlite`, serve, open a journal day with Czech text,
   edit a block while an API `block.update` rewrites it (clean and typing); `pnpm nooklet verify`
   (no ops/schema touched, cheap).
2. Final: web unit + typecheck + biome; rerun editor e2e chunks once more.

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
