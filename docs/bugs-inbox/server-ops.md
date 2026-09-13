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

Second cause, found while fixing B-235 and fixed in its commit: a block with **empty content and
only property lines** (10 such blocks in the owner's graph) still failed, because as the first
bullet of the parsed text it is exactly what the parser reads as a page-properties pre-block (OUT-2)
— no block came back, and its `collapsed` was lost with it. `parseSingleBlockGrammar` now parses
behind a throwaway first bullet (`- -`) and takes the second block. Tests: the round-trip case "an
empty block with only properties, collapsed" in `outline-bridge.test.ts` (failed "content must
describe exactly one block" before) and "edits an empty block that has only a property line (not a
page pre-block)" in `block-update-text.http.test.ts`.

In a browser: `e2e/tests/agent-ops.spec.ts` › "block.update flips TODO to DONE by old_str on a
scheduled task, and the row follows (B-172)". On real data: `tools/probes/single-block-roundtrip-graph.ts`
over a copy of the owner's graph — of 18,628 live blocks, the pre-fix parser refused **1,929** (every
block whose before-text has a second line); now 0 are refused and every block's content, marker,
priority, properties and collapsed survive the round trip, except the 20 blocks that still hold a
literal `SCHEDULED: <…>` line from the pre-B-266 import: re-parsing reads that line as `scheduled::`
(what the same text in a file means), so an `old_str` edit of one of those blocks moves the date into
the property. Those blocks were uneditable this way before; their repair is already an open owner
decision. Real edits through `nooklet serve` on that copy (DONE→LATER→DONE on a scheduled task,
a multi-line block with properties, an empty block with only properties, a fence-first block given a
property then edited inside the fence): all as expected, and `nooklet verify` OK afterwards
(20,442 ops).

---

### B-236 (existing)

**Fixed 2026-09-13.** `packages/server/src/ops/page-update.ts` refuses a journal day only when a
`new_name` is given that differs from the day's name; a properties-only update on a journal applies
its `page.prop` ops like on any page. The op description (and mcp-tools.md's copy) now says a
journal's properties can be set, and the refusal's hint says how. Test that would have caught it:
`packages/server/src/ops/page-update-journal.http.test.ts` — set and unset properties on a journal
day (with rebuild parity), a real rename still refused with nothing written, `new_name` equal to
the day's own name accepted (the first and third failed with "cannot rename a journal day" before
the fix). In a browser: `e2e/tests/agent-ops.spec.ts` › "page.update sets a property on a journal
day (B-236)" (a `read-only:: true` day shows the lock badge).

---

### B-235 (existing)

**Fixed 2026-09-13.** Cause as logged: `prepareMarkdownInsert` kept `parseOutline(...).blocks` and
never looked at `.properties`. `page.append` and `block.insert` dropped a pre-block the same way
(confirmed: both returned 200 with nothing set, before the fix). Now
(`packages/server/src/ops/outline-bridge.ts#prepareMarkdownInsert(…, "accept" | "refuse")`):

