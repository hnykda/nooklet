# Bug inbox — mirror-escape (M11)

Entries in `docs/BUGS.md`'s format, for the coordinator to fold in. New numbers B-470..B-479.

---

### B-342 (existing)

**Fixed 2026-09-13** (owner chose option 2, the serializer escape; branch `m11/mirror-escape`).
`packages/core/src/outline.ts`: a content line outside a fence that the parser would take out of
the text by its shape — a property line, a `SCHEDULED:`/`DEADLINE: <…>` line, a `:LOGBOOK:`
opener — is written with a backslash before the colon that makes the shape
(`scheduled\:: 2026-09-20`, `SCHEDULED\: <…>`, `\:LOGBOOK:`), and read back with one backslash
fewer. The shapes are matched with any run of backslashes at that point, so the escape escapes
itself and every string round-trips; a line with no backslash there reads exactly as before, so
Logseq files keep their meaning. Line 1 is escaped whatever the block's head or id, so `page_read`
(ids) and `block.update`'s `before` (no ids) spell a line the same way. Spec: new
`docs/spec/markdown-grammar.md` OUT-23a (+ OUT-23 rule 6), corpus case 49; `docs/spec/mcp-tools.md`
§3.2 rule 5 and `block_update`'s description (code and spec) name the escape.

`:LOGBOOK:` is included although B-342 did not name it: found while measuring, same class and
worse — a content line `:LOGBOOK:` took every line after it up to `:END:` out of the text.

Tests (each run against the base `outline.ts` swapped back in, red there, green after):
- `packages/core/src/outline.test.ts` › "content lines shaped like a property, a timestamp or a
  drawer (B-342, OUT-23a)" (6: 5 red on base; "still reads an unescaped line as a property, a date
  or a drawer (Logseq files)" is a guard, green on both), and 4 new contents in "serialize -> parse
  is lossless across heads, ids, properties and content shapes" (both matrix tests red on base).
- `packages/core/src/corpus.test.ts` › corpus case `49-escaped-shaped-content` (2).
- `packages/server/src/ops/shaped-content-lines.http.test.ts` (4): `page_read` shows the typed line
  escaped, and an old_str edit of ANOTHER word keeps it text — on base that edit silently gave the
  task a real scheduled date; old_str copied from `page_read` edits the line, and dropping the
  backslash makes it a real property; escaped markdown writes text next to a real property;
  content copied from `page_read` round-trips. `verifyRebuildParity` clean in each.
- `packages/server/src/importer/logseq.test.ts` › "still imports Logseq's property, SCHEDULED and
  LOGBOOK lines as such (OUT-23a)" (red on base only for its escaped-line half).
- `e2e/tests/shaped-line-clipboard.spec.ts` — the entry's own steps (Shift+Enter, type
  `scheduled:: 2026-09-20`, click away), then copy the row and paste it. Base: the clipboard held
  `scheduled:: 2026-09-20` and the pasted block came back as content `call mom` with a real
  `scheduled` date. Fixed: copies as `scheduled\:: 2026-09-20`, pastes as text.
- Probe `tools/probes/serialize-property-shaped-content.ts`, extended to 36 cases (the 5 original
  shapes plus `DEADLINE:` with time and repeater, `collapsed::`, `id::`, `heading::`, `:LOGBOOK:`,
  already-escaped lines; after line 1 of a task, and as line 1 with and without an id): 27
  lossless=false on base, 0 after.

