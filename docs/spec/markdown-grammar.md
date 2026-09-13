# Markdown grammar: outline format and inline content

Status: draft, implementation-ready. Builds on `00-conventions.md`. Authoritative decisions come
from `PLAN.md` and `adr/002`, `adr/004`, `adr/006`, `adr/011`; this spec refines them and MUST NOT
contradict them. Deviations are called out under Open issues. Background reading:
`research/01-logseq.md` §2 (file format) and `research/04-editor.md` §4 (tokenizer).

## 0. Purpose

This is the normative grammar for everything that turns into or out of a block's `content`
string and a page's outline text:

1. The **outline format**: how a page's markdown text (mirror file, import source, or API/MCP
   outline serialization — one format, per ADR 002 and ADR 008) maps to a tree of blocks with
   `id`, `marker`, `priority`, `properties`, `collapsed`, `content`, `children`.
2. The **inline grammar**: how one block's `content` string maps to a token stream used by the
   renderer, the CodeMirror live-preview decorations, and the reference indexer (ADR 006 — one
   tokenizer, three consumers).
3. The token model, rendering contract, live-preview contract, escaping rules, performance
   targets, the test corpus, and the precise changes `packages/core` needs.

Everything here operates on one block's text or one page's text at a time. It has no opinion on
SQL, sync, or the op log; it is the pure, synchronous, exception-free parsing layer underneath
them.

## 1. Definitions

Terms already defined in `00-conventions.md` (Graph, Page, Block, Reference, Op, Device, Origin,
Mirror, Outline format) apply unchanged. New terms this spec introduces (candidates for the
conventions glossary — not added there because this task may only touch this file and `corpus/`):

- **Pre-block**: the leading, bullet-less run of `key:: value` lines at the top of a page file;
  becomes the page's `properties`. Existing term from Logseq, used as-is.
- **Content column**: the character column at which a block's continuation lines must start:
  the bullet's indent width plus 2 (one level of nesting worth of indent-unit, see §2.2).
