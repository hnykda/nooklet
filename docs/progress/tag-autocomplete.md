# B-380 — no `#` autocomplete inside an existing tag (owner option c)

## Status: done (one commit on branch `worktree-agent-aa4a26c6b54a87399`, see `git log`)
- [x] Worktree branch fast-forwarded from a stale base (41666ee) to main `fd779f4` before starting.
- [x] `trigger.ts#matchTagTrigger(before, after = "")` returns null when the text after the caret
      continues the tag (`continuesTag`).
- [x] `app/CommandLayer.tsx` onKeyUp passes `sel.content.slice(sel.start)`.
- [x] Unit tests (`trigger.test.ts`, describe "matchTagTrigger — caret inside an existing tag (B-380)", 3).
- [x] e2e `e2e/tests/autocomplete-inside-tag.spec.ts` (4); spec R57 in `docs/spec/commands-and-keymap.md`.

## Design
The caret is "inside a tag" when the run after the caret, up to the next `TAG_STOP` character or
whitespace/newline (copy of `packages/core/src/tokens.ts`'s set — that file forbids new exports), is
still non-empty once trailing `.!?:` are stripped (the tokenizer's `TAG_TRAILING`). So `#ta|g`
stays closed; `#ta|`, `#ta| x`, `#ta|.`, `#ta|]]` open. Cost accepted by the owner: `#` typed
straight before a word (`alpha #Wa|omega`) no longer opens the popup either. `#[[multi word]]` is
untouched (`[[` popup takes precedence; an auto-paired `]]` after the caret is a stop anyway).

## Verification (2026-10-03)
- e2e test 1 ("walking into an existing #tag opens no popup…") red with the CommandLayer argument
  removed (`.cmd-popup` count 1), green with it. Tests 2–4 green both ways (guards).
- `pnpm --filter @nooklet/web test`: 162 files / 1386 tests passed. `pnpm -r typecheck`: exit 0.
  `pnpm exec biome check . --diagnostic-level=error`: clean.
- e2e `autocomplete* popups* editing*` (7 specs): 65 passed, 1 failed — the B-382 test in
  `autocomplete-inside-link.spec.ts`, which is the already-logged B-592 (fails on main too).

## BUGS.md updates to fold in

Replace B-380's status/test lines and append:

```
### B-380 · Enter on the `#` autocomplete that walking into an existing `#tag` opened duplicates the tag's tail
**Status:** fixed (owner chose option c) · **Severity:** low · **Found:** 2026-09-13, fixing B-294 ·
**Test:** `e2e/tests/autocomplete-inside-tag.spec.ts`; probe `tools/probes/autocomplete-tag-walk.spec.ts`

(original description unchanged)

**Fixed 2026-10-03 (option c).** The tag popup no longer opens when the text after the caret
continues the tag: `commands/autocomplete/trigger.ts#matchTagTrigger` takes the text after the
caret (passed by `app/CommandLayer.tsx`'s keyup re-detection) and refuses when the run up to the
next tag stop (whitespace, `, ; ) ] } ' "`), less trailing `.!?:`, is non-empty — the same rule
as `core/tokens.ts`. Enter there is a plain Enter (splits the block). Cost, as accepted: `#` typed
straight before a word (`#Wa|omega`) gets no popup either. Caret at the end of a tag, a fresh
`#ta`, and `#[[multi word]]` still open it. **Test:** `e2e/tests/autocomplete-inside-tag.spec.ts`
"walking into an existing #tag opens no popup, and Enter does not duplicate its tail (B-380)" — red
before (popup count 1), green after; three guards (caret at a tag's end, fresh `#tag`, `#[[`) green
before and after. Unit: `trigger.test.ts` "matchTagTrigger — caret inside an existing tag (B-380)" (3).
Spec R57 updated.
```

New bugs: none found.
