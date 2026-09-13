# Bug inbox — remote-rewrite (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-460..B-469.

---

### B-192 (existing)

**Fixed 2026-09-13.** Owner-approved behaviour: with no unsaved typing the editor takes the other
text, the caret mapped through the change; with unsaved typing the typing stays and the row says
"This block changed elsewhere." with **Use the other version** and **Keep mine**.

Stale read vs newer write is decided by HLC, not timing (`apps/web/src/editor/remote-text.ts`,
`TextVersions`). `BlockTree` records the HLC of every `block.text`/`block.create` op it writes
(`commit`, `flushPendingEdit`, undo/redo, `initialOps`) and of every fetched text it puts on screen
(not one an unanswered write stands in for). A fetched `contentHlc` newer than all of those is a
write the database kept over anything this tree wrote — last-writer-wins on `content_hlc` — so it is
from elsewhere; a refetch that read before this tree's own write carries an older one and the buffer
wins, as B-66 needs. "Unsaved typing" is a pending edit that `flushPendingEdit` would still write. An
offered version is not recorded as known, so if the typing's write later loses to it (a clock ahead
of this one) the next refetch takes it; a dismissed one is not offered again. "Use the other
version" writes the other text as one undo step (Cmd/Ctrl+Z puts the typing back) and drops the
unwritten keystrokes rather than writing them first. Caret: `mapThroughRewrite` — before the changed
span it stays, after it keeps its distance from the end, at the very end it stays at the end.

"Turn into page" no longer ends editing first (`commands/registrations/refactor.ts#leaveEditing`
removed): the editor shows `[[First line]]` and typing continues after it. Removing it exposed what
the workaround also did — flush the keystrokes still inside the 500 ms debounce before the server op
(the context menu keeps focus in the editor, so nothing else flushed them). `refactor-host.tsx`'s
`write` now calls `editor/outline-registry.ts#flushTyping` before its push.

Tests: `e2e/tests/remote-rewrite.spec.ts` (7; all 7 fail on the old code — the clean cases showed
`"original text"` / `"shared start"` where the rewrite was, the unsaved cases never showed a notice,
"Turn into page" ended editing): an agent's `block.update` with nothing typed, with an edit before
the caret, with unsaved typing then "Use the other version", with unsaved typing then "Keep mine";
a second browser context (its own replica and device) with nothing typed and with unsaved typing;
"Turn into page" on the edited row with typing inside the debounce.
`apps/web/src/editor/remote-text.test.ts` (17) › "a refetch that read before this tab's own write is
not a remote change" and the rest of the verdict table, plus `mapThroughRewrite`;
`apps/web/src/editor/outline-registry.test.ts` › "typing flush (B-192)";
`apps/web/src/commands/registrations/refactor.test.ts` › "neither block command ends edit mode".