- `page.create` on a new page applies the pre-block as `page.prop` ops right after its
  `page.create` op (explicit `properties` win for keys both give), and markdown that is only a
  pre-block creates the page with those properties and no blocks (it used to fail "markdown did not
  parse to any blocks").
- `page.append`, `block.insert` and `page.create` with `if_exists: "append"` on an existing page
  refuse one: 400 `invalid`, "markdown starts with page properties (read-only), which only
  page_create applies", hint pointing at `page_update` and at putting block properties under a
  bullet. Refused rather than applied because an append silently changing the page's own
  properties would be as surprising as dropping them, and a first bullet holding only property
  lines (`- type:: book\n- next`) is a pre-block to the parser — an agent that meant a block needs
  to hear that.

`MarkdownInput`'s description and mcp-tools.md §4.3.8–10 say so. Test that would have caught it:
`packages/server/src/ops/markdown-page-properties.http.test.ts` (7 of its 8 cases failed before the
fix — every one but "still takes block properties under a bullet"). In a browser:
`e2e/tests/agent-ops.spec.ts` › "page.create applies a markdown read-only:: pre-block: the page opens
locked (B-235)". `e2e/tests/read-only.spec.ts`'s `openLocked` still sets the lock through
`properties` with a comment citing B-235; left alone (another branch's spec; it works either way).

An ordering trap met on the way, recorded because the obvious code hits it: minting the block ops
before the `page.create` op (to fold the pre-block into its `properties`) gives the page a later HLC,
`applyOps` sorts by HLC, and every block is rejected for a page that does not exist yet.

---

### B-311 · Pasting outline text with a page-properties pre-block drops those lines
**Status:** open · **Severity:** low · **Found:** 2026-09-13, server-ops (fixing B-235) · **Test:**
none; read, not run

`apps/web/src/editor/paste.ts#pasteMarkdownAsTree` inserts `parseOutline(text).blocks` and never
looks at `.properties`, so pasting `tags:: x\n\n- a\n- b` (or `- type:: book\n- next`, a bulleted
pre-block to the parser) into a block creates `a` and `b` and loses the property lines — the same
silent drop B-235 was on the server. Not fixed here (web editor, outside this branch). Fix
direction: paste has no page to give properties to, so keep such lines as a block of their own
(e.g. insert the pre-block's lines as one block's properties) rather than discard them.

---

### B-312 · A refused `page.append` to a page that does not exist yet leaves that page behind, empty
**Status:** open · **Severity:** low · **Found:** 2026-09-13, server-ops (fixing B-235) · **Test:**
none yet; reproduced with a throwaway vitest probe (not kept — the fix's test replaces it)

`page.append {page: "Fresh", markdown: "- a ^1k7f3q9xz2hav4"}` (an unknown `^id`) answers 400 — and
`SELECT COUNT(*) FROM page` went 1 → 2: `resolvePageRef(…, {create: true})` creates the page (or
journal day) with its own `applyOps` before the markdown is parsed or validated, and nothing rolls
that back when validation throws. Same for a dangling fence / markdown with no blocks, and for
B-235's new pre-block refusal. An agent retrying with fixed markdown gets its blocks on the stray
page, so the visible damage is an empty page (or an empty journal day) when it gives up instead.

---

**Fixed 2026-09-13.** `outline-bridge.ts#checkWriteMarkdown` parses and refuses write markdown
without touching anything; `page-append.ts` calls it before `resolvePageRef`, then hands the checked
tree to `prepareMarkdownInsert`. A `parent` no longer creates the page either (a page that does not
exist holds no parent; 404 as before, nothing written). Test that would have caught it:
`packages/server/src/ops/markdown-page-properties.http.test.ts` › "a refused page.append creates no
page (B-312)" — pre-block, unknown `^id`, unknown `^id` on an unwritten journal day, `parent` on a
missing page; all four failed on the old `page-append.ts` (row counts moved).

---

### B-148 (existing)

**Fixed 2026-09-13.** Both halves of the `/ui/live` protocol, as the entry's fix direction said.
Client: `apps/web/src/live/message-handler.ts#handleIncomingFrame` catches a rejection from
`runCommand` and replies `command.result` `{ request_id, error }` (the thrown message, capped at
1,000 chars; also recorded in the window's activity log), so `socket.ts` sends a reply and there is
no unhandled rejection. Server: `packages/server/src/live/run-remote-command.ts` turns a reply with
`error` into `invalid` — "task.setScheduled failed in window "…": "banana" is not a date …", hint
"change args (or command_id) rather than retrying as is", `details.reason: "command_failed"` —
which `ui_navigate`/`ui_highlight` inherit. mcp-tools.md §4.3.21's Errors list it. Tests that would
have caught it: `apps/web/src/live/message-handler.test.ts` › "answers command.run with
command.result carrying the error when the command throws" and "reports a non-Error throw, and cuts
a huge message to a bounded length" (both failed before: the handler rejected), and
`packages/server/src/live/ui-run-error.test.ts` (ui_run → 400 with the window's reason in well
under the 2 s timeout; same through ui_navigate; a normal result still relayed — the first two
failed before: 200 `unknown_command`). And the real thing, kept this time:
`e2e/tests/agent-ops.spec.ts` › "ui_run with args the command refuses answers invalid with its
reason, not a timeout (B-148)" mints a `write --ui-control` token with the CLI against the run's
data dir, turns control on in a real Chromium window, and sends `task.setScheduled` `"banana"` and
`42` (400 `command_failed` in under 1.9 s each, nothing stored), then a real date (200 `ran`,
stored). With the old `message-handler.ts` built into the client it failed exactly as reported:
500 `internal`, "window … did not respond in time", hint "try again".

---

### B-313 · `block.update` `content` copied from `page_read` for a nested block turns its property lines into text and deletes the properties
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, verifying m9/server-ops · **Test:**
`outline-bridge.test.ts` › "reads `content` copied from page_read at any depth (auto)…",
`block-update-text.http.test.ts` › "takes content copied from page_read for a nested block without
losing its properties (B-313)"

`page_read` prints a block at depth *d* with its later lines indented `2·(d+1)` columns:

```
- a ^…
  - b ^…
    - TODO c ^…
      scheduled:: 2026-09-13
      more c
```

An agent that replaces block `c` with `block.update {content: "TODO c2\n      scheduled:: 2026-09-14\n      more c"}`
— the shape it just read, bullet and `^id` dropped, which mcp-tools.md §3.2 rule 10 now says `content`
accepts — gets 200, and the stored block is `content: "c2\n    scheduled:: 2026-09-14\n    more c"`
with **no** `scheduled` property: `applyTextReplace` unsets every key the parsed text lacks. B-172's
`"auto"` reading only recognises page_read's shape for a top-level block (it leaves the lines as
they are and lets the parser strip one 2-column continuation indent; 4 or 6 columns stay behind, and
an indented `key:: value` line is not a property line). Not new — the pre-B-172 parser
(`parseOutline("- " + text)`) produced the identical block, checked with a throwaway tsx probe —
but a silent data loss on the path the branch documents. Fix direction: under `"auto"`, remove the
later lines' common leading whitespace rather than assuming exactly one 2-column unit.

**Fixed 2026-09-13.** `outline-bridge.ts#singleBlockBullet` under `"auto"` removes the common
leading whitespace of the later non-blank lines (then indents them like flush text); a mix with no
common prefix (`"  a"` / `"\tb"`) keeps the old one-unit reading. Both tests failed on the branch
before the change (the HTTP one: stored `"c\n    scheduled:: 2026-09-20\n    more c"`, no property).
Measured on a copy of the owner's graph with `tools/probes/block-update-content-indent-graph.mts`
(every live block as `page_read` prints it at depth 0/1/2, copied into `content`): the one-unit
reading changed the properties of **866** blocks at depth 1 and 2; the common-prefix reading
changes none at any depth. Its cost: 14 blocks whose every later line carries its own indent
(e.g. a packing list indented three spaces) lose that indent when copied — whitespace, where the
one-unit reading lost the same whitespace at depth ≥ 1 plus properties. mcp-tools.md §3.2 rule 10
updated.

---

### B-314 · `block.update` `old_str` on a block's `collapsed:: true` line answers 200 and changes nothing
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, verifying m9/server-ops · **Test:**
`block-update-text.http.test.ts` › "folds and unfolds a block by editing its collapsed:: line with
old_str (B-314)"

`before` (and so the text `old_str` matches) renders a collapsed block as `parent\ncollapsed:: true`.
`block.update {old_str: "\ncollapsed:: true", new_str: ""}` → 200, and `block.read` still says
`collapsed: true`; adding the line to an expanded block → 200, still expanded (checked with a
throwaway vitest file against `makeTestServer`). `applyTextReplace` writes content, marker, priority
and properties from the parsed text and never looks at `node.collapsed`. Newly reachable: before
B-172 every collapsed block (its before-text has a second line) was refused outright. Fix
direction: in the `old_str` path only — where the before-text carries the line, so a change in the
parsed `collapsed` can only be the agent's edit — write `block.prop collapsed`; `content` stays as
it is (an agent's full text rarely repeats the line, and reading its absence as "expand" would
unfold blocks nobody asked to).

**Fixed 2026-09-13.** `block-update.ts`: the `old_str` path writes `block.prop collapsed` when the
edited text's `collapsed` differs from the block's; `content` is unchanged (the test also pins that
a `content` without the line leaves a folded block folded). The test failed before the change
("expected true to be false").