- **Reserved property key**: a property key with a dedicated meaning and (in the server's schema)
  a dedicated column, never a free-text property: `id`, `collapsed`, `marker`, `priority`,
  `list`, `scheduled`, `deadline`, `repeat`, `done` (ADR 004, ADR 011).
- **Import tolerance**: a spelling this grammar accepts on parse (for Logseq/Obsidian
  compatibility) but the serializer never produces. Listed explicitly per rule.
- **Canonical form**: the one spelling the serializer produces for a given piece of state. Where
  more than one input spelling parses to the same state, the canonical form is what a save
  (edit → reserialize) converges to; this is intentional normalization, not data loss.
- **Token / offset**: a `{ kind, start, end, ... }` object produced by the inline tokenizer.
  `start`/`end` are 0-based, half-open, **UTF-16 code unit** offsets into the string that was
  tokenized (same unit as JavaScript string indexing and CodeMirror 6 positions — a
  non-BMP character such as most emoji is 2 units; no rule in this grammar ever splits a
  surrogate pair).
- **Content classification**: the step that looks at a block's whole `content` string and
  decides it is one of `paragraph | heading | fence | quote | table | hr` before inline
  tokenization runs (§2.7).

## 2. Normative rules

### 2.1 File and page structure

- **OUT-1.** A page's text is: an optional pre-block (page properties), then zero or more
  top-level blocks, each written as a `- ` bulleted line optionally followed by property lines,
  continuation lines, and nested children.
- **OUT-2.** The pre-block, when present, MUST be either (a) a run of bullet-less
  `key:: value` lines at the very top of the file, terminated by a blank line or the first
  bulleted block, or (b) — import tolerance — the file's first bulleted block, when that block
  has empty content, no marker, and no children, and consists only of `key:: value` lines: it is
  consumed as page properties and does not appear as a block. The canonical serializer always
  produces form (a) and only when `page.properties` is non-empty.
- **OUT-3.** Import tolerance: YAML front matter (`---` on line 1, a closing `---`, `key: value`
  lines between) is parsed as page properties with the same key normalization as OUT-11. The
  serializer never emits front matter.
- **OUT-4.** A line matching `^([ \t]*)-(?: (.*))?$` opens a block: the bullet. Import tolerance:
  a line matching `^([ \t]*)[*+](?: (.*))?$` (Markdown's other two bullet characters) is also a
  bullet. A line matching `^([ \t]*)[0-9]+\.(?: (.*))?$` (a numbered-list marker) is also a
  bullet and additionally sets the block's `list` property to `number` (§2.4); the digits
  themselves are discarded (display numbering is derived from sibling order, not stored — this
  is also what Logseq DB does). The canonical serializer only ever emits `- `.
- **OUT-5.** Nesting depth is the indentation width of the bullet, measured in columns where a
  tab is 4 columns (unchanged from the current `outline.ts`). A block's children are the
  immediately following bulleted (or non-bulleted, OUT-9) lines whose width is strictly greater,
  up to the next line whose width is `<=` the current block's width. An over-indented line (width
  greater than "one level deeper") attaches to the nearest open ancestor at the next depth, not
  literally `width - 1`; an inconsistently dedented line closes ancestors down to the nearest one
  whose width is `<` its own (existing behavior, unchanged; see `outline.test.ts` "handles
  over-indented children and irregular dedents").
- **OUT-6.** **Canonical indent unit is two spaces** (ADR 002/PLAN §5: "two-space indentation").
  Import tolerance: tabs, 2 spaces, or 4 spaces, consistently or even inconsistently within one
  file (each line's own width is computed independently per OUT-5). The serializer's default
  writes 2 spaces per level; `SerializeOptions.indent` MAY still select `"\t"` or `"    "` for a
  caller that wants Logseq-OG-identical output.
- **OUT-7.** A continuation line is a non-bulleted line whose width is `>=` the content column
  (the open block's indent width + 2). Its indentation is stripped down to the content column
  (indent width columns, then one more indent unit — a tab or up to 2 spaces) and the remainder
  is appended to the block's `content` as a new line. Blank lines between continuation lines are
  preserved inside `content` (existing behavior).
- **OUT-8.** CRLF and lone-CR line endings are normalized to `\n` before any other parsing
  (`text.replace(/\r\n?/g, "\n")`, unchanged). The serializer always emits `\n`.
- **OUT-9.** Import tolerance: a non-bulleted line at a width that does not continue an open
  block starts a new **bulletless paragraph block** (Logseq's pre-`heading_to_list` files, or
  plain pasted text). It behaves exactly like a bulleted block for indentation/children purposes.
  The serializer never emits a bulletless block; every serialized block gets a `- `.
- **OUT-10.** A block's first content-bearing line MAY end with `[[`/`]]`-free literal syntax
  handled below (marker, priority, id). Everything between the bullet and the end of the line,
  after stripping those, is line 1 of `content`.

### 2.2 Block id (`^id` suffix)

- **OUT-11.** Canonical: a block that has an id serializes with `" ^" + id` appended to the end
  of its first line (Obsidian's own block-id syntax; ADR 004). `id` is always the 14-character
  Crockford-base32 form (`isId`, `ids.ts`) in canonical output.
- **OUT-12.** Parsing: if a block's first physical line (after any marker/priority already
  stripped, see §2.3) ends with a space followed by `^` and exactly 14 characters from the
  Crockford-base32 alphabet (`[0-9a-hjkmnp-tv-z]`), that suffix is removed and becomes the
  block's `id`; the space before `^` is also removed. The check is anchored to the end of the
  line (after trailing-whitespace trimming) — `MUST` match `/ \^([0-9a-hjkmnp-tv-z]{14})$/`.
- **OUT-13.** Escape: a literal trailing `^id`-shaped run that must NOT be read as an id is
  written `\^` (backslash before the caret). The parser recognizes `\ \^` at end of line, does
  not extract an id, and leaves `\^…` in `content` (the backslash is resolved by the inline
  tokenizer's escaping rule, §2.9-ESC).
- **OUT-14.** Code-fence special case: if the block's first content line would otherwise
  **open a fence** (starts with a fence marker per §2.7-C) and the block has an id, the id MUST
  NOT be appended to that line (it would land inside or after the fence's info string). Instead
  the bullet's first line holds **only** the block's marker and priority (OUT-16), if any, and
  `^id`; the fence-opening line becomes line 1 of `content`, indented at the content column like
  any continuation line. Example:
  ```
  - TODO [#A] ^1k7f3q9xz2hav4
    ```js
    const x = 1;
    ```
  ```
  (Revised 2026-09-13, B-310: this used to write `^id` alone even for a task, and the marker and
  priority were lost on re-read.) Written without an id, the same task goes out as
  `- TODO [#A] ```js`; the fence is looked for on line 1 **after** marker/priority stripping,
  wherever line 1 is read (block-level fence tracking and OUT-23 alike), so the fence opens there.
  Parsing: once marker and priority are stripped, a first line that is exactly `^id` (nothing
  else) carries the id (OUT-12's suffix, whose space the strip took) — also on a block's only line:
  `- ^id` is an empty block, `- TODO ^id` an empty task (B-390, 2026-09-13; requiring a further
  line read 441 of the owner's 952 mirror files back with `^id` as text). When what is left of
  line 1 after stripping a marker, priority and/or id is empty **and** the next content line opens
  a fence, line 1 is not a content line: `content` starts at that fence. Otherwise an empty line 1
  is the content's own (`- LATER ^id` + `  > text` is the content `"\n> text"`). Consequence: a
  content that is a blank line followed by a fence cannot be written for a block with a head or
  an id. An empty block with a `^id` is never a page-properties pre-block (OUT-2).
- **OUT-15.** Import tolerance for Logseq's own id spelling: a block property line `id::
  <value>` (§2.4) — value either a Logseq UUID or a 14-character id — sets the block's `id`,
  exactly as today. If both an `^id` suffix (OUT-12) and an `id:: value` property line are
  present on the same block (malformed/hand-edited input), the `^id` suffix wins and the `id::`
  line is dropped entirely (not kept as a stray property). The DB mirror's page-level `id::
  <uuid>` pre-block line (one per file, a page id, not a block id) is page-property import
  tolerance only, unrelated to this rule; it is kept as an ordinary `id` entry in `page.properties`
  and is not written by our serializer.

### 2.3 Task marker, priority, numbered blocks

- **OUT-16.** Unchanged from current `outline.ts`: if the block's first content-bearing line
  starts with one of `TODO DOING DONE LATER NOW WAITING WAIT CANCELED CANCELLED IN-PROGRESS`
  followed by whitespace or end-of-line, that word is the `marker` (aliases `WAIT→WAITING`,
  `CANCELLED→CANCELED`, `IN-PROGRESS→DOING`); then, if what remains starts with `[#A]`, `[#B]`,
  or `[#C]`, that is the `priority`. Both are stripped from `content`. Canonical `TASK_MARKERS`
  are the 7 values in `model.ts`.
- **OUT-17.** Numbered blocks: the reserved property `list:: number` marks a block as a numbered
  list item. Canonical form is always a `- ` bullet plus this property (never a literal `N. `
  bullet — OUT-4's numbered-bullet form is import-only, and Logseq's `logseq.order-list-type::
  number` block property is also import tolerance, remapped to `list:: number`, §2.4). Any other
  value of `list` is reserved for future list styles and MUST be preserved verbatim (round-tripped
  as an ordinary property) even though only `number` has meaning in v1. A block's displayed
  ordinal is 1 plus the count of immediately preceding siblings that also carry `list:: number`
  contiguously (a non-numbered sibling resets the count) — this is a rendering rule, not stored
  state, matching Logseq DB's recomputed numbering.

### 2.4 Block and page properties; key normalization

- **OUT-18.** Property lines match `^([A-Za-z0-9_][A-Za-z0-9_.-]*):: ?(.*)$` and, for a block,
  MUST form a contiguous run starting immediately after line 1 (Logseq's rule; unchanged). For a
  page's pre-block they are the whole pre-block. One exception, serializer side (B-151, 2026-09-13):
  a block written **without** an id whose content opens with a fence (OUT-14's head-and-`^id` line
  is not available) cannot take them after line 1 — they would be inside the fence.
  The serializer writes them after the content when every fence in it closes; else, for a task,
  after its marker/priority alone on line 1 (OUT-14's form minus the id, B-310), and otherwise as
  the bullet line itself (`- key:: value`, the fence opening on the next line). The parser reads a
  property line anywhere outside a fence, so all three parse back; the first and last are the
  same placements as editing text (OUT-22a).
- **OUT-19.** Key normalization (parse-time), applied in this order:
  1. Lowercase the raw key.
  2. Apply the Logseq-compatibility remap table: `custom_id` → `id`, `custom-id` → `id`,
     `logseq.order-list-type` → `list`. (`heading` is not remapped; see OUT-25.)
  3. Otherwise, replace every `_` with `-` (00-conventions.md: "Property keys: lowercase, `-`
     instead of `_`").
  The canonical serializer never needs to normalize (properties already arrive normalized from
  the store), but MUST NOT re-introduce underscores.
- **OUT-20.** Reserved keys are extracted into dedicated `OutlineNode` fields, never left in
  `properties`: `id` (→ `node.id`, superseded by OUT-11/12 as the canonical spelling — `id::`
  remains parseable per OUT-15), `collapsed` (→ `node.collapsed`, `true`/absent/`false`; the
  serializer omits the line entirely when `false`, matching current behavior), `marker` and
  `priority` are never written as property lines at all (they live in the first line, OUT-16) —
  a stray `marker::`/`priority::` property line on import is treated as an ordinary (unreserved,
  ignored-for-task-state) property, since Logseq itself never writes these as property lines.
  `scheduled`, `deadline`, `repeat`, `done`, `list` join the reserved-key list (ADR 011) but,
  unlike `id`/`collapsed`, they stay as ordinary `key:: value` lines in both directions — "reserved"
  here means the server stores them in dedicated columns (ADR 011, `ops.ts`
  `RESERVED_BLOCK_PROPS`), not that this grammar treats them specially syntactically.
- **OUT-21.** Property values are opaque strings to this grammar (no type coercion, no
  true/false/int parsing — deviates from Logseq OG on purpose; see §2.11 and Open issues). The
  one structural exception is list-splitting for `tags::` and `alias::`, unchanged from
  `refs.ts`: comma-separated, honoring nested `[[...]]` (commas inside brackets do not split).
- **OUT-21a.** (Added 2026-09-13, audit §2 #17.) `read-only:: true` as a PAGE property is an
  ordinary property to this grammar, the server and the mirror. The web client reads it as a lock:
  the page's blocks render but never enter edit mode, cannot be block-selected, and refuse the
  task-marker click, drag and swipe with a short notice; collapsing, selecting text to copy, and
  the page's properties (where the lock is lifted) stay available. Only the value `true`
  (case-insensitive, trimmed) locks. The lock is presentation, not permission: the HTTP API, MCP
  tools, sync from other devices and imports are NOT bound by it. Implementation:
  `apps/web/src/editor/readOnly.ts`.
- **OUT-22.** `scheduled:: <date>` and `deadline:: <date>` values are `YYYY-MM-DD` or
  `YYYY-MM-DD HH:MM` (ADR 011: "ISO date, optional time, no weekday, no angle brackets"). `done::
  <timestamp>` is an ISO 8601 UTC timestamp (`00-conventions.md`: ISO 8601 in
  API-and-human-facing text; the epoch-ms storage form is a server concern, out of scope here).
  `repeat:: <n><unit>` or `repeat:: <n><unit> from done`, `unit ∈ {d, w, m, y}` (ADR 011). This
  grammar does not validate these shapes beyond parsing them as ordinary property strings; a
  malformed value is preserved verbatim (never dropped, never rejected).
- **OUT-22a. Editing text** (added 2026-09-13, B-101; `packages/core/src/block-text.ts`). While a
  block is edited, the editor's buffer is the block's *editing text*: `content` with the block's
  properties written as `key:: value` lines — line 1, then the property lines in key order, then
  the rest of the content (a content that opens with a fence takes them after the closed fence, or
  before line 1 if the fence never closes; an empty content keeps an empty line 1). When the edit
  is written, the text is split back with this grammar's own line rules: every line outside a
  fence that matches OUT-18, key normalized per OUT-19, is a property wherever it sits (the
  parser's behaviour, not only the contiguous run after line 1), and the write is one `block.text`
  when the content moved plus one `block.prop` per property added, changed or removed — diffed
  against the block as it was when the edit began. Unlike `parseOutline`, nothing is trimmed (a
  trailing space is the next keystroke). **Not** split out, so they stay ordinary content text in
  the buffer exactly as before: the reserved keys (`id collapsed marker priority scheduled deadline
  repeat done`) and `heading` — the scheduling keys are validated columns, and half-typed dates
  would be rejected on every typing pause; they get their own UI. Also never written into the
  buffer: a property whose `key:: value` line would not read back as exactly that key and value —
  a value with a line break or surrounding whitespace, which `block.update` accepts (B-152). Such a
  property is not in the text, so the edit neither rewrites nor deletes it.

### 2.5 Logseq import tolerance: SCHEDULED/DEADLINE/LOGBOOK, `heading::`, headings without a bullet

- **OUT-23.** Per-line classification inside a block's continuation lines (order matters):
  1. Inside an open fence (§2.7-C): the line is fence content, verbatim (existing behavior,
     highest priority — nothing below ever fires inside a fence).
  2. Inside an open `:LOGBOOK:` drawer: if the (trimmed) line is `:END:`, close the drawer;
     otherwise discard the line. Nothing from a LOGBOOK drawer is kept anywhere — not in
     `content`, not in a property (ADR 011: "the drawer's raw content is not kept"; that history
     now lives in the op log, which a separate importer component may populate from the drawer's
     `CLOCK:` lines as synthetic historical ops — out of scope for this grammar).
  3. If the trimmed line is exactly `:LOGBOOK:`, open the drawer and discard the line.
  4. If the line matches the property regex (OUT-18), extract it (OUT-19/20).
  5. If the line matches `^\s*SCHEDULED:\s*<([^>]+)>\s*$` or `^\s*DEADLINE:\s*<([^>]+)>\s*$`
     (org timestamp syntax, optionally with a leading weekday abbreviation and a repeater — e.g.
     `<2026-09-12 Sat .+1w>`, `<2026-09-14 Sat 14:00 +1d>`): parse the date (`YYYY-M-D`: month
     and day may be one digit, as Logseq wrote `<2023-2-17 Fri>` — B-143, B-266), optional `H:MM` time,
     and optional repeater `[.+]{1,2}(\d+)([dwmy])`; zero-pad month, day and hour; if the date or
     time is impossible, the line is NOT a timestamp (rule 6 keeps it as text); discard the line;
     set `scheduled::`/`deadline::` (OUT-22 shape, weekday dropped) and, if a repeater was
     present, `repeat:: <n><unit>` (the `+`/`++`/`.+` dialect marker is discarded — ADR 011 keeps
     one repeat shape, not three). If a `repeat::` property is set by more than one of these
     lines on the same block, the later line wins (last write in file order).
  6. Otherwise: a normal content line — append to `content`; if it opens a fence, mark the fence
     open (existing behavior).
  The serializer never emits `SCHEDULED:`/`DEADLINE:`/`:LOGBOOK:`/`:END:` lines (ADR 011,
  consequences section — normative here).
- **OUT-24.** `#+BEGIN_QUOTE` / `#+END_QUOTE` (org blockquote) is **not** specially parsed in v1
  (open issue below): such lines fall through OUT-23 rule 6 as ordinary content text, which is
  lossless (round-trips as plain text) but renders as literal `#+BEGIN_QUOTE` rather than a
  blockquote. This is deliberate: 0 occurrences were found in either of the user's real graphs
  (§9), so the cost of the cheap "keep as text" fallback is judged lower than the cost of adding
  a second blockquote spelling to the grammar. `> ` GFM blockquote syntax (§2.7-Q) is the only
  supported blockquote form.
- **OUT-25.** `heading:: N` (`N` 1–6) is import tolerance folded into `content` rather than kept
  as a property (the leading `#` run is the single source of truth for heading level, §2.7-H):
  if line 1 (after id/marker/priority stripping) does not already start with `#{1,6} `, prepend
  `"#".repeat(N) + " "` to it. Whether or not line 1 already had `#`s, the `heading::` property
  line itself is always dropped (not kept, not round-tripped) — if the content's own `#` count
  disagrees with `N`, the content's `#` count wins and `N` is discarded as stale metadata.
- **OUT-26.** Import tolerance: a file's very first block MAY be a heading written without a
  bullet at all — this is already covered generically by OUT-9 (bulletless paragraph); no special
  case is needed because a bulletless block's content is classified exactly like a bulleted one
  (§2.7).

### 2.6 `query`/`sql` fence reservation

- **OUT-27.** A fenced code block (§2.7-F) whose info string is exactly `query` or `sql` is, to
  this grammar, an **ordinary fenced code block**: parsed like any other fence, content stored
  verbatim, no special grammar, no validation *at parse time*. The rule reserves the info-string
  spelling so the filter language (ADR 011, amended 2026-09-12: `packages/core/src/query.ts`) can
  attach meaning to `lang === "query"` (read/write, live results) and `lang === "sql"` (read-only,
  still deferred) without any change to this grammar or to `packages/core`'s outline parser. What
  a renderer does with the stored text is its business: since M7 the web client evaluates a
  `query` fence at render time (`.vr-fence[data-lang="query"]`, `render/QueryFenceView.tsx`) and
  shows parse errors inline — the block's content is never rewritten or rejected by it.

### 2.7 Block content classification

Before inline tokenization, a block's whole `content` string (already stripped of bullet,
marker, priority, id, and property lines) is classified into exactly one of:

- **CLS-F (fence)**: line 1 opens a fence — matches `/^(`{3,}|~{3,})/` and the same fence
  character does not also close on line 1 (unchanged fence-opening rule from `outline.ts`). The
  whole content is one fence: `lang` = the info string after the opening marker (trimmed), `code`
  = the lines between the opening and the matching closing fence line (a line whose trimmed text
  starts with a run of the same fence character, length `>=` the opener's), dedented to the
  content column (already true of `content` by construction). If no closing line exists, the
  fence runs to the end of the block (never an error). Body lines are **not** inline-tokenized.
- **CLS-H (heading)**: line 1 matches `/^(#{1,6}) (.*)$/` (a literal space required after the
  `#` run — `##nospace` is not a heading). `level` = the number of `#`. The heading's inline
  content is the rest of line 1, tokenized normally (§2.9); any further lines are a trailing
  paragraph rendered below the heading within the same block (rare — a Shift+Enter after a
  heading line), tokenized and hard-broken like CLS-P.
- **CLS-Q (quote)**: every non-empty line of `content` starts with `>` (optionally `> ` with one
  space; both accepted, the leading `>` and at most one following space are stripped per line).
  If even one non-empty line lacks a leading `>`, this is not a quote block (falls through to
  CLS-P; a `>` inside such a block is a plain character, not markup — "all lines or none" avoids
  ambiguity). Each stripped line is tokenized independently and joined with `br` tokens
  (§2.9-BR), same as CLS-P.
- **CLS-T (table)**: at least 2 lines; line 1 and line 2 are GFM pipe rows, where line 2 is a
  delimiter row (`^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$`, cells of `-` optionally flanked by
  `:` for alignment) with the same cell count as line 1; every further line is also a pipe row.
  Cells are split on unescaped `|` (a `\|` inside a cell is a literal pipe, not a separator, and
  is resolved to `|` by the inline tokenizer's escape token, §2.9-ESC), trimmed, and each cell's
  content is tokenized independently (no `br`s inside a cell — GFM tables are one line per row).
  `align[i]` is `left`/`right`/`center`/`null` from the delimiter cell's colons. Any mismatch
  (ragged row, no delimiter row) falls through to CLS-P.
- **CLS-R (hr)**: `content` is exactly one line matching `/^(-{3,}|\*{3,}|_{3,})$/` (trailing
  whitespace already stripped by OUT-7) and the block has no marker and no children-affecting
  content otherwise. No inline tokens.
- **CLS-P (paragraph)**, the default: every other case. `content`'s lines are each tokenized
  independently (§2.8) and the results concatenated with a `br` token inserted for every `\n` in
  the original string (so offsets stay contiguous into the whole `content` string — this is
  exactly what `tokenizeContent(content)` in §3 returns).

None of CLS-F/H/Q/T/R exists on the wire as a stored flag — they are always re-derived from
`content` by the renderer, live-preview, and importer alike, exactly like Logseq derives them
from `mldoc`'s AST. There is no `Block.kind` column.

### 2.8 Inline tokenization — general rules

- **INL-1.** Inline tokenization is **per physical line**; no inline token's span crosses a `\n`.
  A `\n` between two lines of the same paragraph/quote always becomes its own `br` token — there
  is no CommonMark-style "soft break that renders as a space": every line break the user typed
  (Shift+Enter, ADR 006) is a hard break, because trailing whitespace is already stripped (OUT-7)
  so there is no soft/hard distinction left to make. Backslash-newline and trailing-double-space
  hard-break markers are therefore not recognized as syntax (there is nothing for them to mean
  that a plain `\n` doesn't already mean).
- **INL-2.** Scanning is one left-to-right pass per line with a small set of triggering
  characters (`\ ` `` ` `` `[` `!` `(` `{` `#` `~` `=` `*` `_` `$` `h`); every other character is
  plain text. The scanner never throws and never backtracks past a token it already committed;
  an opener with no matching closer on the same line falls back to plain text for that one
  character and scanning resumes at the next position (existing `refs.ts` behavior, generalized).
  This guarantees O(n) time and that **unknown or malformed syntax always stays as plain text**
  (ADR 006's requirement), never an error, never dropped.
- **ESC.** Backslash-escaping: `\` followed by one of `` \ [ ] ( ) { } # * _ ~ = ` $ | < > ! ^ ``
  produces an `escape` token spanning the two source characters whose rendered value is the
  single following character (the backslash itself is never rendered); no further syntax is
  recognized starting at the escaped character (e.g. `\[[` renders as literal `[[`, because only
  the first `[` is consumed by the escape — the second `[` is then just a plain character, since
  a wikilink requires two *adjacent* `[` and the first one is now "used up" as literal text, not
  re-examined as a trigger). `\` before anything else (a letter, digit, whitespace, end of line)
  is **not** an escape: the backslash is plain text (CommonMark's rule). Escaping is legal
  anywhere, including inside link labels, table cells, and heading text; it is not recognized
  inside fenced code (fence bodies are never inline-tokenized at all) or inside an already-open
  code span (a code span's content is copied verbatim, backslashes included, per CommonMark).

### 2.9 Inline tokens

Each entry: trigger, exact rule, produced token kind (types in §3).

- **Wikilink** `[[target]]` or `[[target|alias]]`. Trigger: `[[`. The closing `]]` is found by
  bracket-depth counting so nested `[[...]]` inside the target is honored (existing `refs.ts`
  `findClosingBrackets`, unchanged). Inside the raw inner text, the first `|` at bracket-depth 0
  splits `target` (before) from `alias` (after); both trimmed. `alias` is Obsidian-paste
  tolerance (Logseq itself never writes it) — display text, never itself a reference. Any
  complete `[[...]]` found strictly inside the target text is additionally recorded as a `nested`
  wikilink token (recursively), so `[[outer [[inner]] x]]` yields one token whose `target` is the
  literal string `"outer [[inner]] x"` and whose `nested` array has one token for `"inner"` —
  this exactly reproduces current `refs.test.ts` behavior while making it token-tree-derivable.
  An unmatched `[[` (no closing `]]` before end of line) is plain text (INL-2).
- **Tag** `#tag` / `#[[multi word tag]]`. Trigger: `#`, only when `i === 0` or the preceding
  character is one of `{space, tab, "(", ",", ";", "[", "{", '"', "'"}` (`TAG_PRECEDER`, unchanged
  from `refs.ts`). This single rule is what excludes `# heading` (next char is a stop char, see
  below), `##` markdown headings, and URL fragments (`https://x#frag` — the character before `#`
  is `x`, a normal word character, not a preceder) without any URL-aware special-casing.
  - Plain form: the tag name runs until one of `{space, tab, ",", ";", ")", "]", "}", "'", '"'}`
    (`TAG_STOP`, unchanged) or end of line; trailing `.`, `!`, `?`, `:` are then stripped
    (`TAG_TRAILING`, unchanged). `/` is not a stop character, so `#a/b` is one tag (namespace).
    No word-boundary/Unicode-category check is needed beyond `TAG_STOP`/`TAG_PRECEDER`: any
    Unicode letter (Czech `č`, emoji, CJK) continues a tag name unchanged.
  - Multi-word form: `#[[`, closing `]]` by the same bracket-depth rule as wikilinks; the inner
    text, trimmed, is the tag name verbatim (spaces kept, no trailing-punctuation stripping — the
    brackets are the delimiter, not whitespace).
  - `next` character immediately after `#` equal to another `#`, to a `TAG_STOP` character
    (including plain space — this is what makes `# Heading` not a tag), to `+` (**TAG-1a**,
    reserved for org `#+KEYWORD` lines — `#+BEGIN_QUOTE`, `#+TITLE:`, `#+OPTIONS:` — see below),
    or absent (end of line) → not a tag; the `#` is plain text. TAG-1a is a fix discovered while
    building the corpus (§9, case 35): both this spec's reference tokenizer and the **current**
    `refs.ts`, unmodified, turn `#+BEGIN_QUOTE` into a tag named `+BEGIN_QUOTE` without it — a
    real, verified bug (`extractRefs("#+BEGIN_QUOTE some text #realtag")` today returns
    `tags: ["+BEGIN_QUOTE", "realtag"]`), not a hypothetical one, and worth excluding precisely
    rather than leaving as an emergent side effect of OUT-24's "keep as plain text" fallback.
- **Block ref** `((id))`. Trigger: `(`, `(` immediately following. Content up to the next literal
  `))` on the line, trimmed, MUST match `isId` (14-char) or the Logseq UUID pattern; otherwise not
  a block ref (falls to plain text, INL-2). Unchanged from `refs.ts`.
- **Embed** `{{embed [[Page]]}}` / `{{embed ((id))}}`. Trigger: `{{`. Content up to `}}` on the
  line; the first whitespace-delimited word is the macro name. When the name is exactly `embed`
  and the remainder is exactly `[[...]]` or `((...))`, produce an `embed` token with
  `target: {kind:"page", name} | {kind:"block", id}`. An `{{embed ...}}` whose argument matches
  neither shape still produces an `embed` token with `target: null` (renders as an error/empty
  placeholder, never a crash).
- **Macro** `{{name args}}`, any other `{{...}}` (generic, for plugins — `{{video url}}`,
  `{{query ...}}` imported per PLAN's non-goals, `{{renderer ...}}`, `{{cloze x}}`, …). `name` is
  the first word, `args` is the untrimmed-of-internal-content, trimmed-overall remainder; `args`
  is never further parsed by this grammar (a plugin or a future spec interprets it). An
  `{{...}}` with no closing `}}` on the line is plain text.
- **Link to page** `[label]([[Page]])` (Logseq idiom). Trigger: `[`, when a balanced-bracket
  label followed immediately by `(`, a balanced-paren href, and the href is exactly
  `[[...]]` — produces `linkToPage` with `target` = the inner text (trimmed) and `label` = the
  label's own inline tokens (recursion, one line deep — a label containing another link is legal
  but rare).
- **Link to block** `[label](((id)))` (Logseq idiom, symmetry with the above, not explicitly
  Logseq-common but supported the same way): href exactly `((...))` → `linkToBlock` with `id` and
  `label` tokens.
- **Markdown link** `[text](url)`: any other balanced `[label](href)` → `link` with `href` kept
  verbatim (relative paths, `mailto:`, etc. all pass through unresolved — resolution is a
  rendering-layer concern) and `label` tokenized.
- **Autolink**: a bare `http://` or `https://` run (trigger: character `h` where the remaining
  line starts with the scheme) is consumed up to the next whitespace, then trailing characters
  from `` .,;:!?'")] `` are trimmed off one at a time (GFM autolink trailing-punctuation rule) —
  this is what keeps a URL inside a sentence (`see https://x.com/a.` — trailing `.` excluded) from
  swallowing the sentence's own punctuation. Produces `autolink` with `href`.
- **Image** `![alt](src)`, including `assets/<id>.png` and Logseq's `../assets/name.png` — both
  are just opaque `src` strings to this grammar; path resolution is a rendering-layer/assets-spec
  concern. Trigger `!` followed by `[`; same balanced-bracket/paren capture as a link. `alt` is
  kept as a plain string (not tokenized — CommonMark's rule for image alt text).
- **Strong** `**text**` (only two asterisks — single `*` never means strong in this grammar,
  unlike CommonMark's `**`/`__` symmetry; see Open issues). Run-length detection: at a `*`,
  measure the run length; a run `>= 2` looks for a closing run of `>= 2` on the same line and
  wraps the (recursively tokenized) interior as `strong`; a run of exactly 1 looks for a single
  closing `*` and wraps as `em`. `***text***` therefore parses as `strong` (opened by the 2-run
  check first) whose single child is `text` as plain content of that strong span up to the
  closing run — i.e. the third `*` on each side is "spent" opening/closing the 2-run match and is
  not separately available to also form an `em`; nesting `**_text_**` or `*text **bold** more*`
  (mixed delimiters) works via ordinary recursion.
- **Em (underscore)** `_text_`: a single `_` opens/closes emphasis only when **not** flanked by a
  word character (`\p{L}`, `\p{N}`, or `_`) on the inside-forbidden side — precisely: an opening
  `_` MUST NOT be immediately preceded by a word character, and the matching closing `_` MUST NOT
  be immediately followed by a word character. This is the "intraword underscore" exclusion: it
  keeps `snake_case_var` entirely plain text (every `_` there has word characters on both sides)
  while still emphasizing `_word_` at the start/end of a line or next to punctuation/space.
- **Strikethrough** `~~text~~`, **highlight** `==text==`: exact 2-run open/close, recursive
  interior, same shape as `strong`. A run of exactly 1 (`~text~`, `=text=`) is not recognized
  (plain text) — there is no single-tilde/equals form in this grammar.
- **Inline code** `` `code` ``: a backtick run of length N opens; the first backtick run of the
  same exact length N on the same line closes (unchanged `refs.ts` `findBacktickRun` logic — a
  shorter or longer run in between is part of the code content). CommonMark's "strip one leading
  and trailing space if the content is not all spaces" rule applies (lets `` `` `code` `` `` `` `
  contain literal backticks). Content is copied verbatim: no nested tokens, no escape processing
  inside.
- **Inline math** `$...$`: Pandoc's `tex_math_dollars` heuristic, adopted verbatim because it is
  exactly the rule needed to not misparse prices (§9 found 559 `$digit` occurrences against 17
  genuine-looking math candidates in the user's own graphs). A `$` opens math only if the next
  character is not whitespace and not another `$`; the scan then looks for the next `$` such that
  the character before it is not whitespace **and** the character after it (if any) is not a
  digit. `$5 and $10` therefore never matches (the candidate closer before "10" is followed by a
  digit); `$E=mc^2$ today` does. `tex` is the raw text between the delimiters, unparsed (a future
  KaTeX/MathJax render step interprets it; this grammar only delimits it).
- **Display math** `$$...$$` (Logseq's display form; added 2026-09-13, B-264 — the owner's graph
  has `$$CO_2$$`, which §9's single-`$` counts did not look for). Tried before inline math at a
  `$$`: the scan looks for the next `$$` on the same line; the text between must not be blank and
  the character after the closer (if any) must not be a digit (the inline rule's price guard, so
  `$$5 and $$10` stays text). Produces a `math` token with `display: true`; `tex` excludes both
  delimiters. An unclosed or blank `$$` is not display math and falls through to the inline rule
  above. A `$$` block spanning several lines is not recognized (the tokenizer is per line).
- **Checkbox** `[ ]`, `[x]`, `[X]` (optional per the task brief; included because Obsidian/GitHub
  paste is common). Recognized anywhere on a line as exactly those three characters, **except**
  when immediately followed by `(` — in that case the markdown-link rule (which is tried first at
  every `[`) already wins, so `[x](url)` is a link, never a checkbox. A leading checkbox on line 1
  does **not** implicitly set the block's `marker` — that stays the editor's job (a paste/typing
  affordance may offer to convert it, out of scope for this grammar) — the grammar only produces
  a `checkbox` token, purely for rendering.
- **`br`**: inserted between lines by the paragraph/quote assembler (§2.7-P/Q), never produced by
  `tokenizeLine` itself. `start === end - 1`, pointing at the `\n` character.

### 2.10 Reference derivation (page / tag / block / embed)

- **REF-1.** References are derived, never stored (00-conventions.md, PLAN §4). The single
  source of truth for derivation is the token stream, walked recursively (into `children`,
  `label`, `nested`): every `wikilink` token (and its `nested` entries) contributes a `page` ref
  on its `target`; every `tag` token contributes a `tag` ref (kept separate from page refs for
  display, per `refs.ts`, but a tag is also addressable as its page); every `blockRef` token and
  every `embed` token with `target.kind === "block"` contributes a `block` ref; every `linkToPage`
  token contributes a `page` ref on its `target`; every `linkToBlock` token and every `embed`
  token with `target.kind === "page"` contribute accordingly. Plain `link`/`autolink`/`image`
  tokens never contribute refs (their `href`/`src` are not graph identifiers). This is the same
  output shape `refs.ts`'s `ExtractedRefs` already has; §8 lists the required refactor to derive
  it from tokens instead of a parallel scan.
- **REF-2 (decision — property values as refs, PLAN leaves this open).** `tags::` and `alias::`
  values are always lists of page names (OUT-21): every comma-separated item becomes a page ref
  (for `alias`) or a tag ref (for `tags`) whether or not it is bracketed — unchanged from
  `refs.ts`. For every **other** property key, refs are derived only from `[[...]]`, `#tag`,
  `#[[...]]`, or `[label]([[...]])` syntax **found inside** the value string — a bare,
  unbracketed value (`type:: book`, `status:: done`) does **not** become a page ref. This is a
  deliberate, stated deviation from Logseq OG (which treats most non-quoted, non-list property
  values as page-name sets by default) and matches the plan's explicit lesson to avoid Logseq's
  "`TODO`/`A` become pages" mistake, extended to ordinary properties: typing `type:: project`
  must not silently create a page named "project"; typing `type:: [[project]]` does, on purpose.
  Cross-spec note: a **property definition** (`00-conventions.md`) of type `page` describes a
  value that is semantically a page name even when written bare. Resolving that is the
  responsibility of the (not-yet-written) properties/indexing spec, at the layer that has the
  property-type registry — it is not this grammar's job, since `tokenizeInline`/`extractRefs` are
  pure functions of text with no database access. That spec MUST state explicitly whether the
  `ref` table gains an extra row for bare `page`-typed values (recommended: yes, added by the
  indexer, not by this grammar).

## 3. Interfaces

```ts
// packages/core/src/tokens.ts (new file — see §8)

/** 0-based, half-open, UTF-16 code unit offset into the string that was tokenized. */
export type Offset = number;

interface TokBase {
  start: Offset;
  end: Offset;
}

export type InlineToken =
  | (TokBase & { kind: "text" })
  | (TokBase & { kind: "br" })
  | (TokBase & { kind: "escape"; char: string })
  | (TokBase & {
      kind: "wikilink";
      target: string;
      targetStart: Offset;
      targetEnd: Offset;
      alias?: string;
      nested?: InlineToken[]; // kind: "wikilink", recursively
    })
  | (TokBase & { kind: "tag"; name: string; multiWord: boolean })
  | (TokBase & { kind: "blockRef"; id: string })
  | (TokBase & {
      kind: "embed";
      target: { kind: "page"; name: string } | { kind: "block"; id: string } | null;
    })
  | (TokBase & { kind: "macro"; name: string; args: string })
  | (TokBase & { kind: "linkToPage"; target: string; label: InlineToken[] })
  | (TokBase & { kind: "linkToBlock"; id: string; label: InlineToken[] })
  | (TokBase & { kind: "link"; href: string; label: InlineToken[] })
  | (TokBase & { kind: "autolink"; href: string })
  | (TokBase & { kind: "image"; alt: string; src: string })
  | (TokBase & { kind: "strong"; children: InlineToken[] })
  | (TokBase & { kind: "em"; children: InlineToken[] })
  | (TokBase & { kind: "strike"; children: InlineToken[] })
  | (TokBase & { kind: "highlight"; children: InlineToken[] })
  | (TokBase & { kind: "code"; code: string })
  | (TokBase & { kind: "math"; tex: string; display?: true })
  | (TokBase & { kind: "checkbox"; checked: boolean });

export type Align = "left" | "center" | "right" | null;

export type BlockContent =
  | { kind: "paragraph"; lines: InlineToken[][] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; title: InlineToken[]; trailing?: InlineToken[][] }
  | { kind: "fence"; lang: string; code: string }
  | { kind: "quote"; lines: InlineToken[][] }
  | { kind: "table"; align: Align[]; header: InlineToken[][]; rows: InlineToken[][][] }
  | { kind: "hr" };

/** One physical line, no `\n`. Offsets are relative to `base` (the line's start in the
 *  original content string), so callers can tokenize a whole multi-line content string
 *  line-by-line and get globally-consistent offsets (see `tokenizeContent`). */
export function tokenizeLine(line: string, base?: Offset): InlineToken[];

/** Classifies `content` (§2.7) and, for paragraph/quote, tokenizes every line and joins
 *  with `br` tokens; for heading, tokenizes the title. Never throws. */
export function classifyBlockContent(content: string): BlockContent;

/** Convenience used by the corpus and by the reference indexer: the flat inline token
 *  stream for a paragraph- or quote-classified block, offsets into the whole `content`
 *  string. For non-paragraph/quote content this returns `[]` (fence/table/hr/heading use
 *  `classifyBlockContent` directly). */
export function tokenizeContent(content: string): InlineToken[];
```

```ts
// packages/core/src/outline.ts (changed — see §8)

export interface OutlineNode {
  id?: string; // ADR 004: 14-char id from a `^id` suffix (canonical) or `id::` (import)
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  properties: Properties; // never contains "id", "collapsed", "marker", "priority"
  collapsed: boolean;
  children: OutlineNode[];
}

export interface SerializeOptions {
  /** Indent unit for nesting. Canonical default is now two spaces (was tabs). */
  indent?: "  " | "\t" | "    ";
  /** Which nodes get a ` ^id` suffix: nodes that have an id (default) or none
   *  (the MCP/API "cheap read" mode, ADR 008). */
  ids?: "present" | "none";
}

export function parseOutline(text: string): ParsedPage;
export function serializeOutline(page: ParsedPage, opts?: SerializeOptions): string;
```

```ts
// packages/core/src/refs.ts (unchanged shape, changed implementation — see §8)
export interface ExtractedRefs {
  pageRefs: string[];
  tags: string[];
  blockRefs: string[];
}
export function extractRefs(content: string, properties?: Properties): ExtractedRefs;
```

## 4. Rendering contract

| Token / content kind | HTML | CSS class |
|---|---|---|
| `text` | text node | — |
| `escape` | text node (the escaped char) | — |
| `br` | `<br>` | — |
| `wikilink` (resolved) | `<a href="/page/<key>">` | `.vr-page-ref` |
| `wikilink` (unresolved, page doesn't exist) | `<a href="/page/<key>">` | `.vr-page-ref.vr-ref-new` |
| `tag` | `<a href="/page/<key>" class="vr-tag">` | `.vr-tag` |
| `blockRef` | inline render of the target block's own tokens, depth-limited to 2 | `.vr-block-ref` |
| `embed` (page) | the target page's top-level blocks (with their children), rendered read-only in place: a row navigates to its block, the frame edits the host; depth-limited to 2 and cycle-guarded (a notice where the target contains a block already being rendered). Read-write is not built (2026-09-13, B-210) | `.vr-embed.vr-embed-page` (+ `-cycle` / `-missing` / `-limit` / `-failed`) |
| `embed` (block) | the target block and its children, as above; the root always shows its children even when stored collapsed | `.vr-embed.vr-embed-block` (same state classes) |
| `embed` (target `null`) | literal `{{embed …}}` text, dimmed | `.vr-embed.vr-embed-error` |
| `macro` | plugin-provided renderer for `name`, else the literal `{{name args}}` text | `.vr-macro` / `.vr-macro-unknown` |
| `linkToPage` | `<a href="/page/<key>">label</a>` | `.vr-page-ref` |
| `linkToBlock` | as `blockRef` but with the given label instead of the block's own text | `.vr-block-ref` |
| `link` | `<a href target="_blank" rel="noopener">` | `.vr-link` |
| `autolink` | `<a href target="_blank" rel="noopener">href</a>` | `.vr-link.vr-autolink` |
| `image` | `<img alt src loading=lazy>` | `.vr-image` |
| `strong` | `<strong>` | — |
| `em` | `<em>` | — |
| `strike` | `<s>` | — |
| `highlight` | `<mark>` | `.vr-highlight` |
| `code` | `<code>` | `.vr-inline-code` |
| `math` | KaTeX/MathJax render of `tex`, in display mode when `display` (plain `$tex$` / `$$tex$$` text if no renderer is loaded) | `.vr-math` |
| `checkbox` | `<input type="checkbox" disabled checked?>` | `.vr-checkbox` |
| content `heading` | `<h1>`…`<h6>` per `level` | `.vr-heading` |
| content `fence` | `<pre><code class="language-<lang>">`, syntax-highlighted (shiki or highlight.js, editor spec's call) | `.vr-fence`, `data-lang="<lang>"` |
| content `fence`, `lang` ∈ {`query`,`sql`} | same as any fence in v1 (§2.6) | `.vr-fence[data-lang="query"\|"sql"]` |
| content `quote` | `<blockquote>` | `.vr-quote` |
| content `table` | `<table><thead>…<tbody>…`, `text-align` per `align[i]` | `.vr-table` |
| content `hr` | `<hr>` | `.vr-hr` |
| block-level `marker` | a checkbox/state pill before the content, click cycles state (ADR — editor) | `.vr-marker.vr-marker-<TODO\|DOING\|...>` |
| block-level `priority` | a small badge | `.vr-priority.vr-priority-<A\|B\|C>` |

## 5. Editor live-preview contract (CodeMirror 6)

Per ADR 006 / `research/04-editor.md` §3.6: a `ViewPlugin` re-tokenizes the edited block's text on
every transaction (`tokenizeContent`/`classifyBlockContent`, sub-microsecond per block, §7) and
emits `Decoration`s. The rule for every token kind is the same shape: hide the syntax markers,
style the content, unless the cursor is inside or adjacent to the token (then show raw source so
it stays editable) — Obsidian's Live Preview behavior.

| Token | Decoration when cursor is elsewhere | Decoration when cursor is inside/adjacent |
|---|---|---|
| `wikilink` | `Decoration.replace` the `[[`/`]]`/`\|alias` part; `Decoration.mark(.vr-page-ref)` on `target` | none — raw text shown |
| `tag` | `Decoration.mark(.vr-tag)` on the whole token (the `#` stays visible, styled) | same (tags don't hide markers — the `#` is the point) |
| `blockRef` / `linkToBlock` | `Decoration.replace` the whole token with a `Decoration.widget` showing the target's first line | none |
| `embed` | not built: the raw `{{embed …}}` text shows while editing; the rendered view (§4) is the only place an embed renders | n/a — embeds are block-structural, not text the cursor sits "inside" the same way |
| `linkToPage` / `link` | `Decoration.replace` the `](...)")` part; `Decoration.mark(.vr-link)` on the label | none |
| `autolink` | `Decoration.mark(.vr-link)` | same (nothing to hide) |
| `image` | `Decoration.widget` (rendered `<img>`) replacing the whole token | none (edit the markdown) |
| `strong`/`em`/`strike`/`highlight` | `Decoration.replace` the delimiter runs; `Decoration.mark` the interior with the matching style | none — delimiters reappear |
| `code` | `Decoration.mark(.cm-inline-code)`; backticks stay visible (monospace already signals code) | same |
| `math` | `Decoration.widget` (KaTeX render) replacing the token, if a math renderer plugin is loaded; otherwise `Decoration.mark` only | none |
| `checkbox` | `Decoration.replace` with a real `<input type=checkbox>` widget wired to toggle the source text | none |
| marker/priority (line 1 prefix) | `Decoration.mark` styling `TODO`/`[#A]` | same (short, worth always styling) |
| `heading` (`#` prefix) | `Decoration.replace` hides the `#`s and space, `Decoration.line` applies heading font size | none |
| fence marker lines | `Decoration.replace` (hidden) once a language mode renders the body; body highlighted via `@codemirror/lang-markdown`'s nested `codeLanguages` or a plugin-driven pass | none |

`EditorView.atomicRanges` covers every `Decoration.replace` above, so arrow-key movement skips
hidden markers in one step (research/04-editor.md §3.6). This table is the contract; the editor
ADR/spec owns the CM6 extension wiring itself.

## 6. Escaping and edge cases

| Case | Rule |
|---|---|
| `\[[` | First `[` escaped (literal), second `[` is then a lone `[` (no wikilink); see ESC. |
| Literal `#` in code | Never reached — code spans and fences are never inline-tokenized/tag-scanned; `#` inside `` `code` `` or a fence is always literal. |
| `[[` inside a link target | `[label]([[Page]])` is the dedicated `linkToPage` token (§2.9); `[[` never needs escaping inside a `(...)` href because href parsing doesn't look for tags/wikilinks, only for the two special-cased whole-href shapes. |
| Unmatched `[[`, `((`, `{{`, `` ` ``, `$`, `*`, `_`, `~~`, `==` | No closing delimiter on the same line → INL-2's fallback: plain text, opener included verbatim. Never an error. |
| Very long lines | No line-length limit in the grammar. The scanner is O(n) per line with no backtracking (INL-2); §7 gives the measured cost. A pathological single block many MB long (the user has a 1.7 MB page) is handled by streaming line-by-line (§7), not by rejecting it. |
| Emoji / astral codepoints | Offsets are UTF-16 code units (Definitions); no rule compares a value that could be half of a surrogate pair, so surrogate pairs are never split. A tag/link name may contain emoji (`#🎉party` tokenizes correctly, verified in §9/corpus). |
| Czech diacritics (`č`, `ř`, `ů`, …) | Kept verbatim in `content`/token text (no NFC normalization at this layer — normalization happens at page-name resolution time, `page-name.ts`, so a page ref's *display* text preserves whatever the author typed while *matching* is accent-preserving-but-case/whitespace-normalized per `normalizePageName`). Diacritic-insensitive search is a search-spec concern, not this grammar's. |
| RTL text (Hebrew, Arabic) | No special handling: the tokenizer is codepoint-position based, not visually directional. Rendering relies on the browser's Unicode bidi algorithm; the renderer SHOULD set `dir="auto"` on block content containers. Verified: a tag inside an RTL line tokenizes with correct offsets (§9/corpus `47-emoji-diacritics-rtl`). |
| `\^id`-shaped literal text | Escaped per OUT-13 (block-level, before inline tokenization even starts). |
| Trailing whitespace | Stripped per line by the outline parser (OUT-7/existing `outline.ts` behavior) before content ever reaches inline tokenization — so there is never a "significant trailing space" for the inline grammar to reason about (this is also why hard-break-via-trailing-spaces is not a rule, INL-1). |

## 7. Performance targets and strategy

Targets (from the task and consistent with `research/04-editor.md`'s measured 0.6 µs/block for a
comparable hand-written tokenizer):

- Tokenize 20,000 blocks (`tokenizeContent` over realistic block sizes) in **< 50 ms** total
  (2.5 µs/block budget — 4x the measured research-prototype cost, headroom for the richer token
  set here: wikilink aliasing/nesting, checkbox, math, tables).
- Parse (`parseOutline`) a 2 MB page in **< 100 ms**. The user's largest real page is 1.7 MB
  (PLAN §2); ADR 002 measured the *current* parser round-tripping the whole 17.5k-block file
  graph in ~150 ms total (many small files), which is a different shape of workload but confirms
  the per-line cost is in the right range. `parseOutline` is already a single linear pass with no
  backtracking (§2.1); none of this spec's additions (id-suffix regex, LOGBOOK/SCHEDULED line
  checks, key remap) change that — they are all O(1) per line.
- No token allocation happens for content that was never displayed: the content-visibility /
  lazy-mounting strategy is the editor spec's job (ADR 006, `research/04-editor.md` §5), but this
  grammar's contribution is that `tokenizeContent`/`classifyBlockContent` are pure, cheap,
  per-block functions with no shared mutable state — safe to call lazily, on first render of a
  row, and to skip entirely for rows that never mount (`content-visibility: auto`).
- Streaming for huge single pages: `parseOutline` already processes the input line-by-line
  (`text.split("\n")` then one pass) rather than building an AST twice, so memory is O(page size)
  once, not O(page size × passes). No further streaming/incremental strategy is needed for v1's
  2 MB target; if a future page exceeds tens of MB, the recommended strategy (not built now) is
  chunked parsing at top-level-block boundaries (a `- ` at column 0 is always a safe resume
  point), since the grammar has no construct that spans two top-level blocks.

## 8. Required changes to `packages/core`

All changes are to files that already exist; no new package. Existing tests that assert the
*old* defaults must be updated as part of the same change (listed).

1. **`outline.ts` — canonical id is a `^id` suffix, not `id::`.**
   - `finalizeNode`: after assembling `kept` lines, check line 1 for a trailing
     `/ \^([0-9a-hjkmnp-tv-z]{14})$/` (OUT-12) and the id-alone-first-line form (OUT-14) before
     falling back to the existing `id::` property extraction (OUT-15, kept for import).
   - `serializeOutline`: stop pushing `["id", node.id]` into the property lines; instead append
     `" ^" + node.id` to the first line (or write it alone on line 1 when the real first line
     would open a fence, OUT-14).
   - Update `outline.test.ts`'s "writes tabs, markers, priorities, properties and continuation
     lines" fixture (currently asserts `id:: 64f1a2b3-...` in the output) to expect ` ^<id>`
     instead, and add a fence+id round-trip case.
2. **`outline.ts` — canonical indent default becomes two spaces.**
   - `SerializeOptions.indent` default `"\t"` → `"  "`.
   - Update `outline.test.ts` fixtures that call `roundTrip`/`serializeOutline` with no `indent`
     option and currently expect tabs in the output (the "writes tabs…" test name itself should
     change, or explicitly pass `{ indent: "\t" }` to keep testing tab output as an *option*).
3. **`outline.ts` — numbered blocks.**
   - `BULLET_RE` (or a new sibling regex checked alongside it) additionally accepts
     `^([\t ]*)[0-9]+\.(?: (.*))?$` and `^([\t ]*)[*+](?: (.*))?$` as bullet openers (OUT-4);
     carry a `numbered: boolean` flag through `RawNode` → `finalizeNode`, which sets
     `properties.list = "number"` (only if not already set by a property line) when true.
     Verified today: `parseOutline("- a\n  1. num\n")` currently swallows `1. num` as a plain
     continuation line of block "a" — confirms this is unimplemented, not just untested.
4. **`outline.ts` — property key normalization (OUT-19).**
   - In `finalizeNode`'s property loop, before the existing `key === "id"`/`"collapsed"` checks:
     lowercase, then apply the remap table (`custom_id`/`custom-id` → `id`,
     `logseq.order-list-type` → `list`), then replace remaining `_` with `-`. Verified today:
     `custom_id:: 123` currently produces a property literally named `custom_id`, and
     `logseq.order-list-type:: number` is kept as that literal key — neither is normalized.
5. **`outline.ts` — SCHEDULED/DEADLINE/LOGBOOK import (OUT-23), `heading::` folding (OUT-25).**
   - Extend the per-line loop in `finalizeNode` with the drawer-state-machine and the two org
     timestamp regexes described in OUT-23, and the heading-prefix synthesis in OUT-25. None of
     this exists today (verified: a `SCHEDULED: <...>` line currently becomes plain
     content text, and `:LOGBOOK:`/`:END:` lines are currently kept verbatim in `content`).
   - `#+BEGIN_QUOTE` (OUT-24): no code change — already falls through to plain content text.
6. **`refs.ts` — exclude `#+` from tag formation (TAG-1a).**
   - `scanLine`'s tag branch (`else if (next !== undefined && next !== "#" && !TAG_STOP.has(next))`)
     needs one more exclusion: `next !== "+"`. Verified today: `extractRefs("#+BEGIN_QUOTE some
     text #realtag")` returns `tags: ["+BEGIN_QUOTE", "realtag"]` — a real bug this spec's corpus
     (case 35) caught, independent of the larger token-based refactor in item 8 below and small
     enough to land on its own.
7. **`ops.ts` — reserved keys.**
   - `RESERVED_BLOCK_PROPS` gains `"scheduled"`, `"deadline"`, `"repeat"`, `"done"`, `"list"`
     (ADR 011; currently only `marker`, `priority`, `collapsed`, `id`).
8. **New file `tokens.ts`** implementing `tokenizeLine`, `classifyBlockContent`,
   `tokenizeContent` per §3 (a superset of what `research/04-editor.md`'s prototype sketches —
   this spec's version additionally has wikilink aliasing/nesting, `linkToPage`/`linkToBlock`,
   generic `macro`, checkboxes, math, escaping, and the block-content classifier).
9. **`refs.ts` — derive from tokens, not a parallel scanner.**
   - Refactor `extractRefs` to call `classifyBlockContent`/`tokenizeContent` and walk the result
     per REF-1, rather than maintaining its own `scanLine`/`scanText`. This is the ADR 006 "one
     tokenizer, three consumers" requirement made concrete; today `refs.ts` and the (not yet
     written) renderer/live-preview would otherwise drift independently.
   - Keep the exact current `ExtractedRefs` output shape and dedup-by-`Set` behavior — no
     consumer-visible API change, `refs.test.ts` continues to pass unmodified.
   - Performance: re-measure against the §7 target after the refactor; if walking the full token
     tree (including `strong`/`em`/etc. children) is measurably slower than the current flat
     scan for the ref-indexing hot path, add a narrower `collectRefTargets(content)` entry point
     in `tokens.ts` that shares the same trigger/precedence rules but skips building
     emphasis/strike/highlight child arrays it doesn't need — the grammar rules stay single-
     sourced even if there end up being two entry points into them.
10. **`model.ts`** — no field changes needed. `OutlineNode.properties` continues to exclude the
    reserved keys; `scheduled`/`deadline`/`repeat`/`done`/`list` live in `properties` like any
    other key (OUT-20), matching PLAN §8's "stored in dedicated columns" being a server-side
    concern, not an `OutlineNode` shape concern.
11. **`index.ts`** — add `export * from "./tokens.js";`.

## 9. Test corpus

`docs/spec/corpus/` contains `NN-slug.md` (input) / `NN-slug.expected.json` (output) pairs, one
grammar case each, synthetic (no line copied from the user's real graphs — see below).

Schema of an `.expected.json`:

```ts
interface CorpusCase {
  description: string;
  properties: Record<string, string>; // page properties (empty object if none)
  blocks: ExpectedBlock[];
  /** Present only for single-block, paragraph/quote-classified cases: the flat inline
   *  token stream for blocks[0].content as a whole (tokenizeContent), offsets relative
   *  to the full content string (br tokens included for multi-line content). */
  tokens?: InlineToken[]; // see §3
  /** Present only on case 48: classifyBlockContent(blocks[i].content) for every block,
   *  demonstrating §2.7's five non-paragraph content kinds. Not part of the general
   *  schema other cases follow — a one-off, since every other case is either a plain
   *  paragraph (covered by `tokens`) or not about content classification at all. */
  blockContent?: BlockContent[]; // see §3
}
interface ExpectedBlock {
  id?: string;
  content: string;
  marker: TaskMarker | null;
  priority: Priority | null;
  properties: Record<string, string>;
  collapsed: boolean;
  children: ExpectedBlock[];
}
```

A conformance test suite loads every `NN-*.md`, calls `parseOutline`, compares `{properties,
blocks}` (ignoring the `tokens`/`blockContent` keys) against the `.expected.json`, and — where
`tokens` is present — additionally calls `tokenizeContent(result.blocks[0].content)` and
compares, or — for case 48 only, where `blockContent` is present — calls
`classifyBlockContent(result.blocks[i].content)` for every block and compares. A
round-trip test additionally asserts `parseOutline(serializeOutline(parseOutline(text)))` is
deep-equal to `parseOutline(text)` for every case (idempotence — not byte-equality, since some
cases are import-tolerance inputs whose canonical re-serialization intentionally differs from the
input, e.g. tabs → 2 spaces, `id::` → `^id`, `SCHEDULED:` → `scheduled::`).

**Provenance note (per the task's constraint):** every `.md` file below is invented text written
for this spec. The two real graphs at `~/notes-graph` (2,725 `.md` files)
and `~/notes-graph-db/mirror/markdown` (1,202 `.md` files) were only ever
`grep -c`/`grep -o | wc -l` counted for aggregate construct frequency, never read or copied from.
Counts (files containing the construct / total occurrences):

| Construct | alpha (file graph) | alphadb (DB mirror) |
|---|---:|---:|
| Tab-indented bullets | 2,157 files / 41,263 | 0 |
| 4-space-indented bullets | 0 | 572 / 4,978 |
| 2-space-indented bullets | 0 | 766 / 5,626 |
| `SCHEDULED: <...>` | 9 / 73 | 0 |
| `DEADLINE: <...>` | 0 | 0 |
| `:LOGBOOK:` drawers | 151 / 297 | 0 |
| `id:: <uuid>` | 136 / 438 | 1,202 / 1,202 (one page-id line per file) |
| `collapsed:: true` | 614 / 1,676 | 0 |
| `heading:: N` | 0 | 0 |
| Literal `N. ` numbered lines | 101 / 2,291 | 28 / 708 |
| `logseq.order-list-type::` | 15 / 234 | 0 |
| ` ```query` / ` ```sql` fences | 0 | 0 |
| `#+BEGIN_QUOTE` | 0 | 0 |
| `$…$` price-shaped (`$` + digit) | 37 / 559 | 12 / 193 |
| `$…$` math-shaped (Pandoc heuristic candidate) | 7 / 17 | 4 / 8 |
| `==highlight==` | 4 / 4 | 1 / 1 |
| `~~strike~~` | 5 / 26 | 2 / 9 |
| `((block-ref))` | 81 / 99 | 0 |
| `{{embed ...}}` | 12 / 12 | 1 / 1 |
| other `{{macro}}` | 102 / 139 | 33 / 46 |
| `#[[multi word tag]]` | 28 / 34 | 12 / 13 |
| `[label]([[page]])` | 0 | 14 / 17 |
| Namespaced `[[a/b]]` refs | 228 / 323 | 0 |
| Images `![...](...)` | 271 / 1,233 | 27 / 305 |
| `assets/`/`../assets/` paths | 198 / 385 | 2 / 3 |
| GFM checkboxes `[ ]`/`[x]` | 693+83 files / 5,169 | 151+21 files / 1,174 |
| GFM tables (pipe rows) | 9 / 109 | 3 / 37 |
| Front matter (`---`) | 7 / 31 | 0 |

This confirms: tabs dominate the file graph, 2/4-space indentation dominates the DB mirror (so
both MUST be import-tolerated, OUT-6); SCHEDULED/DEADLINE/LOGBOOK are real but rare (import
tolerance, not a common path — OUT-23); the price-vs-math ratio (559:17) is exactly why the
Pandoc dollar-math heuristic matters; `query`/`sql` fences and `#+BEGIN_QUOTE` occur zero times
(justifying OUT-27's "reserve the name, don't build the feature" and OUT-24's "cheap fallback,
open issue" choices).

### Corpus index (48 cases)

| # | File | Tests | `tokens`? |
|---|---|---|:-:|
| 01 | `01-basic-nesting-tabs.md` | Tab-indented nested bullets (OUT-4/5) | |
| 02 | `02-indent-2-space.md` | 2-space import tolerance (OUT-6) | |
| 03 | `03-indent-4-space.md` | 4-space import tolerance (OUT-6) | |
| 04 | `04-irregular-dedent.md` | Over-indented child, irregular dedent (OUT-5) | |
| 05 | `05-continuation-blank-lines.md` | Continuation lines + blank line inside a block (OUT-7) | |
| 06 | `06-crlf.md` | CRLF line endings (OUT-8) | |
| 07 | `07-empty-blocks.md` | Bare `-` empty blocks (OUT-1) | |
| 08 | `08-block-id-suffix.md` | Canonical ` ^id` suffix parsing (OUT-11/12) | |
| 09 | `09-block-id-fence.md` | Id-alone-first-line before a fence (OUT-14) | |
| 10 | `10-block-id-escaped.md` | `\^` escape prevents id parsing (OUT-13) | |
| 11 | `11-legacy-id-property.md` | Import-tolerance `id:: <uuid>` (OUT-15) | |
| 12 | `12-id-conflict.md` | Both `^id` and `id::` present: suffix wins (OUT-15) | |
| 13 | `13-block-properties.md` | `collapsed::` + custom property after line 1 (OUT-18/20) | |
| 14 | `14-property-key-normalization.md` | `custom_id`→id, `My_Key`→my-key (OUT-19) | |
| 15 | `15-property-in-fence-ignored.md` | `key:: value` inside a fence is not a property (existing) | |
| 16 | `16-task-markers-priority.md` | All markers + aliases + `[#A]` (OUT-16) | |
| 17 | `17-numbered-bullet-import.md` | Literal `1. ` bullet import (OUT-4/17) | |
| 18 | `18-numbered-list-property.md` | Canonical `list:: number` (OUT-17) | |
| 19 | `19-numbered-logseq-property.md` | `logseq.order-list-type::` import (OUT-19) | |
| 20 | `20-page-properties-preblock.md` | Bullet-less page pre-block (OUT-2a) | |
| 21 | `21-page-properties-bulleted.md` | Bulleted page pre-block (OUT-2b) | |
| 22 | `22-front-matter.md` | YAML front matter (OUT-3) | |
| 23 | `23-page-id-db-mirror.md` | DB-mirror page-level `id::` (OUT-15) | |
| 24 | `24-scheduled-canonical.md` | Canonical `scheduled::`/`repeat::` (OUT-22) | |
| 25 | `25-deadline-canonical.md` | Canonical `deadline::` with time, `done::` (OUT-22) | |
| 26 | `26-scheduled-import.md` | `SCHEDULED: <date .+1w>` import (OUT-23) | |
| 27 | `27-deadline-import.md` | `DEADLINE: <date time +1d>` import (OUT-23) | |
| 28 | `28-logbook-import.md` | `:LOGBOOK:`/`:END:` dropped (OUT-23) | |
| 29 | `29-query-fence.md` | ` ```query` verbatim fence (OUT-27) | |
| 30 | `30-sql-fence.md` | ` ```sql` verbatim fence (OUT-27) | |
| 31 | `31-heading-property-import.md` | `heading:: N` folded into `#`-prefix (OUT-25) | |
| 32 | `32-heading-conflict.md` | `#` count disagrees with `heading::` (OUT-25) | |
| 33 | `33-bulletless-paragraph.md` | Non-bulleted paragraph block (OUT-9) | |
| 34 | `34-fence-hides-bullets.md` | `- ` inside a fence is not a new block (existing) | |
| 35 | `35-begin-quote-fallback.md` | `#+BEGIN_QUOTE` kept as plain text (OUT-24); `#+` tag exclusion (TAG-1a) | ✓ |
| 36 | `36-wikilink-nested.md` | Nested `[[outer [[inner]]]]` | ✓ |
| 37 | `37-wikilink-alias.md` | `[[Target\|Alias]]` | ✓ |
| 38 | `38-tags.md` | Plain, namespaced, unicode, trailing-punct tags | ✓ |
| 39 | `39-multiword-tag.md` | `#[[multi word tag]]` | ✓ |
| 40 | `40-blockref-embed-macro.md` | `((id))`, `{{embed [[X]]}}`, `{{embed ((id))}}`, `{{video url}}` | ✓ |
| 41 | `41-links-images.md` | `[label]([[Page]])`, `[label](((id)))`, `[text](url)`, autolink, images (incl. `../assets/`) | ✓ |
| 42 | `42-emphasis.md` | `**bold**`, `*em*`, `_em_` incl. `snake_case_var`, `~~strike~~`, `==highlight==`, `` `code` `` | ✓ |
| 43 | `43-math-vs-price.md` | `$5 and $10` (not math) vs `$E=mc^2$` (math) | ✓ |
| 44 | `44-escaping.md` | `\[[`, `\#`, `\\`, unmatched `[[foo` | ✓ |
| 45 | `45-checkbox-inline.md` | `[ ]`, `[x]` vs. `[x](url)` link precedence | ✓ |
| 46 | `46-hard-breaks-multiline.md` | Multi-line paragraph → `br` tokens (INL-1) | ✓ |
| 47 | `47-emoji-diacritics-rtl.md` | Emoji tag offsets, Czech diacritics, RTL line | ✓ |
| 48 | `48-heading-fence-quote-table-hr.md` | Content classification (§2.7), all five non-paragraph kinds | |

(48 cases — comfortably over the "at least 40" floor; the table above is the index, files are in
`docs/spec/corpus/`.)

## 10. Worked example

Input (`pages/Example Page.md`, as our server would write it):

```
title:: Example Page
tags:: demo, [[Reference Material]]

- Kickoff notes for [[Client X]] #meeting ^1k7f3q9xz2hav4
  - TODO [#A] Send the proposal ^1k7f3q9xz2hav5
    scheduled:: 2026-09-12
    repeat:: 1w
  - DONE Book the room ^1k7f3q9xz2hav6
    done:: 2026-09-10T14:32:00Z
- ## Status
  Numbered:
  - First ^1k7f3q9xz2hav7
    list:: number
  - Second ^1k7f3q9xz2hav8
    list:: number
- ![diagram](assets/1k7f3q9xz2hav9.png)
```

`parseOutline` of this produces (abbreviated): a page with `properties: {title: "Example Page",
tags: "demo, [[Reference Material]]"}` and 3 top-level blocks. Block 1 has `id:
"1k7f3q9xz2hav4"`, `content: "Kickoff notes for [[Client X]] #meeting"`, and two children (a
`TODO` with priority `A`, `properties: {scheduled: "2026-09-12", repeat: "1w"}`; a `DONE` with
`properties: {done: "2026-09-10T14:32:00Z"}`). Block 2's `content` is `"## Status\nNumbered:"`
(two lines: the heading line plus a following paragraph line), classified per CLS-H as `heading`
(level 2, title "Status") with a `trailing` paragraph ("Numbered:"); its two children each have
`properties: {list: "number"}`. Block 3's content classifies as `paragraph` whose only inline
token is an `image`.

`extractRefs` on block 1's content returns `{pageRefs: ["Client X"], tags: ["meeting"],
blockRefs: []}`. Applied to the page's own properties, `extractRefs("", page.properties)` adds
`"demo"` and `"Reference Material"` as **tag** refs (both items of a `tags::` list, per REF-2 —
not page refs, since the key is `tags`, not `alias`).

## 11. Open issues

1. **`#+BEGIN_QUOTE`/`#+END_QUOTE` org blockquotes** are not parsed as a `quote` content kind in
   v1 (OUT-24) — they fall back to plain text, which is lossless but not visually a blockquote.
   Zero occurrences in either of the user's real graphs. If org-mode source graphs turn out to be
   more common than the sample suggests, add a third `quote` recognition rule (line 1 is
   `#+BEGIN_QUOTE`, last line is `#+END_QUOTE`) — cheap, but deliberately deferred to keep this
   version of the grammar's blockquote rule to one spelling (`>`).
2. **`**`/`__` asymmetry.** This grammar makes `**` exclusively "strong" and `*`/`_` exclusively
   "em" (per the task's own token list), unlike CommonMark where `**`/`__` are interchangeable for
   strong and `*`/`_` for em. `__strong__` (double underscore) is therefore not recognized as
   strong in this grammar — it would tokenize as two adjacent, unmatched single-`_` em attempts,
   most likely falling back to plain text. This is a deliberate simplification, called out here
   because it is a real behavior difference from GFM/CommonMark that paste-from-elsewhere content
   could hit. If real usage shows `__strong__` is common enough to matter, add it as a second
   strong delimiter — no architectural change, just one more branch in INL rule "Strong".
3. **Property-value type coercion.** OUT-21 keeps all property values as opaque strings (no
   Logseq-style true/false/int inference). This is consistent with PLAN §8 ("values stay strings
   on the wire") and deliberately simpler than Logseq OG, but it means a future properties spec
   must define where/when a `checkbox`- or `number`-typed property's string value is coerced
   (recommendation: at the property-definition-aware layer, same place REF-2's page-typed-value
   resolution belongs — not in this grammar).
4. **`{{query ...}}` / advanced Datalog blocks** are non-goals (PLAN §2) and, per this grammar,
   simply become generic `macro` tokens on import (name `"query"`, raw `args`) — they render as
   an "unsupported macro" placeholder rather than being dropped. No further action needed here;
   noted so the importer spec doesn't have to re-derive this.
5. **`math` intra-word interaction with currency in tables/headings** was only tested for plain
   paragraphs (corpus #43). The Pandoc heuristic is content-shape-agnostic (it runs identically
   inside a table cell or heading title), so no special-casing is expected to be needed, but it
   has not been separately corpus-tested inside those contexts.
6. **RESOLVED 2026-09-10: `RESERVED_BLOCK_PROPS` is `marker, priority, collapsed, id, scheduled,
   deadline, repeat, done` — `list` is NOT reserved.** `packages/core/src/ops.ts` and
   `docs/spec/sql-schema.md` (which gives `scheduled`/`deadline`/`repeat`/`done` dedicated typed
   columns, but not `list`) now agree: numbered-block state (`list:: number`, OUT-20) needs no
   indexed cross-graph query, so it stays an ordinary property in the generic bag, unlike the
   task-scheduling keys. `00-conventions.md`'s glossary now defines "reserved property key"
   pointing at this exact set; this grammar's own Definitions section describes the same concept
   from the syntax side (first-line tokens vs. `key::` lines) and the two remain intentionally
   distinct views of an overlapping-but-not-identical set, not a naming collision to fix.
7. **RESOLVED 2026-09-10:** "Outline Markdown" (this format) and "reserved property key" are now
   defined in `00-conventions.md`'s glossary; this file's other §1 terms are scoped to this
   grammar specifically and do not need a cross-file entry.
