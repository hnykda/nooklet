type:: reference
summary:: The outline format shared by the markdown export, the Logseq importer, the API and MCP — and what the files on disk are and are not.
tags:: reference

- One format, three uses: the files `nooklet export` writes, the files `nooklet import` reads, and the text `page_read` returns and `page_append` accepts. The normative grammar is `docs/spec/markdown-grammar.md`; the parser is `packages/core/src/outline.ts` and the inline tokenizer `packages/core/src/tokens.ts`. Unknown syntax is always kept as plain text, never an error.
- ## A page file
  - ~~~
    title:: Optional override of the file name
    tags:: guide, example

    - first block ^1k7f3q9xz2hav4
      collapsed:: true
      a second line of the same block
      - TODO [#A] a child task ^1k7f3q9xz2hav5
        scheduled:: 2026-09-12
        repeat:: 1w
    - ^1k7f3q9xz2hav6
      ```js
      // when the first line would open a fence, the id sits alone above it
      ```
    ~~~
  - (The example is fenced with `~~~` because it contains a ```` ``` ```` fence of its own; a fence closes at the first line that is only its own opening marker, so one kind cannot nest inside itself.)
  - Page properties: bullet-less `key:: value` lines at the top, ended by a blank line or the first bullet. Logseq's properties-in-the-first-bullet and YAML front matter are accepted on import.
  - One `- ` bullet per block. Nesting is indentation: two spaces per level in what nooklet writes; tabs, two or four spaces, even mixed within a file, on the way in (a tab counts as four columns).
  - The first line: an optional marker (`TODO` …), an optional priority (`[#A]`), the text, and a trailing ` ^id` — the block's 14-character id in Obsidian's block-id syntax (ADR 004). Logseq's `id:: uuid` property line is accepted on import; a ` ^id` wins if both are present.
  - Property lines (`key:: value`) come right after the first line, before any further text. `collapsed:: true` is the only reserved key written as a property; `scheduled::`, `deadline::`, `repeat::`, `done::` and `list:: number` look like ordinary properties in the file and are stored in dedicated columns.
  - Continuation lines are indented to the content column — the bullet's indent plus two. Blank lines inside a block are kept.
  - A fenced code block (three backticks or `~~~`) swallows everything up to its closing fence, bullets included, as one block.
  - A line without a bullet at a fresh indent is its own block (Logseq's loose paragraph). `*`, `+` and `1.` are read as bullets; `1.` also sets `list:: number`. On output everything is `- `.
  - Import-only spellings that never come back out: `SCHEDULED:` and `DEADLINE:` org lines, `:LOGBOOK:` drawers (dropped), `heading:: N` (folded into a `#` prefix), `custom_id`, `logseq.order-list-type`.
- ## Inside a block
  - `[[Page]]`, `[[Page|shown text]]`, `#tag`, `#[[multi word tag]]`, `((id))`, `{{embed [[Page]]}}`, `{{embed ((id))}}`, other `{{macros}}` (kept as text unless a plugin renders them), `[label]([[Page]])`, `[text](url)`, bare `https://` links, `![alt](assets/<id>.png)`.
  - `**bold**`, `*em*` and `_em_` (not inside a word), `~~strike~~`, `==highlight==`, `` `code` ``, `$math$` (`$5 and $10` is not math), `[ ]` and `[x]` checkboxes (rendering only; they do not set a task marker).
  - Block-level shapes, decided from the whole content: `# ` to `###### ` headings on the first line, `> ` quotes on every line, GFM tables (a header row, a `|---|` row, more rows), `---` rules, and fences with a language. ```` ```query ```` and ```` ```sql ```` are reserved for a later filter language and are plain code blocks today.
  - Escape with a backslash: `\[[`, `\#`, `\|` inside a table cell, `\^` for a literal id-shaped run at the end of a line. Fence bodies and code spans are never tokenized.
- ## The files on disk
  - The server writes `<data>/pages/<Page Name>.md` and `<data>/journals/YYYY_MM_DD.md` in this format, atomically, one file per page, and records each file's content hash in `mirror_file`. The file name is the page name with `/` written as `___` and unsafe characters percent-encoded (`pageNameToFileName`); journals are named by their day, so the display-format setting never changes a file name.
  - While `nooklet serve` runs, the files follow your edits: every commit schedules a sweep that, after a 500 ms quiet period, rewrites the changed pages, moves renamed ones and removes deleted ones, and one sweep on start catches up on anything that happened while the server was down (`mirror/live.ts`, B-95, landed 2026-09-12 — before that only `nooklet export` ever wrote them). `nooklet export` still writes the whole graph on demand.
  - **One direction only.** ADR 002 and `docs/PLAN.md` §5 also describe the reverse — a watcher that turns a file edit into a block edit, echo-suppressed by hash. That does not exist: nothing in the server watches the files (`chokidar` is a dependency nothing imports), and editing a mirror file changes nothing in the graph; the next sweep overwrites it. Treat the files as the greppable, git-able copy the README describes, not as a place to edit.
  - `--no-mirror` is documented as turning the live mirror off (B-95) but does not: the argument parser only understands `--flag` and `--flag value`, so `--no-mirror` sets a flag named `no-mirror` that nothing reads, and `serve --no-mirror` still writes `pages/` (verified 2026-09-12 by serving this wiki with the flag).
  - The parser round-trips the format losslessly: verified on the real 952-page graph (17.5k blocks) to an identical tree (ADR 002).
- Related: [[Concepts]], [[Import from Logseq]], [[Agents and MCP]].
