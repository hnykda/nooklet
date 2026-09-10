# Commands and keymap

## Purpose

This spec is the exhaustive, implementation-ready reference for nooklet's command system: the
`Command` type, the `when`-clause mini-language, every command core registers (id, title,
category, default keybinding on desktop, mobile-toolbar/gesture equivalent, and precise
behavior), the mobile keyboard toolbar, the `keybindings.json` override format, and the
palette/slash-menu ranking algorithm. It refines PLAN.md §7, §8, §12, §14, ADR 006, ADR 009,
and ADR 011, and MUST NOT contradict them. Where those documents leave a key or a detail
unspecified, this spec picks exactly one answer (recorded under Open issues) so an implementer
never has to guess.

## Definitions

- **Command**: a named, rebindable operation, as defined by ADR 009 and the `Command` type
  (Interfaces). Every user-facing action in the app — editing, navigation, formatting, tasks,
  app chrome — is a command; nothing bypasses the registry.
- **`when` clause**: a boolean expression string, evaluated against a `WhenContext` snapshot, that
  gates whether a command is enabled/reachable. Absent `when` means "always enabled."
- **Context variable**: one named, typed field of `WhenContext` (§ Interfaces), computed fresh
  before every keydown dispatch and before every palette/menu render.
- **Default keybinding**: the `{mac?, other?}` key string(s) a command ships with, before any
  user customization. "mac" also covers iPadOS with an attached hardware keyboard; "other" covers
  Windows, Linux, and Android with an attached hardware keyboard. Touch-only input uses the
  mobile toolbar and gestures (§ Mobile) instead of a keybinding.
- **Secondary default binding**: an additional built-in keybindings.json row that routes a second
  key to a command already covered by its `defaultKeys` (e.g. Delete also runs
  `block.deleteSelected`, whose `defaultKeys` names Backspace). Secondary bindings are listed
  once, in R21.
- **Chord**: a keybinding whose `key` is a space-separated sequence of key tokens (e.g.
  `"Mod+K Mod+S"`), matched over a bounded inter-key window (§ R33). No default binding in this
  spec uses a chord; the format supports user-defined chords per ADR 009 ("records chords").
- **Surface**, **Row / flattened visible order**, **Ctx** (editor keydown context): defined in
  `research/04-editor.md` §3.1–§3.4 and carried unchanged by ADR 006; this spec's `WhenContext`
  and `CommandContext` are supersets of that `Ctx`.
- **Block-selection mode**: no `Surface` is mounted; one or more blocks are selected by id, with
  an anchor and a focus index into the flattened row list (entered via `block.selectBlock` or
  `block.extendSelectionUp/Down`).
- **Zoom root**: the block id, if any, that the current view treats as the top of the tree
  (research 04 §3.9). `zoomed` is true whenever a zoom root is set.
- **MRU (most-recently-used) list**: a per-device, unsynced list of command ids (and, for the
  page switcher, page ids) used by the ranking algorithm (§ R39–R42). Not part of
  `keybindings.json` and not synced as a setting.
- **Marker**: the task state on a block — `null`, `TODO`, `DOING`, `DONE`, `WAITING`, or
  `CANCELED` — per PLAN §8.

## Normative rules

### A. The `Command` type and its contract

**R1.** A command MUST have this shape (see Interfaces for the literal TypeScript):
`{ id, title, description?, category, when?, defaultKeys: {mac?, other?}, icon?, run }`.
`defaultKeys` is always present as an object; either or both of `mac`/`other` MAY be absent,
meaning the command has no default keyboard shortcut on that platform (it remains reachable via
the palette, slash menu, a menu item, or the mobile toolbar).

**R2.** `id` MUST match `^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$` — one `area` segment, a dot,
one `verb` segment (`camelCase`), per the conventions doc (`block.indent`, `task.cycle`,
`nav.journals`, `search.open`). Core uses the areas `block`, `task`, `nav`, `palette`, `search`,
`format`, `edit`, `app`, `sync`. Plugin-contributed command ids MUST be prefixed
`plugin.<pluginId>.` (e.g. `plugin.mermaid.insertDiagram`) so they can never collide with core or
another plugin; the palette groups them under a category equal to the plugin's declared name.

**R3.** `category` is a free-form display string used only for palette grouping; it MAY differ
from the `id`'s area segment (e.g. slash-only insert commands use `id` area `block` but
`category: "Insert"` — § Command reference tables below). Core categories: `Block`, `Task`,
`Navigation`, `Formatting`, `Insert`, `App`.

**R4.** `run(ctx: CommandContext)` MUST be idempotent-safe to invoke from any of: a keydown match,
a palette/slash-menu selection, a mobile toolbar tap, a block/page context-menu click, the HTTP
API's command-invocation op (if exposed), and another command's `ctx.exec(...)` call. It MUST NOT
read global mutable state other than through `ctx`.

**R5.** `when`, if present, MUST be a valid expression in the grammar of § B. A command whose
`when` evaluates to `false` in the current `WhenContext` MUST be: skipped during keydown dispatch
(§ R18–R20), shown disabled/hidden in the palette (implementation choice, but MUST NOT be
selectable), and excluded from the slash menu.

### B. The `when`-clause language

**R6.** Grammar (EBNF; the four bullets after it are the whole language — no arithmetic, no
relational operators beyond equality, no ternary, no function calls, no string concatenation):

```ebnf
Expr        ::= OrExpr
OrExpr      ::= AndExpr ( "||" AndExpr )*
AndExpr     ::= UnaryExpr ( "&&" UnaryExpr )*
UnaryExpr   ::= "!" UnaryExpr | Primary
Primary     ::= "(" Expr ")" | Comparison | Identifier
Comparison  ::= Identifier ( "==" | "!=" ) Literal
Identifier  ::= [A-Za-z_][A-Za-z0-9_]*
Literal     ::= "'" [^']* "'" | "true" | "false" | [0-9]+
```

Precedence, tightest first: `!`, then `&&`, then `||`. Parentheses group. Whitespace between
tokens is insignificant. A bare `Identifier` (no comparison) is truthy-tested: `isTask` means
`isTask == true` for a boolean variable, and is an error at command-registration time (not at
evaluation time — see R9) for a non-boolean variable such as `platform` used bare.

**R7.** `WhenContext` field list (exact names and types; the canonical, closed set — no other
identifiers are valid in a `when` string):

| Name | Type | Meaning |
|---|---|---|
| `editorFocused` | `boolean` | A `Surface` is mounted and focused on a block. |
| `blockSelected` | `boolean` | Block-selection mode is active (no `Surface` mounted, ≥1 block selected). Mutually exclusive with `editorFocused`. |
| `hasSelection` | `boolean` | `editorFocused` with a non-empty text selection (`anchor !== head`), OR `blockSelected`. |
| `selectionCount` | `number` | Number of blocks selected in block-selection mode; `0` when not `blockSelected`. |
| `isTask` | `boolean` | The focused block (`editorFocused`) or the anchor of the selection (`blockSelected`) has a non-null `marker`. `false` when neither mode is active. |
| `isCollapsed` | `boolean` | Same target block as `isTask`; its `collapsed` flag. |
| `hasChildren` | `boolean` | Same target block; it has ≥1 child. |
| `atLineStart` | `boolean` | Caret is at offset 0 of the block's whole `content` string (research 04's `atStart`; the name follows this spec's convention of treating a block's content as one logical field regardless of soft wraps or embedded `\n` from Shift+Enter). |
| `atLineEnd` | `boolean` | Caret is at the final offset of the block's `content` (research 04's `atEnd`). |
| `onFirstVisualLine` | `boolean` | Caret's rendered row is the block's topmost visual row (`Surface.geometry().onFirstLine`). |
| `onLastVisualLine` | `boolean` | Caret's rendered row is the block's bottommost visual row (`onLastLine`). |
| `caretInLink` | `boolean` | Caret is inside or adjacent to a `wikilink`, `tag`, `link`, or `blockref` token (§ tokenizer, research 04 §4.2). |
| `popupOpen` | `boolean` | An autocomplete/slash popup is open (`completionStatus(state) === 'active'`). |
| `composing` | `boolean` | An IME composition is in progress (`Surface.isComposing()`). |
| `zoomed` | `boolean` | The current view has a non-null zoom root. |
| `platform` | `'mac' \| 'windows' \| 'linux' \| 'ios' \| 'android'` | Resolved once per session/device. |
| `mobile` | `boolean` | `platform` is `ios`/`android` **or** the device is touch-primary (no hardware keyboard detected), independent of screen size. |

