# Bugs inbox — impl-render (m8)

Entries in `docs/BUGS.md` format, for the coordinator to fold in. Numbers for new bugs come from
B-150..B-159 only.

---

### B-100 (existing)
Numbered lists never render. **Test:** `e2e/tests/block-properties.spec.ts` "list:: number
siblings render 1, 2 and restart after a plain bullet"; `apps/web/src/db/worker-core.test.ts`
"carries each block's generic properties, not tombstones or reserved keys (B-100)"

**Fixed 2026-09-13.** The worker's page tree (`db/worker-core.ts#pageBlockTree`) now reads every
live block's non-null `block_prop` rows for the page in one query and hangs them on
`BlockTreeNode.properties`; `EditableBlock.listNumber` (always `false`) became
`EditableBlock.properties`, and `numbering.ts#isNumbered` reads `properties.list === "number"`.
Core's `BlockRow` is unchanged — the server shares it and reads properties its own way. The e2e
test would have caught it: before the fix a page seeded with `list:: number` blocks rendered zero
`.vr-list-number` (the audit's runtime check, D6). Side effect: Cmd+C on selected blocks now copies
their properties too (it wrote `properties: {}`).

Real graph (copy of the owner's, 952 pages): `tools/probes/real-graph-properties.mjs` opened the six
pages with the most numbered blocks plus three property-heavy ones in a real browser against
`nooklet serve`, and compared every rendered row with the database — ordinals recomputed from
`block_prop` and sibling order independently of the client, chips counted per block. 177 visible
numbered rows (Claude code queue 55, zahradni-domek 43, 2026-01-11 31, 2025-04-06 21, Megapage
21, a PDF-highlights page 6) and 70 rows with chips: 0 wrong. (OmnivoreSync's 357 numbered
blocks sit under collapsed parents, so none were visible.) A property typed into a real block
through the UI wrote exactly one
`block.prop` op; `nooklet verify` afterwards: OK, 20,412 ops.

Creating one in the UI: Enter in a numbered item continues the list (`commands.ts#splitBlock`), and
a "Numbered list" command (slash item and palette, `commands/registrations/numbered-list.ts`)
toggles `list:: number` — **Test:** `block-properties.spec.ts` "Enter at the end of a numbered
item makes the next item numbered too", "the Numbered list slash item numbers a block, and a second
use stops it"; `numbered-list.test.ts`. Not done: Enter on an *empty* numbered item does not end
the list (Logseq does); `popups.spec.ts`'s slash order gained the item.

---

### B-101 (existing)
Block properties are invisible in the UI, and `/property` writes literal text. **Test:**
`e2e/tests/block-properties.spec.ts` "show as chips under the block, and as key:: value lines while
it is edited", "a typed key:: value line is stored as a property, not as text", "/property inserts a
line that becomes a real property (the audit's D7 repro)", "editing a value and deleting a line
change and remove properties; undo restores"; unit `packages/core/src/block-text.test.ts`,
`apps/web/src/editor/editText.test.ts`, `commands/registrations/insert-logic.test.ts`

**Fixed 2026-09-13.** Both halves, on the seam B-100 opened (`EditableBlock.properties`):
- *Seeing them.* `editor/BlockProperties.tsx` renders a block's properties as compact muted
  `key: value` chips under its rendered content (values through `InlineContent`, so `[[links]]`
  navigate; clicking elsewhere on the chips enters edit mode). Hidden: `list` (the ordinal says it)
  and the keys Logseq's own `hidden-built-in-properties` hides (`hl-*`, `ls-type`, `query-*`,
  timestamps). Chips sit under the *whole* content, not between line 1 and line 2 as in Logseq —
  the rendered view's click-to-caret mapping needs one view over the whole content.
- *Editing them.* While a block is edited its buffer is its editing text — content plus
  `key:: value` lines (new `markdown-grammar.md` OUT-22a, `packages/core/src/block-text.ts`). On
  flush the buffer is split back with the outline parser's own line rules and written as a
  `block.text` if the text moved plus one `block.prop` per property added, changed or removed,
  diffed against the block as the edit began (so a property set elsewhere meanwhile survives).
  `BlockTree.tsx` maps carets between buffer and content at the surface boundary (split at the
  caret, history carets, attach). Undo works on properties: `invert.ts` reads the prior value from
  `properties` (it inverted generic keys to `null`), `optimistic.ts` models generic `block.prop`,
  and `history.ts` merges coalesced transactions per field (replacing wholesale lost a property
  written earlier in the same typing burst).
- `/property` inserts `:: ` under line 1 and the existing property lines with the caret before it
  (type the key, End, the value); a `key` placeholder would itself be written as a property.
Reserved keys (`scheduled::` etc.) and `heading::` typed in the buffer stay text, as before (B-96/
B-102 own dates). Literal `key:: value` lines already sitting in some block's content (the old
`/property` output) become real properties the first time that block is edited — which is what the
same text in a file means. Also: Enter in a numbered item continues the list, and duplicate copies
generic properties (`commands.test.ts`).

---

### B-99 (existing)
`/image` does nothing. **Test:** `e2e/tests/image-insert.spec.ts` "/image opens a file chooser and
inserts the uploaded image at the caret (B-99)"; `apps/web/src/editor/imagePicker.test.ts`

**Fixed 2026-09-13.** `block.insertImage` is now handled where it is delegated
(`BlockTree.tsx`'s editor host `runStructural`): `editor/imagePicker.ts#pickImageFile` opens the
platform's own chooser through a hidden, connected `<input type="file" accept="image/*">` (no
Tauri/Capacitor-specific host needed), and the picked file goes through the paste path's
`uploadImageAsset` and the new `insertUploadedImage`, which inserts at the live caret — or, if the
editor moved to another block while the upload ran, into the original block at the caret it had
(paste used to drop the image into whichever block was being edited when the upload landed).
The e2e test was red before the fix (`page.waitForEvent("filechooser")` timed out). Not done:
drag-and-drop of an image file onto a block (the audit's "can follow").

---

### B-150 · Image paste uploads without a credential, so it cannot work in the served app
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, reading `editor/paste.ts` while
wiring `/image` (B-99) · **Test:** `e2e/tests/image-insert.spec.ts` "pasting an image uploads it
with the client's credential and inserts it (B-150)"

`editor/paste.ts#uploadImageAsset` calls `fetch("/api/v1/asset.upload")` with no `authorization`
header. Every `/api/v1/*` route sits behind `bearerAuth` (`packages/server/src/http/app.ts`), so
the served app gets a 401 and the paste is silently dropped (the catch only logs to the console).
Nothing covered it: no e2e test pastes an image, and `assets.spec.ts` uploads through its own
authenticated helper. Same class of defect as the "client has no API credential" bug the e2e suite
was created for.

Confirmed at runtime before the fix: a synthetic image paste in the served app produced
`asset.upload -> 401` with no `authorization` header, and the block kept only its text.

**Fixed 2026-09-13.** `uploadImageAsset` goes through `data/api-client.ts#callOp`, which sends this
device's token and turns failures into `ApiError`. The e2e test pastes a PNG through a real
`ClipboardEvent` and reads the stored markdown back through `page.read`; it was red before the fix.

---

### B-151 · A block that opens with a code fence loses its properties when serialized without ids
**Status:** open · **Severity:** low · **Found:** 2026-09-13, writing `core/block-text.ts` (B-101) ·
**Test:** none yet; `tools/probes/serialize-fence-props.ts` reproduces it

`serializeOutline(page, { ids: "none" })` writes a block's property lines straight after its first
line. When that line opens a fence (```` ```js ````), the property lines land inside the fence and
re-parse as code: `- ```js\n  foo:: bar\n  code\n  ```` comes back with `properties: {}` and the
`foo:: bar` line in the code. With ids (the mirror's default) OUT-14 puts `^id` alone on line 1 and
the round trip holds, which is why the mirror never showed it. Callers with `ids: "none"`:
`BlockTree.tsx`'s `block.copySelection` (copy then paste loses the property) and the server's
`outline-bridge.ts#renderSingleBlockText` (the before-text `block.update` matches `old_str`
against). `core/block-text.ts#joinBlockText` avoids the same trap by writing such a block's
properties after the closed fence. Fix: the same placement in `serializeOutline`.

---

### B-152 · Editing a block whose property value has a line break moves the value's tail into the text
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-render` · **Test:** `e2e/tests/block-properties.spec.ts` "a property value the buffer
cannot show as one line survives editing the block (B-152)"

Since B-101 the editor's buffer writes every generic property as a `key:: value` line and splits the
buffer back with the parser's line rules on flush. A value that does not survive that trip as the
same property is corrupted by the first keystroke. `block.update` accepts any string as a value
(`schemas.ts#PropertiesPatch`), so an agent can set `summary:: line1\nline2`; the buffer then reads
`title\nsummary:: line1\nline2`, the split takes `line2` as content, and typing one character wrote
`block.text "title!\nline2"`. Seen in a real browser before the fix: `page.read` after one `!`
returned `content: "title!\nline2"`. (The `summary` value itself was not rewritten only because a
refetch had already folded the truncated value into the local tree, so the diff saw no change.)
A value with leading/trailing whitespace is silently trimmed the same way, and a key the line regex
cannot read back (an imported `_foo`, normalized to `-foo`) is moved into the text and deleted.

**Fixed 2026-09-13.** `core/block-text.ts#showsInEditText(key, value)`: a property goes into the
buffer only if its `key:: value` line reads back as exactly that key and value. The others are
treated like `heading` — left out of `joinBlockText`, carried over untouched by
`editText.ts#withEditText`, and never deleted by `blockTextPayloads`. Typing a `summary:: x` line
still overrides one. The e2e test was red before the fix (the buffer read
`title\nsummary:: line1\nline2`); unit: `block-text.test.ts` "properties whose line would not read
back as themselves (B-152)", `editText.test.ts` "keeps a multi-line value out of the buffer".

---

### B-153 · `/code`, `/query` and `/h1`–`/h3` treat a block's property lines as its text
**Status:** fixed · **Severity:** medium · **Found:** 2026-09-13, adversarial verification of
`m8/impl-render` · **Test:** `e2e/tests/block-properties.spec.ts` "/code, /query and /h1 change the
text and leave the properties alone (B-153)"

Since B-101 the editor host's `getSelection().content` is the block's editing text, property lines
included, and three commands transform that whole string (`insert-logic.ts`). Seen in the browser
before the fix: `/code` on a numbered item stored `` ```\nnpm install \nlist:: number\n``` `` with
no properties (the numbering was gone, its line was code); `/query` on a block with `owner:: Dan`
stored `` ```query\nowner:: Dan\n``` ``; `/h1` on a numbered item left the caret at the end of the
buffer — the end of the `list:: number` line — so the next word typed was stored as
`list:: numbermore` and the item stopped being numbered.

**Fixed 2026-09-13.** `commands/registrations/insert-logic.ts#onContent` splits the editing text,
runs the command's transform on the content alone, writes the property lines back in their
canonical place (`joinBlockText` — after the fence for a fenced block) and maps the caret from
content into the result; `insert.ts` wraps the three commands in it. A text without property lines
passes straight through. The e2e test was red before the fix (`list:: number` inside the fence, no
properties); unit: `insert-logic.test.ts` "onContent (B-153)".

### B-154 · `/template` in an empty block that has properties inserts the template after it
**Status:** fixed · **Severity:** low · **Found:** 2026-09-13, same verification · **Test:**
`apps/web/src/commands/registrations/templates.test.ts` "an empty block with properties still takes
the template into itself (B-154)"

`templates.ts` decides "apply into this block" by `content.trim() === ""` on the editing text. An
empty numbered item's buffer is `\nlist:: number`, so it counted as non-empty and the template's
blocks went in after it, leaving an empty numbered bullet behind (browser: rows `1. first`, `2.`,
`Standup`, …).

**Fixed 2026-09-13.** The emptiness check reads the content part of the editing text
(`splitBlockText`), and the template's text replaces that content through `onContent` (B-153), so
the block keeps its own properties and the caret ends after the text. The unit test was red before
the fix; in the browser the scratch check now gives rows `1. first`, `2. Standup`, `yesterday`,
`today`.
