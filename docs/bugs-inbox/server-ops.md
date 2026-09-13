# Bug inbox — m9/server-ops

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-310..B-319.

---

### B-310 · A task block whose content opens with a code fence loses its marker in the mirror, and its code in `ids: "none"` text
**Status:** open · **Severity:** low · **Found:** 2026-09-13, server-ops (fixing B-151) ·
**Test:** none yet; `tools/probes/fence-first-task-roundtrip.ts` reproduces it

A block `{marker: "TODO", content: "```js\n- not a bullet\n```", properties: {foo: "bar"}}` with a
child (the store can hold one: `block.update {content: "TODO ```js\n…"}` writes exactly that):

- **With ids (the mirror):** OUT-14 writes `- ^id` alone on line 1 and the content from line 2 —
  and drops the marker/priority head entirely. Re-parsed: `marker: null`. The mirror is meant to be
  lossless.
- **Without ids:** `- TODO ```js` goes out on line 1, but the parser checks for an opening fence on
  the raw line (marker still attached), so no fence opens: `- not a bullet` becomes a second child,
  and the content comes back as `"```js"` alone.

Not in the owner's graph today (29 blocks open with a fence, none has a marker or a property —
checked on a copy, 2026-09-13), which is why nothing showed it. Fix direction (not done here — it
is the core parser and OUT-14's shape, both beyond this branch's bugs): the parser should look for
an opening fence after stripping marker/priority, and OUT-14 needs a form that keeps the head (for
example `- TODO ^id` alone on line 1), with markdown-grammar.md updated to match.

---

### B-151 (existing)

**Fixed 2026-09-13.** `packages/core/src/outline.ts#serializeOutline`: a block with no id to put
alone on line 1 (OUT-14), no marker/priority, and a line 1 that opens a fence now gets its property
lines after the content when every fence in it closes (`fencesClosed`, the parser's own fence
tracking), otherwise as the bullet line itself (`- foo:: bar`, the fence opening on line 2) — the
two placements `block-text.ts#joinBlockText` already used. Both parse back with no parser change
(the parser takes a property line anywhere outside a fence); markdown-grammar.md OUT-18 records the
exception. Blocks with an id (the mirror) are unchanged. Tests that would have caught it:
`packages/core/src/outline.test.ts` › "a block that opens with a fence, without ids (B-151)" (closed
fence with a property-looking line inside and `collapsed`, unclosed fence, and no-properties
unchanged). `tools/probes/serialize-fence-props.ts` now prints the properties back for both modes.
Found in passing: B-310 (the same block with a marker).

---

### B-172 (existing)

**Fixed 2026-09-13.** Cause confirmed as logged: `parseSingleBlockGrammar`
(`packages/server/src/ops/outline-bridge.ts`) put `- ` before line 1 only, so the flush-left lines
`renderSingleBlockText` writes (the `before` text) parsed as top-level blocks of their own. It now
builds one real bullet (`singleBlockBullet`): the continuation indent goes before every later
non-empty line. Two readings, chosen by the caller (`block-update.ts`): `old_str`/`new_str` edit
the `before` text, which is always flush (`"flush"` — any indent is the content's own);
`content` is `"auto"` — flush, unless every later non-blank line starts with two spaces or a tab,
which is `page_read`'s shape and the only multi-line shape `content` parsed before (kept working
so an agent's indented `scheduled::` line does not silently become text; the cost, recorded in
mcp-tools.md §3.2 rule 10: a content whose every later line really starts with two spaces loses
them). Tests that would have caught it: `packages/server/src/ops/outline-bridge.test.ts` ›
"single-block text round trip (B-172)" (render → parse for property lines, `done::` + priority,
multi-line, an indented line, a fence holding `- x` and `key:: v`, a fence-first block with a
property, `collapsed`; marker flip; both readings; nested bullets still refused — 11 of its 13 fail
on the old code), and `packages/server/src/ops/block-update-text.http.test.ts` (the real route:
TODO→DONE by `old_str` with `scheduled::`, DONE→TODO clearing `done::`, second-line edit, edit
inside a fence, fence-first block with a property, flush and indented `content`, nested bullet
hint, rebuild parity). `tools/probes/block-update-property-roundtrip.ts` now prints "ok" for all
three cases. `e2e/tests/journal-agenda.spec.ts`'s `properties: { marker: "DONE" }` workaround is
left as it is (it works either way).

---
