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
- commit "test(e2e): remote-rewrite page names per repeat": `--repeat-each=3` 21/21.

## 2. In flight

- Spec update (next step 1).

## 3. Next steps, in order

1. (done) Property-only probe → B-460 logged, open; probe `tools/probes/remote-property-while-editing.spec.ts`.
2. Spec: `docs/spec/commands-and-keymap.md` R32b ("Both leave editing first" is wrong now) + a rule
   for rewrites from elsewhere.
3. Real graph: copy `~/.nooklet/default/graph.sqlite`, serve, edit a journal block while an API
   `block.update` rewrites it (clean and typing); `pnpm nooklet verify` (no ops/schema touched).

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
