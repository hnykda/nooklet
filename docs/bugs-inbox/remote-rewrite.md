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
offered version is not recorded as known (if the typing's write still loses to it, the next refetch
takes it — the editor never shows text the database does not hold), and the editor clock absorbs its
HLC (`Clock.receive`, `editor/clock.ts`) so the typing's write is newer even when the other writer's
clock runs ahead — without that, a tab 20 s behind lost the kept typing to "theirs" (e2e below); a
dismissed version is not offered again. "Use the other
version" writes the other text as one undo step (Cmd/Ctrl+Z puts the typing back) and drops the
unwritten keystrokes rather than writing them first. Caret: `mapThroughRewrite` — before the changed
span it stays, after it keeps its distance from the end, at the very end it stays at the end.

"Turn into page" no longer ends editing first (`commands/registrations/refactor.ts#leaveEditing`
removed): the editor shows `[[First line]]` and typing continues after it. Removing it exposed what
the workaround also did — flush the keystrokes still inside the 500 ms debounce before the server op
(the context menu keeps focus in the editor, so nothing else flushed them). `refactor-host.tsx`'s
`write` now calls `editor/outline-registry.ts#flushTyping` before its push.

Tests: `e2e/tests/remote-rewrite.spec.ts` (10): an agent's `block.update` with nothing typed; with an
edit before the caret; with unsaved typing then "Use the other version" (Cmd/Ctrl+Z brings the typing
back, redo takes it again); with unsaved typing then leaving the block; with unsaved typing then
"Keep mine" while typing continues through another refetch; "…the typing is kept even when this
tab's clock runs behind" (`page.clock.setFixedTime(now − 20 s)`; failed before `Clock.receive` with
the stored text `"theirs"`); a second browser context (its own
replica and device) with nothing typed and with unsaved typing; "Turn into page" on the edited row
with typing inside the debounce; and "typing straight on after Tab is never offered back as a change
from elsewhere". Run against the old code, the first seven written all failed (the clean cases showed
`"original text"` / `"shared start"` where the rewrite was, the unsaved cases never showed a notice,
"Turn into page" ended editing); "leaving the block" was added later and waits for a notice the old
code never shows (not run against it). Two guard the new comparison itself, mutation-checked
2026-09-13 (2/2 failing each): "Keep mine…" with the verdict's `hold` removed, and "…after Tab…" (which
passes on the old code) with this tree's own writes left unrecorded.
`apps/web/src/editor/remote-text.test.ts` (17) › "a refetch that read before this tab's own write is
not a remote change" and the rest of the verdict table, plus `mapThroughRewrite`;
`apps/web/src/editor/outline-registry.test.ts` › "typing flush (B-192)";
`apps/web/src/commands/registrations/refactor.test.ts` › "neither block command ends edit mode".

---

### B-460 · A property changed elsewhere on the block being edited stays stale in the editor until editing ends
**Status:** open · **Severity:** low · **Found:** 2026-09-13, m11/remote-rewrite (fixing B-192) ·
**Test:** none (probe `tools/probes/remote-property-while-editing.spec.ts`)

Put the caret in a block with a property line (`owner:: alice`). An agent's `block.update` with
`properties: {owner: "bob"}` — or another device editing that line — lands: the server has `bob`,
other rows refetch, and the editor still shows `owner:: alice`. Typing on line 1 does NOT write
`alice` back (the flush writes only the fields the typing changed); the row shows `bob` once editing
ends. Editing the property line itself would, by reading `flushPendingEdit` (not probed), write the
old value plus the edit over `bob` — the same shape as B-192 before its fix.

Cause: B-192's fix tells a newer write by `content_hlc`, and a `block.prop` write leaves it alone.
The buffer holds the editable properties too (B-101), but the page tree the worker returns carries
their values and not their HLCs (`db/worker-core.ts#collectPageProperties`). A fix: return the
newest `block_prop.hlc` per block with the tree and compare `max(content_hlc, that)` in
`editor/remote-text.ts`, recording this tree's own `block.prop` writes for non-reserved keys (a
marker or date op writes a block column, not `block_prop`, and must not count).

---

### B-461 · With this tab's clock behind, typing on a text written elsewhere is silently lost
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, m11/remote-rewrite verification
pass (adversarial e2e) · **Test:** none yet

Tab clock 20 s behind the server (`page.clock.setFixedTime(now − 20 s)`). Put the caret in
`original`; an agent's `block.update` makes it `rewritten`; the editor takes it (B-192). Type
` more`: the editor shows `rewritten more`, the server keeps `rewritten` (polled 15 s). The same
happens without B-192's take path — the row shows the agent's `rewritten`, click into it and type
` more`: stored stays `rewritten` (probe run 2026-09-13, same setup). In real use the window is the
skew (≤ 60 s, `HLC_MAX_DRIFT_MS`), and nothing on screen says the typing was dropped.

Cause: the editor's clock (`editor/clock.ts`) is a `new Hlc(deviceId)` that only follows wall time;
it never absorbs an HLC it has seen. Every keystroke's `block.text` is stamped below the other
writer's `content_hlc`, and `applyBlockText` drops it as stale. B-192's fix made it absorb the HLC
of an OFFERED version (`Clock.receive`, 99f54ff) but not of a taken one, nor of any text the tree
shows.

---

### B-462 · An agent flipping the task marker while you type offers your own untyped text as "the other version"
**Status:** open · **Severity:** low · **Found:** 2026-09-13, m11/remote-rewrite verification pass
(adversarial e2e) · **Test:** none yet

Type into `TODO call the plumber`; meanwhile an agent runs `block.update {old_str: "TODO", new_str:
"DONE"}` — the flip `block_update`'s own description recommends. The pill turns DONE and the row
says "This block changed elsewhere." with **Use the other version**, whose text is `call the
plumber`: the text as it was before the typing. The text did not change elsewhere; taking "the
other version" only throws the typing away (screenshot in the verification run:
`e2e/test-results/6412/remote-rewrite-edges-an-ag-…/test-failed-1.png`).

Cause: `block.update` with `content` or `old_str`/`new_str` always writes a `block.text` (plus
`marker`/`priority` props), even when the content is unchanged, so `content_hlc` moves. B-192's
verdict (`editor/remote-text.ts#decide`) sees a newer `content_hlc` whose text differs from the
buffer (the buffer has the typing) and offers it — it never asks whether the other writer changed
the text the typing started from.