Real data (a `.backup` copy of the owner's graph, 953 pages, 18,630 blocks):
`tools/probes/mirror-roundtrip-graph.ts` read 2 pages / 20 blocks back differently before (the
literal `SCHEDULED: <…>` lines the pre-B-266 import left as text, each read back as a real date)
and 0 after. `nooklet export` with the fix vs the base code: 2 of 953 files change
(`journals/2022_12_16.md`, `journals/2023_02_17.md`), 20 lines, each `SCHEDULED: <…>` →
`SCHEDULED\: <…>`. `pnpm nooklet verify`: OK, 20,446 ops. The owner's Logseq file graph and DB
mirror contain 0 lines with a backslash at an escape point (grep), so importing them is unchanged.

Costs, as the entry predicted: agents see `scheduled\:: …` in `page_read` and must keep the
backslash to keep a line text; a copied block pasted into another app shows the backslash (a
CommonMark viewer renders `\:` as `:`). Not verified: how Logseq itself reads `key\:: value` (no
Logseq here). Found while fixing: B-470, B-471, B-472 below.

---

### B-470 · A later line of a block's text that looks like a bullet comes back from the mirror, copy and paste as a child block
**Status:** open · **Severity:** medium · **Found:** 2026-09-13, mirror-escape (fixing B-342) ·
**Test:** none yet; probe `tools/probes/content-shapes-beyond-b342.ts`

A block whose text is `a` + a second line `- dash` (also `* star`, `+ plus`, a bare `-`, or
`1. first`) is written as `- a` / `  - dash`, and every reader of that text — the markdown mirror,
`page_read`, copy then paste, a re-import — gets a block `a` with a child block `dash` (from `1. `
lines: children with `list:: number`). The same class as B-342, one level up: the serializer writes
content lines verbatim and the parser reads bullets by shape. OUT-23a's backslash would fit here too
(`\- dash`, which CommonMark renders as `- dash`), but that is a grammar addition the owner has not
approved. Owner's graph copy: 0 such blocks today (the round-trip probe reads all 953 pages back).
How often the editor produces such text (Shift+Enter, then `- `) is not checked in a browser.

---

### B-471 · A plain block whose text starts with `TODO `, `LATER ` or `[#A]` comes back from the mirror, copy and paste as a task
**Status:** open · **Severity:** low · **Found:** 2026-09-13, mirror-escape (fixing B-342) ·
**Test:** none yet; probe `tools/probes/content-shapes-beyond-b342.ts`

A block with no marker whose text is `TODO not a task` is written `- TODO not a task`, and read back
as a TODO task with the text `not a task`; `[#A] x` comes back with priority A. Same class as B-342
and B-470 (line 1's head is read by shape). `TODOS are words` is fine. Whether the editor stores a
typed leading `TODO ` as text or as the marker is not checked here. Owner's graph copy: 0 such
blocks today.

---

### B-472 · A text line `foo:: bar` in a block becomes a real property the first time the block is edited in the app
**Status:** open (needs owner decision) · **Severity:** medium · **Found:** 2026-09-13,
mirror-escape (fixing B-342) · **Test:** none yet; probe `tools/probes/content-shapes-beyond-b342.ts`
(unit level; not run in a browser)

The editing text (OUT-22a, `packages/core/src/block-text.ts`) splits every `key:: value` line with a
non-reserved key out of the buffer as a property. A block whose stored TEXT holds `foo:: bar` —
written by an agent as `foo\:: bar` (OUT-23a), pasted from a copied block, or older content — has
that buffer; one keystroke anywhere in it writes `block.text` without the line plus `block.prop foo
= bar` (probe output: `[{"kind":"block.text","content":"notes"},{"kind":"block.prop","key":"foo",
"value":"bar"}]`). `joinBlockText`'s comment calls that promotion "what the same text in a file
would have meant", which B-342's fix made untrue: the file now keeps it text. Reserved-key lines
(`scheduled:: …`) are not affected — the buffer never splits them. B-342's fix makes this easier to
reach: an agent can now write such text through markdown, where before `foo:: bar` was always a
property and `foo\:: bar` stayed text with its backslash, which the buffer does not split; and
copy then paste now keeps it text, where before the paste made it a property. Ways out, owner's
call: the buffer shows such a line escaped (`foo\:: bar`) and the split un-escapes it — lossless,
the same rule as the mirror, but a backslash in the editor — or keep the promotion and document it.

---

### B-473 · `editing.spec.ts` fails when a run has no `a-fresh-journal.spec.ts` before it but has `dates.spec.ts`
**Status:** open (test harness) · **Severity:** low · **Found:** 2026-09-13, mirror-escape (running
the e2e suite in three chunks on port 6413) · **Test:** none yet

`NOOKLET_E2E_PORT=6413 pnpm exec playwright test tests/agent-ops.spec.ts
tests/autocomplete-busy-replica.spec.ts tests/block-timestamps.spec.ts
tests/context-menu-placement.spec.ts tests/dates.spec.ts tests/editing.spec.ts --project=chromium`:
3 of `editing.spec.ts`'s 4 tests fail in its local `openJournal`, with the base `outline.ts` too
(so not B-342's change): `virtualDraft.or(outliner)` is a strict-mode violation — today is still
virtual (`.vr-draft-input` shown) AND today's "Scheduled and deadline" section, filled by
`dates.spec.ts`'s tasks, renders a `.vr-outliner vr-outliner-readonly`. The whole suite in file
order passes because `a-fresh-journal.spec.ts` runs first and makes today real. `editing.spec.ts`
alone: 4/4. `e2e/helpers/editor.ts#openJournal` has the same locator.

---

### B-474 · One keystroke in a block whose text has a `foo:: bar` line deletes that line (or duplicates it as a property)
**Status:** open · **Severity:** high (silent data loss) · **Found:** 2026-09-13,
mirror-escape-verify (adversarial check of B-342's fix, in Chromium) · **Test:** pending

Seed `- notes` / `  foo\:: bar` / `  more` through `page.create` (OUT-23a: the text `foo:: bar`),
open the page, click into the block and type one character:
- at the end of `notes` or of `more`: the block is saved as `notes!` / `more` — the `foo:: bar` line
  is gone, and no `foo` property was written either;
- at the end of the `foo:: bar` line: a property `foo = bar!` is written and the text line
  `foo:: bar` stays, so page_read shows both.

6 of 6 runs, with and without another write refetching the page first. B-472 predicted a clean
promotion to a property; in the app it is not even that. Reachable because of B-342's fix: an agent
is now told to write such text as `foo\:: bar`, and copy then paste keeps it text. The owner's graph
has 0 blocks with such a line today (`splitBlockText` over all 18,633 blocks of the copy).

What happens: attaching the editor re-runs the page-tree effect in `BlockTree.tsx`, which lays the
live buffer over the block with `withEditText(block, buffer)` so a refetch cannot clobber typing.
The buffer is still exactly the block's editing text, but `withEditText` splits it anyway, so the
editor's tree holds content `notes\nmore` and a property `foo = bar` the database does not have.
The first keystroke snapshots that tree as `before`, and the diff at flush then sees the line as an
unchanged property: it writes only the content without it (or only the property).

---

### B-475 · A block whose first line holds a Unicode line separator comes back from the mirror with `- ` in its text
**Status:** open · **Severity:** low · **Found:** 2026-09-13, mirror-escape-verify (fuzzing
`serializeOutline` → `parseOutline`) · **Test:** none yet

A block whose content line 1 contains U+2028 or U+2029 (pasted from some web pages or JSON
strings) is written `- a<U+2028>b`, and read back as a plain paragraph block whose text is
`- a<U+2028>b`: the bullet regex's `.` does not match a line separator, so the line is not a bullet.
A task loses its marker and id the same way. Lines after line 1 are fine (they are continuation
lines by indent). Same on the base code (`52e5d20`), so not B-342's change. Owner's graph copy: 0
blocks contain either character.
