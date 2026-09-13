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

- nothing yet

## 2. In flight

- Design (below), then `apps/web/src/editor/remote-text.ts` + unit tests.

## 3. Next steps, in order

1. `editor/remote-text.ts`: `TextVersions` (per-block HLC bookkeeping, verdict keep/take/offer/hold)
   and `mapThroughRewrite` (caret). Unit tests incl. the stale-read case.
2. `BlockTree.tsx`: record writes (commit, applyHistoryStep, flushPendingEdit, initialOps), note
   shown HLCs in the tree effect, act on the verdict for the edited block; notice state.
3. Notice UI (`RemoteChangeNotice.tsx`, rendered by `BlockRowView`).
4. Remove `leaveEditing` from `commands/registrations/refactor.ts`; flush typing before a server
   refactor op instead (`outline-registry.ts#flushTyping`, called by `refactor-host.tsx#write`).
5. E2E `e2e/tests/remote-rewrite.spec.ts`: two browser contexts + agent `block.update`, clean and
   unsaved-typing cases; Turn into page on the edited row.
6. Spec R32b + a new rule; inbox entry B-192 (existing); sweep of editing specs; verify on real graph.

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