**R8.** Evaluation is pure and total: given an expression string and a `WhenContext`, the
evaluator returns exactly `true` or `false` and never throws. Unknown identifiers (a typo, or a
plugin targeting a future context var this build doesn't have) evaluate to `undefined`, which is
falsy in a bare-identifier position and fails every `==`/`!=` comparison except `!= <anything>`
being vacuously handled as `undefined != x` → `true` when `x` is not literally `undefined`... to
avoid that surprise, R9 fixes the comparison semantics precisely.

**R9.** Comparison semantics: `a == b` is `true` iff both sides have the same JS-primitive type
and value after literal coercion (`'mac' == 'mac'` → true; `3 == 3` → true; `isTask == true` →
true only if `isTask` is boolean `true`); an unknown identifier never equals anything, including
`false` (so `unknownVar == false` is `false`, not `true` — this is deliberate: an unrecognized
variable makes the clause AND its negation both evaluate to `false`, which is safer than
silently enabling a command under an unintended condition). `a != b` is exactly `!(a == b)`.

**R10.** Parsing happens once per distinct `when` string; the resulting AST is cached in a
`Map<string, CompiledWhen>` for the process lifetime (command registration time for core/plugin
commands, first-use time for a user's custom `when` in `keybindings.json`). A `when` string that
fails to parse (syntax error) MUST be rejected at registration/load time with a diagnostic naming
the offending command or keybinding row; it MUST NOT be silently treated as `true` or `false`.

**R11.** Known mutually-exclusive variable pairs, used only by the keybindings conflict detector
(§ R34–R36), not by the evaluator itself: `(editorFocused, blockSelected)`. Two `when` clauses
that each assert opposite sides of a known-exclusive pair (one contains `editorFocused` and not
`!editorFocused`... precisely: one clause's top-level conjunction includes the bare identifier
`editorFocused` and the other's includes `blockSelected`, with neither containing the other's
term) are treated as provably disjoint.

### C. Keydown dispatch order (desktop and hardware-keyboard mobile)

**R12.** On every `keydown` inside a mounted `Surface`, dispatch proceeds in this fixed order and
stops at the first match; a step that "returns false" means fall through to the next step, and if
every step falls through the key event is not handled by the command layer (it reaches CM6's
`defaultKeymap` / browser default, e.g. plain character insertion or Cmd/Ctrl+A "select all in
block"):

1. If `composing` is true, return false unconditionally (never touch the document mid-IME).
2. If `popupOpen` is true and the key is one of `Escape, Enter, ArrowUp, ArrowDown, Tab`, let the
   autocomplete extension's own keymap (`@codemirror/autocomplete`) handle it (accept/close/move);
   this is not a `Command` and has no `id`.
3. Resolve the physical key token for the event (§ R32) against the compiled keymap (base
   defaults + secondary defaults + user `keybindings.json`, merged per § R28–R31). Walk candidate
   rows for that token from most-recently-loaded to least (user rows, reverse array order, then
   secondary defaults, then base defaults); the first row whose `when` evaluates `true` (or has
   no `when`) against the current `WhenContext` wins; run its command and `preventDefault()`.
4. If no row matched, return false (native/CM6 default behavior applies).

**R13.** When no `Surface` is mounted (block-selection mode), the same table and the same
resolution algorithm apply; the outliner container (`tabindex="-1"`) is the event target instead
of a CM6 view, and `composing`/`popupOpen` are always `false`.

### D. `defaultKeys` platform resolution

**R14.** At load time, for the running `platform`, `mac` resolves for `platform == 'mac'` and for
`platform == 'ios'` when a hardware keyboard is attached; `other` resolves for `platform` in
`windows`/`linux`, and for `android`/`ios` when a hardware keyboard is attached without a native
`mac`-style Cmd key (i.e. `other` is the fallback whenever `mac` does not apply and a hardware
keyboard exists). When no hardware keyboard is present, neither resolves; the command remains
reachable through the palette, slash menu, menus, and (if listed in § Mobile) the toolbar.

**R15.** Key-token notation used throughout this document and in `keybindings.json`: modifiers
joined with `+`, canonical order `Mod, Alt, Shift` where `Mod` is `Cmd` on mac and `Ctrl`
elsewhere (this document always spells out the resolved form, e.g. "`Cmd+Enter` / `Ctrl+Enter`",
never the neutral `Mod+Enter`, for a table an implementer can read without a lookup step — the
neutral `Mod` token is reserved for authoring entries in `keybindings.json`, § R28). Base key
names are a single printable character (`A`–`Z`, `0`–`9`, `.`, `,`, `[`, `]`, `\`, `/`) or one of
the named keys `Enter, Escape, Tab, Backspace, Delete, Up, Down, Left, Right, Space, Home, End`.

### E. Command reference tables

Every command below is registered by core at startup. "Mobile" in a row means the command also
appears as a keyboard-toolbar button or a gesture (§ Mobile); "—" in `mac`/`other` means
`defaultKeys` omits that platform (no default shortcut; reachable via palette/slash/menu/toolbar
only, which is itself a deliberate, unambiguous choice, not an omission).

#### E.1 Block editing (category `Block`)

| id | title | mac | other | when |
|---|---|---|---|---|
| `block.split` | Split block | Enter | Enter | `editorFocused` |
| `block.newline` | Insert newline in block | Shift+Enter | Shift+Enter | `editorFocused` |
| `block.indent` | Indent block | Tab | Tab | `editorFocused` |
| `block.outdent` | Outdent block | Shift+Tab | Shift+Tab | `editorFocused` |
| `block.mergeWithPrevious` | Merge with previous block | Backspace | Backspace | `editorFocused && atLineStart && !hasSelection` |
| `block.deleteForwardMerge` | Merge next block into this one | Delete | Delete | `editorFocused && atLineEnd && !hasSelection` |
| `block.moveUp` | Move block up | Alt+Up | Alt+Up | `editorFocused \|\| blockSelected` |
| `block.moveDown` | Move block down | Alt+Down | Alt+Down | `editorFocused \|\| blockSelected` |
| `block.focusPreviousLine` | Move to previous block (same column) | Up | Up | `editorFocused && onFirstVisualLine` |
| `block.focusNextLine` | Move to next block (same column) | Down | Down | `editorFocused && onLastVisualLine` |
| `block.focusPreviousChar` | Move to end of previous block | Left | Left | `editorFocused && atLineStart` |
| `block.focusNextChar` | Move to start of next block | Right | Right | `editorFocused && atLineEnd` |
| `block.collapse` | Collapse block | Cmd+Up | Ctrl+Up | `(editorFocused \|\| blockSelected) && hasChildren && !isCollapsed` |
| `block.expand` | Expand block | Cmd+Down | Ctrl+Down | `(editorFocused \|\| blockSelected) && hasChildren && isCollapsed` |
| `block.collapseAll` | Collapse all | — | — | `true` |
| `block.expandAll` | Expand all | — | — | `true` |
| `block.zoomIn` | Zoom into block | Cmd+. | Ctrl+. | `editorFocused \|\| blockSelected` |
| `block.zoomOut` | Zoom out | Cmd+Shift+. | Ctrl+Shift+. | `zoomed` |
| `block.selectBlock` | Select block | Escape | Escape | `editorFocused && !popupOpen` |
| `block.editSelected` | Edit selected block | Enter | Enter | `blockSelected` |
| `block.clearSelection` | Clear selection | Escape | Escape | `blockSelected` |
| `block.extendSelectionUp` | Extend selection up | Shift+Up | Shift+Up | `editorFocused \|\| blockSelected` |
| `block.extendSelectionDown` | Extend selection down | Shift+Down | Shift+Down | `editorFocused \|\| blockSelected` |
| `block.selectAll` | Select all blocks | Cmd+A | Ctrl+A | `blockSelected` |
| `block.deleteSelected` | Delete selected blocks | Backspace | Backspace | `blockSelected` |
| `block.indentSelected` | Indent selected blocks | Tab | Tab | `blockSelected` |
| `block.outdentSelected` | Outdent selected blocks | Shift+Tab | Shift+Tab | `blockSelected` |
| `block.copySelection` | Copy selected blocks as markdown | Cmd+C | Ctrl+C | `blockSelected` |
| `block.duplicate` | Duplicate block | Cmd+Shift+D | Ctrl+Shift+D | `editorFocused \|\| blockSelected` |
| `block.copyRef` | Copy block reference | Cmd+Shift+C | Ctrl+Shift+C | `editorFocused \|\| blockSelected` |
| `edit.paste` | Paste | Cmd+V | Ctrl+V | `editorFocused` |

**R16.** `block.split` MUST split the block's `content` at the caret offset into `before`/`after`
substrings. The current block keeps `before`. If the block is `collapsed == false` and
`hasChildren`, a new block with `content = after` MUST be inserted as its **first child** (order
before all existing children); otherwise the new block MUST be inserted as its **next sibling**.
The new block inherits no marker/priority/properties from the split block. Focus moves to the new
block with the caret at offset 0 (`Surface.attach(newId, {at:'start'})`). If `atLineStart` and
`atLineEnd` are both true (block was empty), this degenerates to "insert an empty sibling after
and focus it," which is the same code path with `before = after = ''`.

**R17.** `block.newline` MUST insert `"\n"` at the caret inside the current block's `content`
without creating a new block. It never changes the block tree.

**R18.** `block.indent` (Tab): if the block has a previous sibling `S` under the same parent, the
block (with its whole subtree) becomes `S`'s **last child**, appended after `S`'s existing
children, with a fresh fractional order key. If the block has no previous sibling (it is the
first child of its parent, or the first block at the page/zoom-root level), this is a **no-op**.
The `Surface` stays mounted (only the row's `--depth` and DOM parent change; no re-attach, no
caret movement — matches research 04 §3.4's "keep the surface mounted" rule).

**R19.** `block.outdent` ("logical outdenting", Shift+Tab) on block `B` with parent `P`:
1. If `B` has no parent (`B` is at the page root or the zoom root), this is a **no-op**.
2. Let `G` = `P`'s parent (`null` if `P` is at the root/zoom root).
3. Let `younger` = the ordered list of `B`'s next siblings under `P` (siblings after `B`).
4. Remove `B` from `P`'s children; insert `B` as `P`'s immediate next sibling under `G`.
5. Re-parent every block in `younger` to become `B`'s children, **appended after `B`'s own
   pre-existing children**, preserving their relative order.
6. Assign fresh fractional order keys for `B` (among `G`'s children, between `P` and whatever
   followed `P`) and for each reparented block in `younger` (among `B`'s children, after the
   pre-existing ones).
7. No block's `collapsed` flag changes; nothing is force-collapsed or force-expanded.
8. The `Surface` stays mounted at the same relative caret offset (structural op, no re-attach).

This exists precisely so a block's later siblings do not end up "orphaned" out of reading order
relative to the block that outdented past them; see Examples for a worked before/after tree.

**R20.** `block.mergeWithPrevious` (Backspace when `atLineStart && !hasSelection`): let `prev` be
the block immediately before this one in the page's flattened visible-row order (respecting
`collapsed`; this may be the parent, if the current block is the first visible child, or the
deepest visible descendant of the previous sibling, if that sibling is expanded and has
children). If there is no `prev` (this is the first row of the page or zoom root), **no-op**.
Otherwise: if the current block's `content === ''` and it **has no children**, delete it and move
focus to `prev` at `{at: 'end'}`. If `content === ''` and it **has children**, **no-op** (a block
with children cannot be deleted this way; the user must first outdent or delete its children).
If `content !== ''`, set `prev.content = prev.content + this.content`, re-parent this block's
children (if any) to become `prev`'s children, appended after `prev`'s pre-existing children,
delete this block, and move focus to `prev` at the offset equal to `prev`'s original content
length (the join point).

**R21.** `block.deleteForwardMerge` (Delete when `atLineEnd && !hasSelection`) is the mirror of
R20: let `next` be the block immediately after this one in flattened visible order. If there is
no `next` (last row of the page/zoom root), **no-op**. Otherwise append `next.content` to this
block's `content`, re-parent `next`'s children as this block's trailing children (after this
block's own pre-existing children), delete `next`, and leave the caret at the original join
offset (no focus change — the merge happens forward, into the currently-focused block).
**Secondary default bindings** (rows added to the base keymap beyond each command's own
`defaultKeys`, per the definition in "Definitions"): `Delete` also runs `block.deleteSelected`
when `blockSelected` (its own `defaultKeys` names only Backspace).

**R22.** `block.moveUp` / `block.moveDown`: swap the block (with its subtree) with its previous /
next sibling under the same parent (reorder only; parent never changes). No-op at the first/last
sibling position. Works identically from `editorFocused` (surface stays mounted; Solid's keyed
`<For>` moves the DOM node) and from `blockSelected` (moves the whole contiguous selection as one
unit, preserving internal order).

**R23.** `block.focusPreviousLine` / `block.focusNextLine`: read `goalX` from
`Surface.geometry()`, detach the current surface, and attach it to the previous/next visible row
with `{ goalX, line: 'last' }` / `{ goalX, line: 'first' }` (§ `CaretSpec`, Interfaces), so the
caret lands at the closest character to the same horizontal position on the target block's
bottom/top visual line. No-op if there is no previous/next visible row (top/bottom of the
page/zoom root): the key event is not handled and falls through (e.g. the outliner scroll
container may still scroll).

**R24.** `block.focusPreviousChar` / `block.focusNextChar`: detach and attach the previous/next
visible block with `{ at: 'end' }` / `{ at: 'start' }} (character-wise wrap across the block
boundary, independent of column). No-op at the first/last visible row.

**R25.** `block.collapse` sets `collapsed = true` on the target block (focused, or the anchor of
the selection); `block.expand` sets it `false`. Neither changes focus or selection. `when`
requires `hasChildren` (collapsing a leaf is meaningless) and the opposite of the target state
(so the two commands are never simultaneously enabled — a keybindings UI showing "conflicts"
never flags this pair because their `when` clauses are already mutually exclusive by state, not
just by variable name).

**R26.** `block.collapseAll` / `block.expandAll` set `collapsed` on every block of the current
page (or, if `zoomed`, every block under the zoom root) to `true` / `false` in one batched
transaction. No default keybinding (§ Open issues); reachable from the palette and the page's
overflow menu.

**R27.** `block.zoomIn` sets the view's zoom root to the target block (focused, or the anchor of
the selection) and pushes a navigation entry (interacts with `nav.back`/`nav.forward`, § R44).
`block.zoomOut` pops one level (sets the zoom root to the current zoom root's parent, or clears it
entirely if the parent is the page root); `when: zoomed` disables it once already at the page
root. Clicking a breadcrumb ancestor is the equivalent pointer affordance for zooming to any
ancestor directly, not just one level.

**R28.** `block.selectBlock` (Escape while `editorFocused && !popupOpen`) commits the surface's
content, unmounts it, and enters block-selection mode with exactly the current block selected
(anchor = focus = that block). `block.clearSelection` (Escape while `blockSelected`) empties the
selection and returns to the plain (non-editing, non-selecting) view state — no block focused.

**R29.** `block.editSelected` (Enter while `blockSelected`) exits selection mode and mounts the
surface, with the caret at `{at: 'end'}`, on the block the selection was last extended to (the
focus of the anchor/focus pair), or the sole block if `selectionCount == 1`.

**R30.** `block.extendSelectionUp` / `block.extendSelectionDown`: if `editorFocused`, commit and
unmount the surface, enter block-selection mode anchored at the current block, and immediately
extend the selection by one block in the given direction — the result is the original block plus
its previous/next visible neighbor, both selected (this is the "Shift+Up/Down from an editing
block starts selection mode" behavior of research 04 §3.4). If already `blockSelected`, extend
the existing contiguous range by one more block in that direction (shrinking it if the direction
moves back toward the anchor). No-op past the top/bottom of the visible list.

**R31.** `block.selectAll` (while `blockSelected`) selects every visible row of the current
page/zoom root, keeping the existing anchor. `block.deleteSelected` deletes every selected block
and its subtree in one transaction and exits selection mode (moves focus to the block that is now
in the position of the first deleted row, or clears focus if the page is empty).
`block.indentSelected` / `block.outdentSelected` apply R18 / R19 to every block in the selection
**in top-to-bottom order**, treating each selected block as if it were the sole target of the
per-block rule (so outdenting a selected block whose next sibling is also selected does not
re-parent that sibling into it — a block already in the selection is moved by its own row of the
batch, not by another selected block's "younger siblings" step; implementations MUST snapshot the
`younger`-siblings list per R19 step 3 before any block in the batch has moved).
`block.copySelection` serializes the selected blocks (each with its subtree) as nested markdown
(`- text\n  - child`) to the system clipboard; this is an informational binding (the actual
trigger is the outliner container's native `copy` event, intercepted the same way `edit.paste`
intercepts `paste` — § R33 applies analogously).

**R32.** `block.duplicate` inserts a deep copy of the block and its subtree as its own next
sibling, with fresh ids for every copied block (never reusing an id, so copies never collide with
the original in refs/backlinks) and `collapsed` copied as-is; the copy's own `content` and
properties are copied verbatim, but `scheduled`/`deadline`/`done` timestamps are copied too
(duplication does not clear task state — the user can clear it manually). Focus moves to the
copy's top block at its original caret offset. `block.copyRef` copies the string `((<id>))` of
the focused/anchor block to the system clipboard (no popup, no autocomplete — this is the
"canonical block reference" text a user pastes elsewhere).

**R33.** `edit.paste`'s keybinding row is informational: `Cmd+V`/`Ctrl+V` is the OS/browser paste
gesture and is never matched by the keydown dispatcher (R12); the actual trigger is the editor's
native `paste` DOM event (`EditorView.domEventHandlers({ paste })`, research 04 §3.7), listed here
so it appears in the palette/settings UI with a display shortcut. Behavior: (1) plain text with no
`\n` is inserted at the caret as ordinary text (no new block). (2) Plain text containing `\n` is
parsed with `parseOutline` (leading-whitespace/list-marker depth, fenced code kept as one block,
blank-line-separated paragraphs become separate blocks) and inserted as sibling blocks after the
current one; if the current block was empty, the first pasted block replaces it instead of being
inserted after it; focus and caret move to the end of the last inserted block. (3) An image in the
clipboard is uploaded as an asset (`POST` to the assets endpoint) and `![](<asset-url>)` is
inserted at the caret, replacing the paste; on upload failure the paste is not applied and an
error notification is shown. `text/html` paste (browser rich text) is out of scope for v1 (falls
back to its `text/plain` sibling) except behind a future "paste as markdown" plugin toggle
(research 04 §3.7); this is noted, not specified further, here.

#### E.2 Tasks (category `Task`)

| id | title | mac | other | when |
|---|---|---|---|---|
| `task.cycle` | Cycle task marker | Cmd+Enter | Ctrl+Enter | `editorFocused \|\| (blockSelected && selectionCount == 1)` |
| `task.toggleDone` | Toggle done | — | — | `isTask` |
| `task.setPriorityA` | Set priority A | — | — | `isTask` |
| `task.setPriorityB` | Set priority B | — | — | `isTask` |
| `task.setPriorityC` | Set priority C | — | — | `isTask` |
| `task.setScheduled` | Set scheduled date | — | — | `editorFocused \|\| blockSelected` |
| `task.setDeadline` | Set deadline date | — | — | `editorFocused \|\| blockSelected` |
| `task.setMarkerTodo` | Mark TODO | — | — | `editorFocused \|\| blockSelected` |
| `task.setMarkerDoing` | Mark DOING | — | — | `editorFocused \|\| blockSelected` |
| `task.setMarkerDone` | Mark DONE | — | — | `editorFocused \|\| blockSelected` |
| `task.setMarkerWaiting` | Mark WAITING | — | — | `editorFocused \|\| blockSelected` |
| `task.setMarkerCanceled` | Mark CANCELED | — | — | `editorFocused \|\| blockSelected` |
| `task.clearMarker` | Clear task marker | — | — | `isTask` |

**R34.** `task.cycle` reads the target block's current `marker` and advances it exactly:
`null → TODO → DOING → DONE → null` (wrapping). `WAITING` and `CANCELED` are never reached by
cycling — only by `task.setMarkerWaiting`/`task.setMarkerCanceled` from the palette, the block
context menu, or the slash menu (this is the literal ADR/PLAN §8 requirement, satisfied exactly
by having those two states be separate commands with no place in the cycle). Any transition whose
**new** marker is `DONE` follows R35 (the repeat-aware completion rule) instead of a plain
marker write. Bulk-cycling more than one selected block at once is out of scope for v1 (§ Open
issues) — hence the `selectionCount == 1` guard.

**R35.** Completing a task (any command that would set `marker = DONE` — `task.cycle`'s
`DOING → DONE` step, `task.toggleDone`, or `task.setMarkerDone`) MUST: stamp the block's `done`
property with the current time as an ISO 8601 UTC string, regardless of `repeat`. Then: if the
block has **no** `repeat` property, set `marker = DONE` and stop. If it **has** a `repeat`
property (`"<n><unit>"` or `"<n><unit> from done"`, ADR 011), do **not** set `marker = DONE`;
instead advance `scheduled`/`deadline` (whichever is present; if both, advance both) by the
repeat interval — from the **original** `scheduled`/`deadline` date if the repeater has no
`from done` suffix, or from the just-stamped `done` timestamp if it does — and reset
`marker = TODO`, leaving the task open for its next occurrence. `done` is still stamped in the
repeating case, so "what did I finish this week" queries over the op log/property see every
occurrence.

**R36.** `task.toggleDone` is the checkbox-click equivalent: if the target block's `marker` is
`DONE`, set `marker = TODO` (does not restore whatever pre-DONE state it had — Logseq's own
behavior, kept for simplicity). Otherwise (marker is `TODO`, `DOING`, or `WAITING`; `isTask`
already excludes `null`), apply R35. `CANCELED` is left as-is by a checkbox click (there is no
checkbox rendered for a canceled task; toggling it back on is a palette/menu action,
`task.setMarkerTodo`). No default keybinding: the primary triggers are the rendered checkbox
widget (pointer/tap, does not enter edit mode) and the mobile toolbar's checkbox button
(§ Mobile).

**R37.** `task.setPriorityA/B/C` set the block's `priority` property to `A`/`B`/`C` directly (no
cycling). No default keybinding, matching PLAN §4's "priority ... has no UI focus": these are
palette/properties-panel-only in v1.

**R38.** `task.setScheduled` / `task.setDeadline` open a date picker anchored at the caret (or at
the selected block's row) with this minimal interaction: a single-month calendar grid defaulting
to today (or the block's existing `scheduled`/`deadline` date if set), Left/Right/Up/Down move the
highlighted day by 1/7, PageUp/PageDown move by a month, Enter confirms the highlighted day,
Escape cancels without writing anything, and typing digits (`YYYY-MM-DD`) jumps directly to that
date without using the grid. A collapsed-by-default "Add time" toggle reveals a 24-hour `HH:MM`
field, appended to the date with a space per ADR 011. A collapsed-by-default "Repeat" toggle
reveals `<number> <unit: day|week|month|year>` plus a "from completion" checkbox, writing the
`repeat` property in the same transaction (`repeat:: 1w` or `repeat:: 1w from done`). Confirming
writes exactly `scheduled:: 2026-09-12` / `deadline:: 2026-09-14 14:00` — ISO date, optional
24-hour time, no weekday, no angle brackets, no timezone (ADR 011, verbatim format). No default
keybinding: reached via the `/scheduled` / `/deadline` slash items or the palette.

**R39.** `task.setMarkerTodo/Doing/Waiting/Canceled` set `marker` to that literal value with no
side effects beyond that (no `done` stamping — only reaching `DONE` triggers R35).
`task.setMarkerDone` sets `marker` via R35 (so it is repeat-aware, unlike the other four).
`task.clearMarker` sets `marker = null` and leaves `priority`/`scheduled`/`deadline`/`repeat`/
`done` untouched (clearing the marker does not delete task metadata, so re-adding a marker later
restores the same schedule). None of the six has a default keybinding; all six are reachable from
the palette, the block's context menu, and (for Todo only) the slash menu's "TODO/task" item.

#### E.3 Navigation and palette (categories `Navigation`)

| id | title | mac | other | when |
|---|---|---|---|---|
| `palette.open` | Open command palette | Cmd+K | Ctrl+K | `true` |
| `nav.switchPage` | Switch page | Cmd+O | Ctrl+O | `true` |
| `nav.todayJournal` | Open today's journal | Cmd+J | Ctrl+J | `true` |
| `nav.journals` | Open journals | Cmd+Shift+J | Ctrl+Shift+J | `true` |
| `nav.back` | Go back | Cmd+[ | Alt+Left | `true` |
| `nav.forward` | Go forward | Cmd+] | Alt+Right | `true` |
| `nav.followLink` | Follow link under cursor | Alt+Enter | Alt+Enter | `editorFocused && caretInLink` |
| `search.open` | Open search | Cmd+Shift+F | Ctrl+Shift+F | `true` |

**R40.** `palette.open` opens one shared palette component (§ Interfaces, `PaletteState`) in
**mixed mode**: as the user types, results interleave fuzzy-matched pages/journals and fuzzy-
matched commands, ranked by § R56–R60, with no prefix required. Typing `>` as the first character
switches the same open palette to **commands-only** mode for the rest of that session (VSCode-
style disambiguation), typing `#` switches it to tags, and clearing the query returns to mixed
mode. Pressing `Cmd/Ctrl+K` again while the palette is already open **closes** it (toggle).

**R41.** `nav.switchPage` opens the identical palette component already locked to **pages-and-
journals-only** mode (equivalent to typing nothing and having mixed mode pre-filtered to just the
page results) — this is the fast, muscle-memory path for the single most frequent action
(PLAN's own data: journals are the primary capture surface), separate from `palette.open` so it
never has to compete with command results or the `>`/`#` prefix convention. See Open issues for
why this is a second command rather than folding page-jumping entirely into `Cmd/Ctrl+K`.

**R42.** `nav.todayJournal` navigates to today's journal (creating no page row until a block is
written, per PLAN §8). `nav.journals` opens the Journals stream view (today pinned at top, older
non-empty days below, infinite scroll). `nav.back` / `nav.forward` move through the app's internal
navigation history (page opens, zoom-ins/outs, journal-day opens) — a stack independent of the
browser's own history API, though a PWA/browser build MAY also push corresponding
`history.pushState` entries so the OS/browser back gesture stays in sync.

**R43.** `nav.followLink` navigates to the page, block, or URL the caret is currently in or
immediately adjacent to (`caretInLink`): a `wikilink` opens that page (creating it if it does not
exist and the user confirms, mirroring the "Create" affordance of § F), a `tag` opens that tag
page, a `blockref` scrolls to and briefly highlights that block on its page, and a bare/`link`
URL opens in a new tab/window. The pointer equivalent while editing is Cmd/Ctrl+Click (a plain
click only moves the caret, since the block is in raw-markdown edit mode); while **not** editing
(rendered view), a plain click on any of these already navigates, so `nav.followLink`'s keyboard
form exists specifically for the editing case.

**R44.** `search.open` opens the full-text/semantic/hybrid search view (PLAN §9) — filterable by
tag/page/namespace/date/marker, with snippets. This is **not** the excluded graph-view feature
(PLAN §2 non-goals list "graph view" as cut for v1); it is ordinary search with a persistent
results panel, distinct from the ephemeral `palette.open`/`nav.switchPage` popovers.

#### E.4 Formatting (category `Formatting`)

| id | title | mac | other | when |
|---|---|---|---|---|
| `format.bold` | Bold | Cmd+B | Ctrl+B | `editorFocused` |
| `format.italic` | Italic | Cmd+I | Ctrl+I | `editorFocused` |
| `format.strikethrough` | Strikethrough | Cmd+Shift+X | Ctrl+Shift+X | `editorFocused` |
| `format.highlight` | Highlight | Cmd+Shift+H | Ctrl+Shift+H | `editorFocused` |
| `format.inlineCode` | Inline code | Cmd+E | Ctrl+E | `editorFocused` |
| `format.insertLink` | Insert link | Cmd+Shift+K | Ctrl+Shift+K | `editorFocused` |
| `format.insertPageRef` | Insert page reference | — | — | `editorFocused` |
| `format.insertTag` | Insert tag | — | — | `editorFocused` |
| `format.insertBlockRef` | Insert block reference | — | — | `editorFocused` |

**R45.** `format.bold`/`italic`/`strikethrough`/`highlight`/`inlineCode` toggle the corresponding
marker pair (`**…**`, `*…*`, `~~…~~`, `==…==`, `` `…` ``) around the current text selection; with
no selection, they insert an empty pair and place the caret between the markers (type-ahead
formatting). Toggle means: if the selection (or the text immediately surrounding a collapsed
caret) is already wrapped in that exact marker pair, the markers are removed instead of doubled.
Markers never cross a `\n` inside the block.

**R46.** `format.insertLink` inserts `[]()` around the selection as `[selected text]()` (selection
becomes the link text, caret lands inside the empty `()`), or `[]()`  with the caret inside `[]`
when there is no selection.

**R47.** `format.insertPageRef` / `format.insertTag` / `format.insertBlockRef` insert the literal
trigger characters `[[` / `#` / `((` at the caret (replacing the current selection, if any, as
the query seed) and then invoke the same autocomplete pipeline typing them would (§ F) — this is
"triggering the popup programmatically," not a separate insertion mechanism. No default
keybinding: typing the trigger character is already the natural desktop gesture; these commands
exist for the palette, the slash menu ("page ref" / "tag" items), and the mobile toolbar's `[[`,
`#`, `((` buttons.

#### E.5 Insert / slash-menu-only commands (category `Insert`, id area `block`)

| id | title | mac | other | when |
|---|---|---|---|---|
| `block.setHeading1` | Heading 1 | — | — | `editorFocused` |
| `block.setHeading2` | Heading 2 | — | — | `editorFocused` |
| `block.setHeading3` | Heading 3 | — | — | `editorFocused` |
| `block.insertCodeFence` | Code block | — | — | `editorFocused` |
| `block.insertTable` | Table | — | — | `editorFocused` |
| `block.insertImage` | Image | — | — | `editorFocused` |
| `block.embedPage` | Embed page | — | — | `editorFocused` |
| `block.embedBlock` | Embed block | — | — | `editorFocused` |
| `block.insertToday` | Today's date | — | — | `editorFocused` |
| `block.insertProperty` | Property | — | — | `editorFocused` |
| `block.openSlashMenu` | Open slash menu | — | — | `editorFocused && atLineStart` |

**R48.** `block.setHeading1/2/3` prefix the block's content with `# `/`## `/`### ` (replacing any
existing leading heading-marker run of 1–6 `#` characters, so re-applying a different level
changes it rather than stacking markers). `block.insertCodeFence` inserts a two-line skeleton
` ```\n``` ` around the caret (language left blank, cursor on the empty first line) when the
block is empty, or wraps the current content in a fence if it is not. `block.insertTable` inserts
a 2×2 GitHub-flavored-markdown table skeleton (header row + separator + one body row) as the
block's content. `block.insertImage` opens the platform file picker (`platform.files.pick`,
research 08 §6); the chosen file is uploaded as an asset and `![](<asset-url>)` is inserted,
exactly mirroring the image-paste path of R33 case 3.

**R49.** `block.embedPage` inserts `{{embed [[Page]]}}` with the page name pre-filled from the
current query (opening the same page-fuzzy-match affordance as `[[`, § F) if invoked with no
target yet selected. `block.embedBlock` inserts `{{embed ((id))}}` via the same block-ref search
as `((`. `block.insertToday` inserts a reference to today's journal in the recognized display
format (a `[[<journal title>]]` wikilink resolving to today's `journalDay`, per PLAN §8's
"references in any recognized date format resolve to the day"). `block.insertProperty` opens a
property-key picker (fuzzy list of existing property-definition pages, plus "Create `<key>`") and
inserts a `key:: ` line at the correct position (a contiguous property-line run at the very start
or very end of the block's content — the parser's rule, research 04 §4.2 — never in the middle).

**R50.** `block.openSlashMenu` inserts the literal character `/` at the caret and lets the normal
slash-trigger matcher (§ F) pick it up — it exists solely so the mobile toolbar can offer a `/`
button without the user first tapping to position the caret at a valid trigger spot; its `when`
requires `atLineStart` so it only fires where `/` would actually trigger (§ R51), matching desktop
behavior exactly rather than special-casing mobile.

#### E.6 App-level (categories `App`)

| id | title | mac | other | when |
|---|---|---|---|---|
| `edit.undo` | Undo | Cmd+Z | Ctrl+Z | `true` |
| `edit.redo` | Redo | Cmd+Shift+Z | Ctrl+Shift+Z | `true` |
| `app.toggleSidebar` | Toggle sidebar | Cmd+\ | Ctrl+\ | `true` |
| `app.openSettings` | Open settings | Cmd+, | Ctrl+, | `true` |
| `app.openPluginManager` | Open plugin manager | — | — | `true` |
| `sync.now` | Sync now | — | — | `true` |
| `app.toggleTheme` | Toggle theme | — | — | `true` |
| `app.hideKeyboard` | Hide keyboard | — | — | `mobile && editorFocused` |

**R51.** `edit.undo` / `edit.redo` operate the document-level history manager of ADR 006 / research
04 §7 (a document-level history of inverse ops with 500 ms text coalescing — CM6's own
`history()` extension is never installed, per that spec); they undo/redo the last **local**-origin
transaction regardless of whether it was a text edit, a split, an indent, a move, a paste of five
blocks, or a subtree delete, and restore the caret/selection recorded with that transaction.

**R52.** `app.toggleSidebar` shows/hides the navigation sidebar (page tree, journals, tags).
`app.openSettings` opens the settings view (which includes the keybindings editor, § G).
`app.openPluginManager` opens the installed-plugins view. `sync.now` requests an immediate
push/pull cycle against the server outside the normal background schedule (no default key: sync
is automatic; this is a rare manual escape hatch, reachable from the palette and a status-bar
icon click). `app.toggleTheme` cycles light → dark → system. `app.hideKeyboard` calls
`platform.keyboard.hide()` (research 08 §3.2's `KeyboardAdapter`) and commits/unmounts the
surface without navigating away from the block; it only appears (as the toolbar's rightmost
button, § Mobile) when `mobile`.

### F. Slash menu

**R53.** The slash menu triggers on `/` typed such that the character immediately preceding it
(if any) is whitespace, or `/` is the first character of the block's content — i.e. `/` at the
start of a text run, matching `matchBefore(/(^|\s)\/([\w-]*)$/)`. It does **not** trigger
mid-word (`a/b` never opens it) and a second `/` typed immediately after the first (`//`) does
not retrigger a new popup (the existing one, if open, simply has no matches and shows "No
results"). The popup closes (with no insertion beyond whatever was typed) on: Escape; the query
no longer matching `/[\w-]*` (e.g. a space is typed — the query cannot contain spaces because no
slash-item label needs one); or deleting back through the triggering `/`. Selecting an item runs
that item's command (§ table below) with the triggering `/` and any typed query text removed from
the block first.

**R54.** Slash-menu item list (core v1; each maps to an existing command from §E), in default
(no-query) order, with the filter keywords the fuzzy matcher (§ H) also matches against:

| Label | Command | Keywords |
|---|---|---|
| TODO / task | `task.setMarkerTodo` | task, checkbox, marker |
| Heading 1 | `block.setHeading1` | h1, title |
| Heading 2 | `block.setHeading2` | h2, subtitle |
| Heading 3 | `block.setHeading3` | h3 |
| Code block | `block.insertCodeFence` | code, fence, ``` |
| Table | `block.insertTable` | grid |
| Image | `block.insertImage` | picture, photo, upload |
| Scheduled | `task.setScheduled` | date, when, plan |
| Deadline | `task.setDeadline` | date, due |
| Embed page | `block.embedPage` | transclude |
| Embed block | `block.embedBlock` | transclude, ref |
| Page reference | `format.insertPageRef` | link, wikilink, `[[` |
| Tag | `format.insertTag` | `#` |
| Today's date | `block.insertToday` | journal, now |
| Property | `block.insertProperty` | metadata, `::` |

Templates are **not** a core slash item (PLAN §2 cuts templates from core entirely — "later as a
plugin or slash command"); a plugin that adds one contributes it declaratively the same way any
plugin command joins the slash menu (PLAN §12/§13), appearing under its own category once loaded.

**R55.** Items are filtered by the typed query (the text after `/`) against `Label` **and**
`Keywords` using the same fuzzy scorer as the palette (§ H); with an empty query, items show in
the table order above (a fixed, hand-ordered "most useful first" default, not alphabetical).
Keyboard navigation: Up/Down move the highlight (clamped, no wraparound), Enter or Tab accepts
the highlighted item, Escape closes.

### G. Autocomplete popups (`[[`, `#`, `((`)

**R56.** `[[` (page reference): triggers on `matchBefore(/\[\[([^\]\n]*)$/)` — i.e. as soon as a
second `[` is typed immediately after a first one (CM6's `closeBrackets()` auto-inserts the
matching `]]`, so in practice the user sees `[[|]]` with the caret between). The query is
diacritic-folded (§ H) and fuzzy-matched against page names and aliases, most-recent-page-first
on a tie (reusing the palette's page ranking, § R59). If no existing page's name matches the
query exactly (case-insensitively), the last item is `Create "<query>"`. Selecting an item
replaces the span from just after `[[` through the caret with `<title>]]` (consuming the
already-present auto-paired `]]` rather than duplicating it) and places the caret after the
closing `]]`. Closes on: Escape (leaves `[[` and whatever was typed as plain text — no
completion is applied); deleting back through either `[` of the trigger; or selecting an item.

**R57.** `#` (tag): triggers on `matchBefore(/(^|\s)#([^\s#]*)$/)` (start-of-run, same rule as the
slash trigger, so `word#tag` does not open it). Matching and the "Create" affordance are identical
to R56, over tag pages instead of all pages. A query containing a space is only reachable by first
typing `#[[`, which switches to the multi-word tag form `#[[multi word]]`; selecting an item in
that form inserts `#[[<title>]]` instead of `#<title>`.

**R58.** `((` (block reference): triggers on `matchBefore(/\(\(([^)\n]*)$/)`. The query is
fuzzy-matched against the **local replica's** block content (full text, not just titles — this is
a full-text-style match, not the title-only match of R56/R57), each result shown as a short
snippet of the block's rendered text plus its page name/breadcrumb. There is no "Create" item
(you cannot create a new block purely by referencing one). Selecting an item inserts `((<id>))`
and moves the caret past the closing `))`. Closes on Escape (as R56, leaves typed text as-is),
deleting back through either `(`, or selecting an item.

**R59.** Keyboard navigation is identical across `[[`, `#`, `((`, and the slash menu: Up/Down move
the highlight without wraparound; Enter selects the highlighted item; Tab also selects it (an
explicit alternate accept key, useful since Enter is heavily overloaded elsewhere in the editor);
Escape closes without selecting. All four popups are positioned by CM6's `tooltips({ position:
'fixed', parent: document.body })` so they escape row/overflow clipping (research 04 §3.5); on
`mobile`, they render as a sheet anchored above the keyboard toolbar instead of a floating
tooltip, reusing the same completion/selection state machine.

### H. Mobile keyboard toolbar and gestures

**R60.** The keyboard toolbar is a single fixed row shown only while `mobile && editorFocused`
(`--kb > 0`, research 08 §3.2/§3.3), positioned by the `--kb` CSS variable, never by `bottom: 0`.
It has exactly 12 buttons, in this fixed left-to-right order (fewer than the desktop keymap by
design — PLAN §14's "toolbar with indent/outdent/move/task/date" plus the four autocomplete
triggers and the three history/dismiss actions cover the touch-first vocabulary; everything else
stays reachable through the slash menu or a long-press menu):

| # | Icon | Command |
|---|---|---|
| 1 | ⇤ | `block.outdent` |
| 2 | ⇥ | `block.indent` |
| 3 | ↑ | `block.moveUp` |
| 4 | ↓ | `block.moveDown` |
| 5 | `[[ ]]` | `format.insertPageRef` |
| 6 | `#` | `format.insertTag` |
| 7 | `(( ))` | `format.insertBlockRef` |
| 8 | `/` | `block.openSlashMenu` |
| 9 | ☐ | `task.toggleDone` |
| 10 | ↺ | `edit.undo` |
| 11 | ↻ | `edit.redo` |
| 12 | ⌄ | `app.hideKeyboard` |

**R61.** Toolbar buttons MUST call `event.preventDefault()` on `pointerdown` (not just `click`) so
focus never leaves the mounted `Surface` — losing focus for even one frame drops the iOS keyboard
(research 08 §3.3/§3.4). Each button's tap runs the same command `run(ctx)` a keyboard shortcut
would, with `ctx` built from the currently-focused block exactly as § C describes; buttons whose
`when` is false for the current context (e.g. `task.toggleDone` when the focused block is not a
task) render disabled rather than being hidden, so the row's width/layout never shifts as the
user types.

**R62.** Touch gestures on a block row (research 08 §3.5/§3.6), independent of the toolbar:

- **Swipe right on the bullet** (`touch-action: pan-y` on the row; horizontal drag past 48 px,
  clamped to ±72 px while dragging) runs `block.indent` on release.
- **Swipe left on the bullet** past −48 px runs `block.outdent` on release.
- **Long-press on the bullet** (250–400 ms hold, <8 px movement) starts a drag: the row is lifted
  with a shadow/clone, the outliner auto-scrolls near the viewport edges, and on release the block
  (with its subtree) is moved to the computed drop position via the same underlying move primitive
  as `block.moveUp`/`block.moveDown` (§ R22) but with an arbitrary target `{parentId, afterId}`
  instead of "one position up/down among siblings." A drag emits `haptics.selection()` each time
  the computed drop index changes, and `haptics.impact('medium')` on lift.
- A swipe or long-press that starts on the block's **text** (not the bullet/handle) is never
  intercepted — it must remain native text selection/caret placement, per research 08 §3.6.

None of the three gestures has a corresponding desktop mouse gesture beyond the existing drag
handle (research 04 §3.8); they exist because Tab/Shift-Tab/Alt+Up/Down have no soft-keyboard
equivalent (research 04 §3.4's "Mobile: Tab/Shift+Tab/Alt+arrows have no keys → toolbar buttons
call the same commands").

### I. `keybindings.json`

**R63.** Schema (see Interfaces for the literal type): `keybindings.json` is a JSON array of
`KeybindingEntry` rows, `{ key, command, when?, args? }`. `key` is one of: a resolved token per
R15 (`"Cmd+Enter"`) which applies **only** on the platform it names; a neutral token using `Mod`
(`"Mod+Enter"`) which resolves to `Cmd` on mac and `Ctrl` elsewhere at load time; a platform pair
object `{ "mac": "Cmd+Enter", "other": "Ctrl+Enter" }` for the (rare) case where the two platforms
need genuinely different keys, not just a different modifier spelling; or a chord — any of the
above forms, space-separated (`"Mod+K Mod+S"`) — matched over a 1500 ms window between key
presses (exceeding it cancels the chord-in-progress with no effect). `command` is a command id;
prefixing it with `-` (`"-block.duplicate"`) means "remove," not "bind" (§ R66).

**R64.** The full runtime keymap is assembled once per load, in this order (later entries win
ties, per R12's resolution walk):
1. **Base defaults**: one row per command per resolved platform, flattened from every command's
   `defaultKeys` (§ E), `when` copied from the command.
2. **Secondary defaults**: the small, core-defined, non-user-editable list of extra rows named
   throughout §E (currently exactly one: `Delete → block.deleteSelected` when `blockSelected`,
   R21).
3. **User rows**: the contents of `keybindings.json`, applied in array order.

**R65.** A user row whose `command` does **not** start with `-` is an **addition**: it is appended
as a new candidate row for its resolved key (it does not replace or remove any existing row for
that key — several rows may legally coexist on one key as long as at most one has a `when` that
evaluates `true` at any given moment, per R12's precedence walk). If `when` is omitted on the
row, it inherits the target command's own `when` (not "always"); an explicit `when` on the row
**replaces** the command's own `when` for this binding only (letting a user, say, make
`block.duplicate` available even in `blockSelected` mode without changing the command's built-in
default binding's condition elsewhere).

**R66.** A user row whose `command` starts with `-` is a **removal**: it deletes every row —
base, secondary, or earlier-user — whose resolved key equals this row's key and whose `command`
equals the part after `-`. If the removal row also specifies `when`, only rows with that **exact**
`when` string are removed; if `when` is omitted on the removal row, all rows for that key+command
are removed regardless of their `when`. A removal row with no matching row to remove is a no-op
(not an error) — this keeps `keybindings.json` forward-compatible if a future release changes a
default.

**R67.** **Conflict detection** (surfaced in the settings UI, not enforced/blocking): two rows
conflict if they resolve to the same key on the same platform and their `when` clauses are not
provably disjoint. "Provably disjoint" uses exactly the R11 mutually-exclusive-pairs table — a
general decision procedure for arbitrary `when` strings is undecidable in the general case, so
the checker is deliberately conservative: any two rows sharing a key that are **not** covered by
a known-exclusive pair are flagged, even if a human could see they never actually overlap. Each
flagged command shows a warning icon in the keybindings list naming the other command(s) it
conflicts with on that key; the runtime still resolves the conflict deterministically via R12
(later-loaded row wins) — flagging is purely informational, never blocking.

**R68.** Syncing: the entire array is the value of one setting, `input.keybindings` (per the
conventions doc's `dotted.lower.case` rule), synced like any other setting via the op log (a
`settings.set`-shaped op — the exact settings storage table/op is defined by a future settings
spec and is out of scope here). The settings UI's keybindings screen is a structured editor
(list + conflict badges + "record a shortcut" capture field per ADR 009) that reads and writes
the same JSON value; a "view as JSON" toggle in that screen edits the literal array text
directly. There is no separate file on disk named `keybindings.json` in the sync path — that name
denotes the JSON **shape**, which the settings UI happens to expose losslessly as text, not a
filesystem artifact (unlike the markdown mirror, which is real files by design — ADR 002).

### J. Palette and slash-menu ranking

**R69.** The fuzzy-match library is **fuzzysort 4.0.2** (`npm view fuzzysort` on 2026-09-10:
zero dependencies, MIT, last published four weeks before this spec — the most recently
maintained of the realistic candidates checked, the others being `@leeoniya/ufuzzy` 1.0.19,
`fuse.js` 7.5.0, and `match-sorter` 8.3.0), used for: the command palette, the page switcher, the
slash menu, and the `[[`/`#` autocomplete sources (§ R56–R57; `((` matches full block text with
the same library, just against a longer haystack per candidate). Reasons over the alternatives:
purpose-built "SublimeText-like" scoring is exactly the expected feel for a Cmd+K-style palette;
it returns per-character match-position data used to bold the matched substrings in the result
list (needed for the UI, not just the ranking); and it needs no configuration object or index
build step (`fuse.js`/`match-sorter` both want a pre-declared key/weight config per collection,
which is unnecessary overhead for four simple string collections).

**R70.** Query normalization (applied to both the query and every candidate string before
scoring, everywhere fuzzysort is used, so page-name/alias matching folds diacritics per PLAN §9's
"`č` matches `c`"): `str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()` — NFD
decomposition splits `č` into `c` + a combining caron (U+030C), and the regex strips every
codepoint U+0300–U+036F (the Unicode "Combining Diacritical Marks" block). This mirrors the
server's `unicode61`-with-diacritics-removed FTS tokenizer (PLAN §9) so client-side fuzzy ranking
and server-side full-text search agree on what counts as a match.

**R71.** MRU tracking: a per-device, unsynced, capped list (`N = 20`) of `{ kind: 'command' |
'page', id, lastUsedAt }`, updated whenever a command successfully runs via `ctx.exec` (any
trigger — keybinding, palette, slash menu, toolbar, menu) or a page is opened via `nav.switchPage`
or `palette.open`. Stored client-side (e.g. `localStorage`/IndexedDB), never written to
`keybindings.json` and never synced as a setting (it is UI convenience state, not user
configuration).

**R72.** Ranking with an **empty** query: results are the MRU list, most-recent-first, followed by
every remaining command/page not in the MRU, in a fixed fallback order (commands: registration
order grouped by category; pages: most-recently-*edited* first, reusing the page list's existing
recency, not the MRU). This gives "recent first" with no typing, matching common palette UX.

**R73.** Ranking with a **non-empty** query: compute `fuzzysort.single(normalizedQuery,
normalizedCandidateTitle)` for every candidate (also against each page's aliases, keeping the
best of the title/alias scores per page); discard candidates with no match (`null` result).
Sort by the tuple, most-significant first: (1) fuzzy score, descending (fuzzysort's own
best-match-wins ordering — an exact/prefix match always outranks a scattered one, so recency
never overrides a clearly better textual match); (2) MRU position ascending (more-recently-used
wins a tie — `Infinity` for anything not in the MRU); (3) title, alphabetical; (4) `id`,
alphabetical (final deterministic tiebreak, so ranking is reproducible for a test suite). The
slash menu uses the identical algorithm over its item list (§ R54/R55), sharing the **same** MRU
store as the palette (slash items are commands, so using one location's MRU updates naturally
also promotes it in the other).

## Interfaces

```ts
// ── Command registry ────────────────────────────────────────────────────────

interface Command {
  id: string;                                   // "<area>.<verb>", see R2
  title: string;                                // palette/menu display text
  description?: string;                         // longer help text, palette secondary line
  category: string;                             // palette grouping, see R3
  when?: string;                                 // grammar in § B; absent = always enabled
  defaultKeys: { mac?: string; other?: string }; // resolved-form tokens, see R15
  icon?: string;                                 // icon-set key, palette/menu/toolbar glyph
  run: (ctx: CommandContext) => void | Promise<void>;
}

interface WhenContext {
  editorFocused: boolean;
  blockSelected: boolean;
  hasSelection: boolean;
  selectionCount: number;
  isTask: boolean;
  isCollapsed: boolean;
  hasChildren: boolean;
  atLineStart: boolean;
  atLineEnd: boolean;
  onFirstVisualLine: boolean;
  onLastVisualLine: boolean;
  caretInLink: boolean;
  popupOpen: boolean;
  composing: boolean;
  zoomed: boolean;
  platform: 'mac' | 'windows' | 'linux' | 'ios' | 'android';
  mobile: boolean;
}

interface CommandContext extends WhenContext {
  focusedBlockId: string | null;                // BlockId, research 04 §3.1
  selectedBlockIds: string[];                    // block-selection mode; [] otherwise
  surface: Surface | null;                       // research 04 §3.3; non-null iff editorFocused
  store: Store;                                  // read/write handle over blocks/pages (defined
                                                  // by the storage/sync spec, not here)
  exec: (commandId: string, args?: unknown) => Promise<void>; // run another command by id
  args?: unknown;                                // this invocation's payload, if any
}

// ── `when` clauses ───────────────────────────────────────────────────────────

type WhenNode =
  | { t: 'or'; left: WhenNode; right: WhenNode }
  | { t: 'and'; left: WhenNode; right: WhenNode }
  | { t: 'not'; node: WhenNode }
  | { t: 'eq' | 'neq'; ident: string; literal: string | boolean | number }
  | { t: 'ident'; name: string };                // bare identifier, truthy-tested

declare function compileWhen(src: string): WhenNode;         // throws on syntax error (R10)
declare function evaluateWhen(node: WhenNode, ctx: WhenContext): boolean; // total, never throws

// ── Keybindings ──────────────────────────────────────────────────────────────

type KeyToken = string;                          // e.g. "Cmd+Enter", "Mod+K Mod+S" (chord)

interface KeybindingEntry {
  key: KeyToken | { mac?: KeyToken; other?: KeyToken };
  command: string;                               // command id, or "-<id>" to remove (R66)
  when?: string;
  args?: unknown;
}
type KeybindingsFile = KeybindingEntry[];

interface ResolvedBinding {                      // one row of the assembled runtime keymap (R64)
  key: string;                                   // platform-resolved, e.g. "Cmd+Enter"
  command: string;
  when?: string;
  source: 'base' | 'secondary' | 'user';
  order: number;                                 // load order, used by R12's resolution walk
}

interface KeymapConflict {
  key: string;
  commands: string[];                            // ≥2 command ids sharing this key, R67
}

// ── Palette / slash menu / autocomplete ─────────────────────────────────────

interface PaletteState {
  mode: 'mixed' | 'commands' | 'pages' | 'tags';
  query: string;
}

interface RankedResult<T> {
  item: T;
  score: number | null;                          // fuzzysort score; null = no match (excluded)
  mruIndex: number;                               // Infinity if not in the MRU (R73)
}

interface MruEntry { kind: 'command' | 'page'; id: string; lastUsedAt: number; }

interface SlashItem { label: string; command: string; keywords: string[]; }

interface ToolbarButton { icon: string; command: string; }

// CaretSpec / Surface are defined by research/04-editor.md §3.3 and ADR 006; repeated here only
// for the fields this spec's rules reference directly.
type CaretSpec =
  | { at: 'start' | 'end' }
  | { offset: number }
  | { goalX: number; line: 'first' | 'last' };
```

## Examples

### Logical outdenting (R19)

Before, focus on `C` (Shift+Tab):

```
- A
  - B
  - C   ← focus, outdent
  - D
  - E
- F
```

After: `C` becomes `A`'s next sibling; `D` and `E` (its younger siblings under `B`'s parent `A`)
become `C`'s children, in their original order, appended after any children `C` already had:

```
- A
  - B
- C   ← still focused, now at A's level
  - D
  - E
- F
```

### Backspace-merge into the parent (R20)

Before, focus on `B` (first child of `A`, empty content) at offset 0, Backspace:

```
- A
  - B|        ← focus, content = "note"
    - X
- C
```

`B`'s previous visible row is `A` itself (B is A's first child). Result: `A.content` becomes
`A.content + "note"`, `X` is re-parented as `A`'s child (after any pre-existing children of `A`),
`B` is deleted, caret sits at the join point inside `A`:

```
- A|note
  - X
- C
```

### `keybindings.json`

```json
[
  { "key": "Mod+Shift+D", "command": "-block.duplicate" },
  { "key": "Ctrl+D", "command": "block.duplicate" },
  { "key": { "mac": "Cmd+J", "other": "Ctrl+Alt+J" }, "command": "nav.todayJournal" },
  { "key": "Mod+K Mod+S", "command": "app.openSettings" },
  { "key": "Mod+Shift+Enter", "command": "task.setMarkerDone", "when": "editorFocused" }
]
```

Read top to bottom: row 1 removes the default `Cmd+Shift+D`/`Ctrl+Shift+D` binding for
`block.duplicate` on every platform (`Mod` = both); row 2 re-binds it to `Ctrl+D` (which, being a
plain "other/mac-neutral" `Ctrl+D` token — not `Mod+D` — applies literally on every platform,
including mac, per R63); row 3 gives `nav.todayJournal` a different physical key on Windows/Linux
than on mac rather than just swapping `Cmd` for `Ctrl`; row 4 adds a two-key chord for opening
settings, coexisting with the default `Cmd/Ctrl+,`; row 5 adds a brand-new binding for
`task.setMarkerDone` with an explicit `when` that narrows it to `editorFocused` only (excluding
the `blockSelected` case the command would otherwise also be reachable from via the palette).

## Test cases

### `when`-clause evaluator (R6–R9)

| Expression | Context (fields not listed are `false`/`0`) | Result |
|---|---|---|
| `editorFocused` | `{ editorFocused: true }` | `true` |
| `editorFocused && !hasSelection` | `{ editorFocused: true, hasSelection: true }` | `false` |
| `editorFocused \|\| blockSelected` | `{ blockSelected: true }` | `true` |
| `platform == 'mac'` | `{ platform: 'mac' }` | `true` |
| `platform == 'mac' && mobile` | `{ platform: 'mac', mobile: false }` | `false` |
| `selectionCount == 1` | `{ selectionCount: 1 }` | `true` |
| `!zoomed` | `{ zoomed: false }` | `true` |
| `(editorFocused \|\| blockSelected) && hasChildren && !isCollapsed` | `{ editorFocused: true, hasChildren: true, isCollapsed: false }` | `true` |
| `bogusVar` | `{}` | `false` |
| `bogusVar == false` | `{}` | `false` (R9: an unknown identifier never equals anything) |
| `bogusVar != false` | `{}` | `true` (R9: `!=` is `!(==)`) |

### Keybinding conflict detection (R67)

| Row A | Row B | Same key? | Flagged conflict? |
|---|---|---|---|
| `{key:"Cmd+Up", command:"block.collapse"}` | `{key:"Cmd+Up", command:"block.expand"}` | yes | **No** — `when`s differ only by `isCollapsed`/`!isCollapsed` on an identical target, but the checker's table (R11) only special-cases `editorFocused`/`blockSelected`; per R67 this pair actually **is** flagged (conservative checker), even though the states never truly overlap. Implementer note: this is the expected, documented false positive — see Open issues. |
| `{key:"Backspace", command:"block.mergeWithPrevious", when:"editorFocused && atLineStart && !hasSelection"}` | `{key:"Backspace", command:"block.deleteSelected", when:"blockSelected"}` | yes | No — `editorFocused` vs `blockSelected` is the one known-exclusive pair (R11). |
| `{key:"Cmd+Shift+D", command:"block.duplicate"}` | `{key:"Cmd+Shift+D", command:"plugin.foo.thing"}` | yes | Yes — no exclusivity relationship known between them. |

### Fuzzy ranking (R72–R73)

Given commands `["Toggle sidebar" (app.toggleSidebar), "Open settings" (app.openSettings), "Open plugin manager" (app.openPluginManager)]`, MRU = `[{kind:'command', id:'app.openSettings'}]`:

- Query `""` → order: `app.openSettings` (in MRU), then `app.toggleSidebar`, `app.openPluginManager` (registration order).
- Query `"open"` → both "Open settings" and "Open plugin manager" score equally as prefix matches of "Open "; tiebreak by MRU position puts `app.openSettings` first, then `app.openPluginManager`; `app.toggleSidebar` does not match "open" as a prefix of any word boundary as strongly and, per fuzzysort's scoring, ranks below both (present only if it scores at all — "toggle sidebar" contains no contiguous "open").

## Open issues

1. **Zoom-out key** (`block.zoomOut`, R27) is not specified by PLAN.md/ADR 006 (only zoom-**in**,
   `Cmd/Ctrl+.`, is). This spec picks `Cmd/Ctrl+Shift+.` — the plain Shift-modifier reversal of
   the zoom-in key — over research 04's alternative suggestion (`Mod+Shift+A` / `Alt+Enter` for
   zoom-in itself, which this spec did not adopt since PLAN.md already fixes zoom-in to
   `Cmd/Ctrl+.`). Breadcrumb click remains the discoverable mouse path either way.
2. **Palette vs. page switcher** (R40–R41): PLAN §12 describes one `Cmd/Ctrl+K` palette that
   "searches commands and pages." This spec keeps that literally true (`palette.open`, mixed
   mode) but adds `nav.switchPage` (`Cmd/Ctrl+O`) as a second entry point into the **same**
   component, pre-scoped to pages — matching Obsidian's Quick Switcher / VSCode's `Ctrl+P` vs.
   `Ctrl+Shift+P` split, and justified by PLAN's own data that journal/page navigation is the
   single highest-frequency action. This is an elaboration of PLAN §12, not a contradiction: the
   `Cmd/Ctrl+K` palette still does exactly what PLAN says.
3. **Marker-cycle key** (`task.cycle`, `Cmd/Ctrl+Enter`) and **collapse/expand keys**
   (`Cmd/Ctrl+Up/Down`) are not judgment calls made in this document — PLAN.md §7 states both
   explicitly. They are listed in the tables for completeness only.
4. **`block.moveUp`/`moveDown`** use plain `Alt+Up/Down` on every platform. Research 04's contract
   table parenthetically suggests `Mod+Shift+Up/Down` as a mac alternative; this spec did not
   adopt that, favoring PLAN §7's plain, platform-uniform "Alt+Up/Down move the block" and one
   canonical binding per command everywhere in this document.
5. **`block.deleteForwardMerge`** (Delete-at-end merging the *next* block in) is this spec's own
   extrapolation, built as the precise mirror of `block.mergeWithPrevious`; research 04 names the
   command (`mergeNextIntoThis`) but does not detail child-reparenting. The reparent-as-trailing-
   children rule (R21) was chosen for consistency with R20 rather than independently verified
   against Logseq.
6. **Redo key** on non-mac platforms is `Ctrl+Shift+Z` rather than the Windows-native `Ctrl+Y`, to
   keep exactly one canonical cross-platform mental model (Shift+Z reverses Z everywhere); `Ctrl+Y`
   is not bound by default and is available for a user to add via `keybindings.json`.
7. Several commands intentionally ship with **no default keybinding** (priorities, scheduled/
   deadline pickers, all six discrete marker-setters, collapse-all/expand-all, sync-now, theme
   toggle, plugin manager, all three insert-ref commands, all ten slash-only inserts): each is a
   deliberate, unambiguous "palette/menu/slash-only" decision recorded once here rather than
   repeated per command, following PLAN §4's explicit de-emphasis of priorities and the general
   "small scope" principle (PLAN §1.3) of not inventing shortcuts nothing in the source material
   asked for.
8. **Keybinding-conflict false positives** (R67, Test cases table row 1): the conservative
   disjointness checker will flag `block.collapse`/`block.expand` on `Cmd/Ctrl+Up`/`Down`
   respectively as non-conflicting only because they use *different* keys (Up vs Down); had a
   future change ever put two `isCollapsed`-gated commands on the *same* key, the checker would
   flag a conflict that cannot actually occur at runtime. Extending R11's table to cover
   `isCollapsed`/`!isCollapsed`-style state pairs is left for a future revision if this proves
   noisy in practice.
9. **Bulk task-cycling**: `task.cycle` only fires with `selectionCount == 1` in block-selection
   mode (R34); cycling every selected block's marker at once is out of scope for v1, matching the
   plan's general "small scope" stance — a user wanting to mark several tasks DONE at once uses
   `task.setMarkerDone` from the block context menu on each, or the Tasks view's bulk actions
   (outside this spec).
10. **`keybindings.json` storage**: this spec fixes the JSON *shape* and its merge/precedence/
    conflict semantics (R63–R68) but defers the literal settings-storage table/op (how
    `input.keybindings` is persisted and synced) to a future settings spec, consistent with this
    document's scope being the command/keymap contract, not the settings subsystem.
11. **`copySelection`/`paste` as "commands"** (R33, R31): both are, strictly, native browser
    events intercepted by the editor rather than key-dispatched through R12; they are still
    modeled as full `Command` objects (with `defaultKeys` shown for palette/settings display) so
    they appear consistently in the palette and the keybindings UI, per ADR 009's "every operation
    is a command." Implementers should not wire these through the R12 keydown table.
