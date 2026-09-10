# Logseq deep-dive for nooklet (research report, 2026-09-10)

Sources: shallow clones of `logseq/logseq` (DB product, commit `be800f17`, 2026-09-08) and `logseq/og` (file-based product, commit `6e7afa8e`, 2026-05-28) plus `logseq/marketplace`, the official docs repo, forum/HN threads, and GitHub code search. File paths below are relative to those clones; permalinks use the short hashes.

- OG (file graphs): https://github.com/logseq/og/tree/6e7afa8e
- DB version: https://github.com/logseq/logseq/tree/be800f17
- Official DB docs: https://github.com/logseq/docs/blob/master/db-version.md

---

## 0. Executive summary

1. **Logseq split into two products in April 2026.** `logseq/logseq` is now the SQLite/Datascript "DB version" (2.0 beta since 2026-07-13; RTC sync and mobile in alpha, sync is paid/invite-only, self-hostable). The Markdown-file product moved to `logseq/og` and is in maintenance mode (security + Electron updates only). Users who want plain files are being told to stay on OG; users who want sync are told to migrate. This is the single biggest source of churn and is exactly the gap nooklet can fill: *files + a real DB + reliable sync*.
2. **The file format is simple and well-defined** (see section 2): `pages/<Title>.md` and `journals/yyyy_MM_dd.md`, `- ` bullets, one tab per nesting level (configurable), continuation lines indented by `(level-1) tabs + 2 spaces`, `key:: value` property lines directly under the first line of a block, page properties as bullet-less `key:: value` lines at the top of the file, `id:: <uuid>` written only for referenced blocks, `collapsed:: true` for folded blocks, `[[Page]]`, `#tag`, `#[[multi word]]`, `((uuid))`, `{{embed ...}}`, `TODO`/`DONE` markers, `[#A]` priority, `SCHEDULED: <2026-09-10 Thu>` lines. Namespace pages `A/B/C` are stored as `pages/A___B___C.md` (triple-lowbar format; legacy `A%2FB%2FC.md` and very old `A.B.C.md` also exist).
3. **The OG data model is small**: a block is `{uuid, parent, left, page, content, properties, refs, path-refs, collapsed?, marker, priority, scheduled, deadline, format}`; a page is a block with `{name (lowercase), original-name, journal?, journal-day, namespace, alias, tags, file}`. Linked references = "blocks whose `path-refs` include this page (or its aliases), excluding blocks on the page itself, grouped by page". Unlinked references = regex scan of every block's content. Adopt this model but replace the `left` linked list with a fractional-index `order` string (which is what the DB version did) and keep `path-refs` derived, not stored.
4. **The DB version** stores Datascript B-tree nodes as transit blobs in a `kvs(addr, content, addresses)` SQLite table (not per-block rows), runs everything in a worker, syncs via an ordered server tx-log (`t-before` optimistic batches, WebSocket, checksums, E2EE) and does op-driven client rebase. It works but took ~3 years, broke Markdown ownership, removed whiteboards, broke many plugins, and produced a stream of "I'm leaving" posts. Lessons in section 3.6.
5. **Mistakes to avoid** (section 6): unpredictable sync that overwrites in-flight typing; a mobile app that is a wrapped desktop UI; a per-block `textarea` editor that fights the mobile IME; making the file format churn (three file-name encodings in three years); "TODO" and "A" becoming pages; storing plugin-visible state as datoms nobody can read with SQL; keeping users in "beta" for years.

---

## 1. Data model

### 1.1 File graph (OG) Datascript schema

`og/deps/db/src/logseq/db/schema.cljs` (https://github.com/logseq/og/blob/6e7afa8e/deps/db/src/logseq/db/schema.cljs):

| Attribute | Type / notes |
| --- | --- |
| `:block/uuid` | unique identity. From `id::` property if present, else `d/squuid` (time-prefixed v4). |
| `:block/parent` | ref, indexed. For top-level blocks this is the **page entity**. |
| `:block/left` | ref, indexed. The previous sibling, or the parent if first child. Ordering is a linked list. |
| `:block/page` | ref, indexed. The page the block lives on. |
| `:block/content` | full text of the block **including property lines** (`id:: …`, `collapsed:: true`), excluding the bullet and indentation. |
| `:block/format` | `:markdown` or `:org`. |
| `:block/collapsed?` | boolean, indexed. |
| `:block/refs` | many refs → pages (and blocks) this block directly references. |
| `:block/path-refs` | many refs → `refs` of this block ∪ refs of all ancestors ∪ its page. Used for linked references. |
| `:block/tags` | many refs → pages (for `tags::` on pages and for `#tag` on blocks, tags are also in refs). |
| `:block/alias` | many refs (pages only, from `alias::`). |
| `:block/marker` | string `"TODO" "DOING" "DONE" "LATER" "NOW" "WAITING" "WAIT" "CANCELED" "CANCELLED" "IN-PROGRESS"`. |
| `:block/priority` | `"A" "B" "C"`. |
| `:block/scheduled` / `:block/deadline` | int `yyyyMMdd`. `:block/repeated?` if the timestamp has a repeater. |
| `:block/properties` | map `{:kw parsed-value}`; parsed value is a **set of ref names** if the value contained `[[x]]`/`#x` (or the key is comma-separated), else `true/false/int/string`. |
| `:block/properties-order` | vector of keys in file order. |
| `:block/properties-text-values` | map key → original text (needed to round-trip). |
| `:block/invalid-properties` | keys that failed `valid-property-name?`. |
| `:block/pre-block?` | true for the bullet-less page-properties block at the top of a file. |
| `:block/heading-level` (legacy), `:heading` property | markdown `#` headings inside a block. |
| `:block/macros` | many refs → macro entities (`{{query}}`, `{{embed}}`, `{{renderer}}`). |
| `:block/created-at` / `:block/updated-at` | ms epoch (only if `:feature/enable-block-timestamps?`). |
| `:block/name` | page only. **lowercased, NFC-normalized** title; unique identity. |
| `:block/original-name` | page only. Cased title; unique. |
| `:block/journal?`, `:block/journal-day` | page only; day is int `yyyyMMdd`. |
| `:block/namespace` | page only, ref → parent namespace page (`a/b` for `a/b/c`). |
| `:block/file` | ref → `{:file/path "pages/foo.md" :file/content "..."}`. |
| `:block/type` | `"whiteboard"`, `"macro"`. |

Pages are just entities with `:block/name`; the page's blocks have `:block/page` pointing at it and top-level blocks have `:block/parent` = the page.

How a file becomes these entities: `og/deps/graph-parser/src/logseq/graph_parser/{extract.cljc,block.cljs}`. mldoc (OCaml → JS, https://github.com/logseq/mldoc) parses the file into an AST; each `Heading` node (list item) becomes a block; `construct-block` extracts marker/priority/timestamps/properties; `with-page-refs` collects refs from `[[...]]`, `#tag`, `{{embed [[x]]}}`, property values, **and the marker and priority strings** (so file graphs literally have pages named "TODO", "DONE", "A", "B" — do not copy this); `with-block-refs` collects `((uuid))`; `with-path-refs` walks levels to compute path-refs; `with-parent-and-left` turns levels into `parent`/`left` (it tolerates inconsistent indentation: a child that is indented by "at least one more unit" is accepted, an over-outdented block is re-attached to the nearest shallower ancestor).

Refs to a namespaced page also add refs to **every ancestor** (`split-namespace-pages "a/b/c"` → `["a" "a/b" "a/b/c"]`), which is how the page `a` gets linked references from blocks that only mention `[[a/b/c]]`.

### 1.2 Page refs, tags, block refs, namespaces in Datascript

- `[[Page]]` → `:block/refs` includes `[:block/name "page"]`; page created on demand (`page-name->map`) with `:block/journal?` computed by trying to parse the name as a date in any of ~30 formats (`journal-title-formatters`), so `[[Sep 10th, 2026]]` and `[[2026-09-10]]` both become journal refs.
- `#tag` / `#[[multi word]]` → same as a page ref, additionally listed in the block's `:tags`; page-level `tags::` → `:block/tags` on the page entity.
- `((uuid))` → `:block/refs` includes `[:block/uuid uuid]` (a block entity). The referenced block must have `id:: uuid` persisted in its file, which Logseq writes lazily the first time something references the block (`transform-content` in `og/src/main/frontend/modules/file/core.cljs` checks `:block/_refs`).
- `alias::` → `:block/alias` in both directions; all ref/linked-reference queries expand the page to its alias set (`page-alias-set`).
- Namespace `A/B/C` → three pages `a`, `a/b`, `a/b/c`; `a/b/c` has `:block/namespace → a/b`, `a/b` has `:block/namespace → a`. Hierarchy = recursive datalog rule `namespace` (`og/src/main/frontend/db/model.cljs` `get-namespace-hierarchy`, sorted by name). The page title is displayed in full (`A/B/C`); the page UI shows a "Hierarchy" tree at the bottom of any page that has namespace children; `get-page-namespace-routes` also lets `[[C]]` resolve to `A/B/C` if no page named `c` exists.

### 1.3 Linked references (file graph)

`og/src/main/frontend/db/model.cljs` `get-page-referenced-blocks`:

```
pages   = #{page-id} ∪ alias ids
entities = ∪ (:block/_path-refs page) for page in pages     ; blocks whose path-refs include the page
result  = remove (blocks whose :block/page == page-id)
        → group-by page → render each top-level referencing block with its subtree
```

Because `path-refs` inherits from ancestors, children of a referencing block are returned too; the UI dedups to top-level and renders children collapsed after `:ref/default-open-blocks-level` (default 2). Page-level `filters::` property stores include/exclude page sets for the references panel. The DB version reimplemented this in `deps/db/src/logseq/db/common/reference.cljs` with "effective refs = own refs ∪ parent's effective refs" and AND-includes / NONE-excludes semantics where an include cannot be satisfied by a descendant that sits under an excluded ref.

### 1.4 Unlinked references

OG: `get-page-unlinked-references` scans **every** `:block/content` datom with the regex
`(?i)(^|[^\[#0-9a-zA-Z]|((^|[^\[])\[))<name>($|[^0-9a-zA-Z])` for the page name and each alias (after stripping `:LOGBOOK:` drawers), drops blocks on the page itself, pulls them and groups by page. The look-behind clause is what excludes `[[name]]` and `#name`. This is O(all blocks) per open, which is one reason it's computed lazily on click. DB version: `unlinked-reference-exists?` runs the search engine for the title (limit 100) and filters candidates whose `:block/refs` don't include the page. For nooklet: use FTS5 for candidate generation, then a word-boundary check, exclude blocks that already ref the page; compute lazily.

### 1.5 DB-version schema for comparison

`deps/db/src/logseq/db/frontend/schema.cljs` (version string `"65.33"`):

- `:block/left`, `:block/content`, `:block/properties*`, `:block/marker`, `:block/priority`, `:block/scheduled`, `:block/deadline`, `:block/namespace`, `:block/journal?`, `:block/pre-block?` are **gone**.
- `:block/order` — a fractional-index string (`logseq.clj-fractional-indexing`, base-62 keys generated between neighbours; `deps/db/src/logseq/db/common/order.cljs`). Sorting siblings = `sort-by :block/order`. Moving a block = writing one datom.
- `:block/title` replaces content; refs inside titles are stored as `[[<uuid>]]` (and `#[[<uuid>]]`) and translated to `[[Title]]` on display (`deps/db/src/logseq/db/frontend/content.cljs`). This makes renames free and refs unambiguous but makes the raw text unreadable.
- `:block/name` is indexed but **no longer unique** — a page name is unique per tag ("Apple #Company" and "Apple #Fruit" coexist).
- Properties are real Datascript attributes with idents (`:user.property/foo`, `:logseq.property/status`); values are scalars or entities (closed values, refs). Tags are classes (`:block/tags → :logseq.class/Task` etc.) with `:logseq.property.class/extends` inheritance and `:logseq.property.class/properties`.
- Namespaces: pages have `:block/parent` → parent page; title is the leaf; a built-in "Library" page is the hierarchy root; typing `[[a/b/c]]` creates the chain under Library. Journals are pages tagged `#Journal` with `:block/journal-day`.
- Tasks: `#Task` tag + `:logseq.property/status` (Backlog/Todo/Doing/In Review/Done/Canceled), `:logseq.property/priority` (urgent/high/medium/low), `:logseq.property/deadline`, `:logseq.property/scheduled` (datetime property values that point at journal pages), repeat properties.
- Built-in classes: Root, Tag, Property, Page, Journal, Whiteboard, Task, Query, Card, Asset, Code-block, Quote-block, Math-block, Pdf-annotation, Template, Comment(s).
- `:block/link` (for tag→page links and embeds), `:block/closed-value-property`, `:block/tx-id` (latest tx that touched the block, used for render deltas), `:block/created-at`/`updated-at` always present.

**Recommendation for nooklet's block model** (SQL, simplified):

```sql
pages(id uuid pk, name text unique /*lowercase NFC*/, title text, journal_day int null,
      parent_page_id uuid null /*namespace parent, derived from title*/, created_at, updated_at, file_path text null)
page_alias(page_id, alias_page_id)
blocks(id uuid pk, page_id uuid, parent_id uuid null /*null = top level*/, ord text /*fractional index*/,
       content text, props json /*ordered key->raw text*/, collapsed bool, marker text null, priority text null,
       scheduled int null, deadline int null, created_at, updated_at)
refs(block_id, target_page_id null, target_block_id null, kind /*page|tag|block|embed|prop*/)
-- path_refs are derived: refs of ancestors via recursive CTE, or maintained as a materialized table keyed by (page_id, block_id)
```

Keep `content` as the single source of truth for the block text (Logseq does), store parsed structure alongside, and never put `TODO` or `A` in the refs table.

---

## 2. Markdown file format (import/export spec)

### 2.1 Directory layout

```
<graph>/
  logseq/
    config.edn            ; graph config (EDN). Required.
    custom.css, custom.js ; optional
    metadata.edn          ; graph uuid etc.
    pages-metadata.edn    ; older versions only: per-page created/updated timestamps
    bak/                  ; automatic backups of overwritten files (bak/pages/<name>/<timestamp>.md)
    version-files/        ; file-sync versions
  pages/                  ; one .md per page (:pages-directory)
    contents.md           ; the "Contents" sidebar page (special-cased by name)
    A___B___C.md          ; namespace page "A/B/C" (triple-lowbar format)
    hls__<pdf>_<ts>.md    ; PDF highlight pages (skip on import or keep as pages)
  journals/               ; one .md per day (:journals-directory)
    2026_09_10.md
  assets/                 ; images/files, referenced as ../assets/<name>
  whiteboards/*.edn       ; ignore
  draws/*.excalidraw      ; ignore
  .recycle/               ; deleted pages (ignore)
```

Files considered: `.md`, `.markdown`, `.org` (org-mode graphs exist; you may skip org). `:hidden ["/archived" ...]` patterns in config are excluded. Hidden files/dirs (leading dot) are ignored (`og/src/main/frontend/util/fs.cljs` `ignored-path?`).

### 2.2 config.edn essentials (OG template `og/src/resources/templates/config.edn`)

```clojure
{:meta/version 1
 :preferred-format "Markdown"          ; or "Org"
 :preferred-workflow :now              ; :now => NOW/LATER cycle, :todo => TODO/DOING
 :hidden []                            ; paths to hide
 :default-templates {:journals ""}     ; template name applied to new journal pages
 :journal/page-title-format "MMM do, yyyy"   ; default title format -> "Sep 10th, 2026"
 :journal/file-name-format "yyyy_MM_dd"      ; default; not retroactive
 :feature/enable-journals? true
 :pages-directory "pages" :journals-directory "journals" :whiteboards-directory "whiteboards"
 :export/bullet-indentation :tab       ; :tab (default) | :two-spaces | :four-spaces | :eight-spaces
 :file/name-format :triple-lowbar      ; absent => legacy url-encoded names
 :property-pages/enabled? true         ; create a page per property key
 :property-pages/excludelist #{}
 :property/separated-by-commas #{}     ; extra keys whose values split on commas (alias/tags always do)
 :ignored-page-references-keywords #{} ; property keys whose values never become refs
 :block-hidden-properties #{}
 :editor/logical-outdenting? false
 :ref/default-open-blocks-level 2
 :ref/linked-references-collapsed-threshold 50
 :default-queries {:journals [...]}    ; queries rendered at the bottom of today's journal
 :favorites []                         ; page names
 :macros {} :commands [] :shortcuts {}
 :start-of-week 6 :scheduled/future-days 7
 :ui/show-brackets? true :ui/enable-tooltip? true
 :block/content-max-length 10000}
```

For an importer the keys that change parsing are: `:journal/page-title-format` (how journal titles are rendered and therefore how `[[Sep 10th, 2026]]` refs are recognised), `:journal/file-name-format`, `:file/name-format`, `:pages-directory`/`:journals-directory`, `:hidden`, `:property/separated-by-commas`, `:ignored-page-references-keywords`, `:preferred-format`. For an exporter: `:export/bullet-indentation` and `:file/name-format`.

### 2.3 Page file naming

Pages: `pages/<file-name>.md` where file-name = `file-name-sanity(title)` (`og/src/main/frontend/util/fs.cljs`). Triple-lowbar rules (since 0.8.9, PR https://github.com/logseq/logseq/pull/6134), applied in this order:

1. `page-name-sanity`: NFC-normalize, strip leading/trailing `/`. Case is preserved.
2. Pre-encode existing `%XX` sequences: `%` → `%25`.
3. Percent-encode reserved characters `: * ? " < > | # \` (`encodeURIComponent`, plus `*` → `%2A`).
4. A leading `.` → `%2E` (so it isn't a hidden file).
5. Windows reserved basenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) or a trailing `.` get a `/` appended (which then becomes `___`).
6. Disambiguate underscores: `___` → `%5F%5F%5F`, `_/` → `%5F/`, `/_` → `/%5F`; then `/` → `___`.

Parsing back (`gp-util/title-parsing`): `___` → `/`, percent-decode, drop empty segments. If `parse(sanitize(title)) != title` (or the name has reserved chars), Logseq also writes a `title:: <original>` page property, and `title::` **always wins** over the file name (`extract.cljc` `get-page-name`: `title::` property > file name > first block). Examples: `A/B/C` → `A___B___C.md`; `Foo: bar?` → `Foo%3A bar%3F.md`; `my_var/x` → `my%5F var...` only when ambiguous.

Legacy formats you must accept on import: `:legacy` (2022-05 → 0.8.9): `/` → `%2F`, other reserved chars url-encoded (e.g. `A%2FB%2FC.md`); `:legacy-dot` (before 2022-05): `/` → `.` (`A.B.C.md`; decode by replacing `.` with `/` — note the ambiguity that motivated the change). Rule of thumb for an importer: if `config.edn` has `:file/name-format :triple-lowbar` use triple-lowbar parsing, else legacy; always let `title::` override; treat `%2F` as `/` in either mode.

Page identity is the **lowercased NFC title** (`:block/name`); `Foo` and `foo` are the same page; `[[Foo]]` and `[[foo]]` link the same page and the displayed name is whichever the file/first write used.

Journals: `journals/<date>.md` with `:journal/file-name-format` (default `yyyy_MM_dd`, e.g. `journals/2026_09_10.md`). The page title is `:journal/page-title-format` (default `MMM do, yyyy` → `Sep 10th, 2026`), `:block/name` is its lowercase (`sep 10th, 2026`), `:block/journal-day` = `20260910`. Journal detection on import: try parsing the file body (`2026_09_10`) and the `title::` with the configured format and then the fallback list (`yyyy-MM-dd`, `yyyy_MM_dd`, `yyyyMMdd`, `MMM do, yyyy`, `E, dd-MM-yyyy`, `yyyy年MM月dd日`, ...) in `og/src/main/frontend/date.cljs` `journal-title-formatters`. File-style refs like `[[2026_09_10]]` should resolve to the journal page (the DB importer added this rule in 2026, `docs/og_import_graph_cases.md`).

### 2.4 Block syntax inside a file

Writer (`og/src/main/frontend/modules/file/core.cljs` `transform-content` / `tree->file-content`):

```
level L (1-based), indent unit U = "\t" (default) :
  first line   = U×(L-1) + "-" + " " + line1          ; just "-" if content empty
  other lines  = U×(L-1) + "  " + lineN               ; two spaces after the indent
```

Verbatim from the OG test fixture (`og/src/test/frontend/handler/export_test.cljs`; `\t` are real tabs):

```
- 1
  id:: 61506710-484c-46d5-9983-3d1651ec02c8
\t- 2
\t  id:: 61506711-5638-4899-ad78-187bdc2eaffc
\t\t- 3
\t\t  id:: 61506712-3007-407e-b6d3-d008a8dfa88b
\t\t- ((61506712-3007-407e-b6d3-d008a8dfa88b))
- 4
  id:: 61506712-b8a7-491d-ad84-b71651c3fdab
```

A complete page as Logseq OG writes it:

```markdown
title:: Project/Alpha
alias:: Alpha, Project Alpha
tags:: project, [[Active]]
type:: project

- Kickoff notes for [[Client X]] #meeting
  id:: 66e0a1c2-1b2e-4f3a-9c5d-0123456789ab
  collapsed:: true
	- TODO Send proposal to [[Client X]]
	  SCHEDULED: <2026-09-12 Sat>
	- DONE [#A] Book room
	  :LOGBOOK:
	  CLOCK: [2026-09-10 Thu 09:00:00]--[2026-09-10 Thu 09:30:00] =>  00:30:00
	  :END:
	- LATER Write summary
	  deadline:: not a real timestamp, just a property
- ## Heading block
  heading:: 2
- Multi-line block
  second line of the same block
  ```js
  console.log("code fences are just lines of the block")
  ```
- {{embed ((66e0a1c2-1b2e-4f3a-9c5d-0123456789ab))}}
- {{embed [[Client X]]}}
- {{query (and [[project]] (task TODO))}}
- Numbered
  logseq.order-list-type:: number
	- child
	  logseq.order-list-type:: number
- ![diagram](../assets/diagram_1694000000000_0.png)
- [Label]([[Client X]]) and a #[[multi word tag]] and a plain link https://example.com
```

Rules an importer/exporter must implement:

- **Bullets**: every block starts with `- ` (Logseq also parses `* ` and `+ `, and numbered `1. ` lists become blocks with `logseq.order-list-type:: number`). Nesting = indentation. Tabs are the default unit; spaces are accepted (mldoc computes list nesting from the column; Logseq's DB Markdown mirror writes **2 spaces** per level, and many users configure 2/4 spaces). Be tolerant: treat a tab as one level, and infer the space width from the first indented line (2 or 4); accept inconsistent indentation by attaching to the nearest shallower ancestor (as `with-parent-and-left` does).
- **Block content** = the bullet's first line plus all following lines that are indented at least as deep as the content column, de-indented (`gp-mldoc/remove-indentation-spaces`). Blank lines inside a block are preserved (`:keep_line_break true` in `mldoc/default-config`). Code fences, tables, quotes, LaTeX blocks all live inside a block as lines.
- **Block properties**: lines `key:: value` immediately after the first line (a "properties" group). Keys are lowercased and `_`→`-`; `custom-id`/`custom_id` → `id`; keys must be valid EDN keywords without `" | ^ ( ) { }` and not start with `#`. `id::` is the block uuid (written only when the block is referenced, but honoured whenever present; duplicates are repaired by assigning a new uuid to later ones). `collapsed:: true` marks folded (absence or `false` = expanded; Logseq removes the line when expanded). `heading:: N` for headings; `background-color::`, `logseq.order-list-type::`, `hl-*::` (PDF), `ls-type::`, `created-at::`/`updated-at::` (ms ints) are other built-ins. Property lines stay inside `:block/content`; the UI hides "hidden built-in" ones (`gp-property/hidden-built-in-properties`).
- **Property values**: `parse-property` (`og/deps/graph-parser/src/logseq/graph_parser/text.cljs`): if the key is a built-in "unparsed" one or in `:ignored-page-references-keywords`, keep the string; if the value is `"quoted"`, keep the string; else collect refs from `[[x]]`, `#x`, `[label]([[x]])` (and split on `,`/`，` for `alias`, `tags` and `:property/separated-by-commas` keys) → a **set** of page names; else `true`/`false`/integer; else string. Every ref in a property value becomes a page ref of the block. Property **keys** also become pages when `:property-pages/enabled?` (default true) — nooklet should not do this by default.
- **Page properties**: the first block of a file, if it consists of `key:: value` lines with no bullet, is the "pre-block" (`:block/pre-block? true`); its properties are the page's properties. Well-known keys: `title::`, `alias::` (comma-separated), `tags::` (comma-separated, become `:block/tags`), `public::`, `icon::`, `filters::`, `exclude-from-graph-view::`, `template::` (block-level, names a template), `template-including-parent::`. YAML front matter (`---` … `---`) is also parsed by mldoc as page properties on legacy files; write `key::` style. The writer emits the pre-block trimmed, followed by a blank line.
- **Markers**: the first word of a block if it is one of `TODO DOING DONE LATER NOW WAITING WAIT CANCELED CANCELLED IN-PROGRESS` → `:block/marker`; then optional `[#A]`/`[#B]`/`[#C]` → `:block/priority`. The remaining text is the title. Checkbox rendering is derived, not stored.
- **Timestamps**: a line `SCHEDULED: <2026-09-12 Sat>` or `DEADLINE: <2026-09-12 Sat 10:00 .+1w>` (org syntax, optional time, repeater `+1d`/`++1w`/`.+1m`) directly under the first line (before or after property lines); parsed by mldoc as `Timestamp`, stored as int `yyyyMMdd` plus `repeated?`. `:LOGBOOK:` … `:END:` drawers hold `CLOCK:` entries for time tracking — preserve as opaque lines.
- **Headings**: `- # Title` is a block whose content starts with `#`; Logseq stores `heading:: N` or, for `#` typed manually, mldoc reports `:size`. A *first* block that is a heading may be written **without** a bullet (`markdown-top-heading?`), and pre-0.6 files exported with `:heading_to_list` turn `# H1` lines into level-1 blocks — accept bullet-less `#` lines at top level as blocks.
- **References**: `[[Page]]` (nested `[[a [[b]]]]` allowed but rare), `#tag`, `#[[multi word]]`, `((uuid))` block ref, `[label]([[Page]])`, `[label](((uuid)))`, `{{embed [[Page]]}}`, `{{embed ((uuid))}}`, `{{query ...}}` simple query, `#+BEGIN_QUERY … #+END_QUERY` advanced (Datalog) query, `{{renderer :plugin, args}}` (plugins), `{{video url}}`, `{{cloze x}}`, `{{macro args}}` from `:macros`. Assets: `![alt](../assets/name.png)`; `../assets/` is relative to `pages/` or `journals/`.
- **Escapes**: none. Logseq does not escape `[[` inside code; it relies on mldoc not parsing links inside fenced code / inline code.
- **Org mode**: `* Heading` levels, `:PROPERTIES:` drawers, `[[file:../pages/x.org][x]]` links; `->new-properties` converts drawers to `key::` form in content. Optional for nooklet.

Import-time repairs Logseq's own importer performs and you should copy (`logseq/logseq docs/og_import_graph_cases.md`): drop `((uuid))` whose target does not exist after all files are read (keep forward refs), de-duplicate `id::`, create missing referenced pages once, resolve `[[2026_04_01]]` to journals, tolerate empty files and 10k+ top-level blocks without recursion.

### 2.5 Writing files (export) and round-trip safety

- Rewrite the **whole file** from the block tree on every save (Logseq does; it debounces and writes via `alter-files-handler!`, keeping a copy in `logseq/bak/` when the on-disk content differs from what it last wrote).
- Only add `id::` when a block gains an incoming reference; keep `id::` if present. Keep unknown property lines and unknown text verbatim (`:block/properties-text-values` exists precisely to round-trip values).
- `collapsed:: true` toggling and `id::` insertion go through `insert-property` (`og/src/main/frontend/util/property.cljs`): if the block already has a property group, add/replace the key there; else insert after the first line; else at the top.
- Watching the directory: OG parses external changes and, when a file changed both on disk and in memory, does a 2-way diff-merge to keep block uuids stable (`resolve-uuid-fn`/`extracted-block-ids` in `extract.cljc`). For nooklet: on external change, re-parse the file, match blocks by `id::` first, then by (position, content) diff, and only then assign new uuids.

---

## 3. The DB version (2024–2026)

### 3.1 Storage

- Datascript in memory; persisted through a custom `IStorage` into SQLite table `kvs(addr TEXT PRIMARY KEY, content TEXT, addresses TEXT)` where each row is a serialized B-tree node (transit-json, `deps/db/src/logseq/db/sqlite/util.cljs`). There are **no per-block rows** — you cannot `SELECT * FROM blocks`; only Logseq/`nbb-logseq`/the CLI can read it. Additional files per graph: `search-db.sqlite` (FTS5 + vector index), `client-ops-db.sqlite` (`client_ops`, `sync_meta` tables, ADR 0015). Desktop location `~/logseq/graphs/<name>/db.sqlite`; browser uses SQLite-WASM in OPFS.
- Everything runs in a **worker** (`src/main/frontend/worker/`), on desktop as a localhost `db-worker-node` daemon (HTTP `POST /v1/invoke` with transit args, SSE `/v1/events`, lock file per graph, one writer per graph). The renderer only receives "render deltas" (block replacements keyed by uuid, child-membership patches keyed by parent, affected resource keys) and re-renders subscribed slots. This is the architecture that finally made large graphs fast; see `docs/agent-guide/implemented/architecture/2026-08-24-logseq-runtime-and-engineering-guide.md`.
- Schema version `65.33` with a migration list; a `graph validate` command (Malli schema) exists because invalid states kept appearing.

### 3.2 What changed vs file graphs

See 1.5. User-visible: nodes (pages ≈ blocks), typed properties (text/number/date/datetime/checkbox/url/node/asset) with choices and defaults, tags-as-classes with property inheritance and bidirectional properties, unique-per-tag page names, views (table/list/gallery) everywhere including linked references, task status history, repeat tasks, "Library" for namespaces, recycle bin (30 days), block-ref syntax deprecated in favour of `[[node]]` refs. Whiteboards removed. Only one embed/query/quote per block.

### 3.3 Sync / RTC

Design (`deps/db-sync/`, ADRs 0001–0015, runtime guide):

- Server: Cloudflare Worker + D1 (graph metadata, membership) + a Durable Object per graph holding an **ordered transaction log** (`tx_log`, `sync_meta`) + R2 for snapshots and assets. A Node adapter exists for self-hosting.
- Protocol: WebSocket JSON envelopes with transit payloads: `hello` (→ current `t` + checksum), `pull {since}` (→ txs after t), `tx/batch {t-before, txs}` (must equal server `t` or gets `tx/reject` with current `t`), `presence {editing-block-uuid}`, server broadcasts `changed`, `online-users`. HTTP routes for `/pull`, `/tx/batch`, `/snapshot/upload|download|stream`, `/checksum/diagnostics`.
- Client: pending local txs are persisted with their **semantic outliner ops** (`:insert-blocks :save-block :move-blocks :delete-blocks :transact`; indent/outdent normalised to move) and on rejection the client does **op-driven rebase**: reverse local txs, apply remote txs, transform/drop local ops against the new DB, replay (ADR 0010). Each pending tx = one user action, atomic (dropped whole if any op is invalid). Large txs are chunked at 5000 datoms without splitting inseparable groups. A normalized entity checksum is compared after each batch; mismatches trigger full re-pull.
- E2EE per graph (password → key; server cannot read; MCP/REST fail closed on encrypted graphs).
- Stress-tested with a multi-client CLI harness (`docs/sync/failed-cases.md`): 3 clients × 10k concurrent ops with offline windows converge; the failure log shows the actual hard problems: duplicate `create-page` for the same title from two clients, delete/recreate of the same uuid in one batch, stale moves before a later delete, property batches against deleted targets, missing lookup refs. Design accordingly: page creation must be idempotent by (normalized name), moves must tolerate a deleted target, and every op needs a "target vanished" rule.

### 3.4 Markdown Mirror (2026-05, ADR 0016)

Because users demanded files, the DB app now optionally writes a **one-way** `mirror/markdown/{pages,journals}/*.md` (Electron only), worker-owned, debounced, atomic writes, `.index.edn` mapping page uuid → path, duplicate titles become `Foo (2).md`, every file starts with `id:: <page uuid>`, blocks are `- `, properties are `* key:: value` items, 2-space indentation, `[[Title]]` refs (ambiguous by design), `- TODO x` markers. Editing the mirror does nothing; two-way is "in research". This is the concession that shows the market: people want files that are also the truth.

### 3.5 CLI, HTTP API, MCP

- `logseq` CLI (OCaml→JS) talks to the daemon: `graph list/create/switch/export/import/backup`, `list/show/search/query/upsert/move/remove` for nodes, `sync ...`, `skill show` (ships an agent skill), `--output json|edn`. Custom named Datalog queries in `cli.edn`.
- Semantic REST (`deps/db-sync/.../routes/semantic.cljs`) under `/api/v1/graphs/:graph-id/…`: `pages` (GET/POST), `pages/:id` (GET/PATCH/DELETE), `pages/:id/blocks`, `pages/:id/references`, `blocks/:id` (GET/PATCH/DELETE), `blocks/:id/children` (POST), `block-trees` (POST), `block-moves` (POST), `blocks/:id/properties/:pid` (PUT/DELETE), `block-properties/batch-set|batch-delete`, `capture` (POST to today's journal), `tasks` (GET/POST), `tags`, `tags/:id/objects`, `properties`, `assets` (100 MB, sha-256), `search`. OAuth scopes `logseq/read` / `logseq/write`, generated `/openapi.json`, and MCP is a thin wrapper over the same API ("do not create a second mutation API for MCP"). Desktop app also exposes a local MCP server on `127.0.0.1:12315/mcp` with bearer token. Good template for nooklet's API: resource-oriented, moves as their own endpoint, batch property ops, `capture` as a first-class verb, one API for HTTP+MCP.

### 3.6 Lessons / complaints from the transition

From HN "Logseq 2.0 Beta (DB version) is here" (https://news.ycombinator.com/item?id=48896229), forum "Is anyone planning to use OG version indefinitely?" (https://discuss.logseq.com/t/is-anyone-planning-to-use-og-version-indefinitely/35091), the split announcement (https://logseq.io/p/e3YDyX5AYr), the unofficial FAQ:

- "Transparent native Markdown was my top feature" → leaving for Obsidian/org-roam/SilverBullet/Trilium. Files matter more for the AI-agent era ("half my edits are done by Claude").
- Years of stagnation on 0.10.x while the DB branch was private; Sync "still in beta" after people paid; trust erosion.
- DB beta unreliable; SQLite sync bandwidth-heavy; whiteboards and Zotero removed; only ~65 plugins DB-compatible; Android app not even alpha until late 2026.
- OG users worry about Electron rot and lack of forks.
- Praise: the outliner itself ("fits how my brain works"), tags-with-properties, faster on big graphs, the CLI for agents.

---

## 4. Editor implementation (OG; DB is similar in structure)

`og/src/main/frontend/components/{block,editor}.cljs`, `handler/editor.cljs` (4.5k lines).

- **One textarea at a time.** Every block renders as static HTML (`block-content`, hiccup from mldoc AST). Clicking sets `state/set-editing! edit-input-id content block` and that block re-renders as `editor/box` → an autosizing `<textarea>` (`ls-textarea`, `react-textarea-autosize`) with a hidden `mock-textarea` used to measure caret position for popups. Blur/Esc saves: `save-block!` re-parses the raw text with mldoc and transacts. IDs are `edit-block-<container>-<uuid>` so the same block can be edited in the sidebar/embeds.
- **Enter** (`keydown-new-block`): if an autocomplete popup is open, it selects; otherwise DWIM ("thing at point": inside `[[ ]]` → jump out, inside a code fence/admonition → newline, on a list item → continue list, on a properties block → next property); if the block is empty and last child → outdent instead (`outdent-on-enter`); else split at cursor: text before → current block, text after → new block. New block is a **sibling** unless the current block has children and is expanded (`outliner-insert-block!`: `sibling? = collapsed? or (not has-children?)`), in which case it becomes the **first child**. Cursor at start with text → new empty block **before** (`insert-new-block-before-block-aux!`).
- **Shift+Enter** newline inside the block (`:shortcut/doc-mode-enter-for-new-block?` swaps the two).
- **Tab / Shift+Tab** (`indent-outdent`): save, run `outliner-core/indent-outdent-blocks!`, re-enter edit at the same cursor pos. Indent = move under the previous sibling (as last child; expands it if collapsed); outdent = move after the parent, and — unless `:editor/logical-outdenting?` — the following siblings become children of the outdented block ("direct outdenting", Workflowy style).
- **Backspace at pos 0**: if the block has no children (or the previous block has none), delete it and append its text to the previous *visible* block (`move-to-prev-block`), placing the caret at the join (`:tail-len`). Backspace also unpairs `[[`/`((`/`""` and cancels `/` and `<` popups.
- **Arrows**: up/down at first/last line move editing to the previous/next visible block keeping the column; Esc → exit editing and *select* the block; in selection mode Shift+Up/Down extends, Tab/Shift+Tab indent the selection, Delete removes, Cmd/Ctrl+C copies as Markdown subtree, drag handle on the bullet moves subtrees (drop target = sibling/child by x-offset).
- **Alt+Up/Down** move block up/down (`move-blocks-up-down`), Cmd/Ctrl+Enter cycles TODO marker, Cmd+Shift+A select all blocks, `t o` toggle open all, zoom into a block by clicking its bullet (URL `/page/<uuid>`).
- **Autocomplete** is a state machine on `:editor/action` (`:page-search`, `:page-search-hashtag`, `:block-search`, `:commands`, `:block-commands`, `:template-search`, `:property-search`, `:property-value-search`, `:datepicker`, `:input`). Triggers are detected in `keyup-handler`/`keydown-not-matched-handler`: typing `[[` (autopaired to `[[]]`, caret inside) → page search; `((` → block search (fuzzy over block contents); `#` → hashtag page search (also `#[[`); `/` → slash commands (fuzzy over command names, `commands/*matched-commands`); `<` → block commands (`<query`, `<src`, ...); `::` at line start → property key search then value search. Popups are absolutely positioned at the caret (`absolute-modal`, uses the mock textarea's caret rect, flips when near the bottom). Autopairs: `[] {} () `` ~~ ** ^^ == "" `.
- **IME/mobile hacks**: keydown is unusable on Android (keyCode 229/0), so Android reconstructs the key from the last char in `keyup-handler`; composition events are checked everywhere (`goog-event-is-composing?`); a `mobile-bar` toolbar (indent/outdent, undo/redo, today/tomorrow/yesterday refs, timestamp, `/` commands, camera) is pinned above the keyboard using a measured `keyboard-height`.
- **Known mobile pain points** (issues #378, #3872, #5128, #11251, forum threads): caret hidden under the toolbar without auto-scroll; toolbar mispositioned in linked references or missing on some Samsung devices; toolbar disabled with a hardware keyboard; the per-block textarea swap causes the keyboard to flash/dismiss when moving between blocks; selection mode is unreachable by touch; long journals are slow because every block is a React component; sync stalls freeze typing (issue #10999: text typed during sync "gets erased or jumbled"). Users' verdict: "nearly impossible to use without a keyboard".

Recommendation for nooklet: keep the *model* (render static, edit one block, split/merge/indent semantics exactly as above — users' muscle memory expects it) but implement the mobile editor differently: a single contenteditable per page or a persistent textarea that is re-targeted (so the keyboard never dismisses), `visualViewport`-driven toolbar placement, `scrollIntoView` on caret move, and never block typing on sync.

---

## 5. Plugin API

### 5.1 Model

`@logseq/libs` (npm, v0.3.4; `libs/src/*.ts`). A plugin is a `package.json` with a `logseq` block (`id`, `main` → HTML file, `title`, `icon`, `themes`) plus built JS. Logseq loads `main` into an **`<iframe>` sandbox** (or a *shadow DOM* mode for lightweight UI plugins, `mode: 'shadow' | 'iframe'`), connects it via a postMessage RPC channel (a vendored Postmate, `libs/src/postmate/`), and exposes a `logseq` global whose namespaces are proxies: every call is `async` (`logseq.Editor.getBlock(...)` → RPC → `src/main/logseq/api.cljs` in the host). Plugin UI is injected into the host through `provideUI({key, slot|path, template})` (HTML string sanitized with DOMPurify, into named slots such as toolbar, page-head, block-body) and `provideStyle`; plugin logic can be called from injected HTML via `data-on-click` handlers registered with `provideModel`. Settings: `useSettingsSchema([...])` renders a form and persists JSON under `~/.logseq/settings/<id>.json`. Lifecycle: `logseq.ready(main)`, `logseq.beforeunload`, `logseq.App.onCurrentGraphChanged`. Themes are plugins that only `provideTheme`/CSS. Marketplace = GitHub repo `logseq/marketplace` (~617 packages, `packages/<id>/manifest.json`), installed by downloading release zips.

### 5.2 Surface (from `libs/src/LSPlugin.ts` on the DB repo; OG is the same minus DB-only methods)

- `logseq.App`: `getInfo`, `getUserConfigs` (date format, preferred format, theme…), `getCurrentGraph`, `checkCurrentIsDbGraph`, `registerCommand/registerCommandPalette/registerCommandShortcut`, `registerUIItem({type:'toolbar'|'pagebar', template})`, `registerPageMenuItem`, `pushState/replaceState/getCurrentRoute`, `openExternalLink`, `execGitCommand`, `set{Left,Right}SidebarVisible`, `getCurrentGraphFavorites/Recent/Templates`, `insertTemplate`, hooks `onCurrentGraphChanged`, `onRouteChanged`, `onThemeModeChanged`, `onSidebarVisibleChanged`, `onMacroRendererSlotted` (render `{{renderer :x}}`), `onBlockRendererSlotted`, `onPageHeadActionsSlotted`, `onBeforeCommandInvoked`.
- `logseq.Editor`: `registerSlashCommand(name, fn|actions)`, `registerBlockContextMenuItem`, `registerHighlightContextMenuItem`, `checkEditing`, `getEditingBlockContent`, `getEditingCursorPosition`, `insertAtEditingCursor`, `restoreEditingCursor`, `exitEditingMode`, `getCurrentPage`, `getTodayPage`, `getCurrentBlock`, `getSelectedBlocks`, `getCurrentPageBlocksTree`, `getPageBlocksTree`, `getPageLinkedReferences`, `getPagesFromNamespace`, `getPagesTreeFromNamespace`, `newBlockUUID`, `insertBlock(src, content, {sibling, before, isPageBlock, properties, focus})`, `insertBatchBlock(src, IBatchBlock[] {content, children, properties}, {sibling, before, keepUUID})`, `updateBlock`, `removeBlock`, `getBlock(id, {includeChildren})`, `setBlockCollapsed`, `getPage`, `createPage(name, properties, {createFirstBlock, redirect, journal, format})`, `createJournalPage`, `deletePage`, `renamePage`, `getAllPages`, `prependBlockInPage`, `appendBlockInPage`, `getPreviousSiblingBlock`, `getNextSiblingBlock`, `moveBlock(src, target, {before, children})`, `editBlock(id, {pos})`, `selectBlock`, `upsertBlockProperty`, `removeBlockProperty`, `getBlockProperty`, `getBlockProperties`, `getPageProperties`, `scrollToBlockInPage`, `openInRightSidebar`; DB-only: `getAllTags`, `getAllProperties`, `getTagObjects`, `createTag`, `addTagProperty`, `addTagExtends`, `addBlockTag`, `upsertProperty`, `setBlockIcon`, `addPropertyValueChoices`, `restorePage`.
- `logseq.DB`: `q(dsl)` (simple query DSL), `datascriptQuery(query, ...inputs)`, `onChanged({blocks, txData, txMeta})`, `onBlockChanged(uuid, cb)`, `getFileContent/setFileContent` (file graphs).
- `logseq.UI`: `showMsg(content, status, {key, timeout})`, `closeMsg`, `queryElementRect`, `queryElementById`, `checkSlotValid`, `resolveThemeCssPropsVals`.
- `logseq.Assets`: `listFilesOfCurrentGraph`, `makeSandboxStorage` (per-plugin file storage under `assets/storages/<id>`), `makeUrl`, `builtInOpen`. `logseq.FileStorage` (per-plugin KV/file store). `logseq.Git`: `execCommand`, `loadIgnoreFile`, `saveIgnoreFile`. `logseq.Experiments`: React/internal component reuse, custom fenced-code renderers, route/sidebar renderers.
- Top level: `ready`, `beforeunload`, `provideUI`, `provideStyle`, `provideModel`, `provideTheme`, `useSettingsSchema`, `updateSettings`, `onSettingsChanged`, `showSettingsUI`, `showMainUI/hideMainUI/toggleMainUI`, `setMainUIInlineStyle`, `resolveResourceFullUrl`, `logseq.settings`, `logseq.baseInfo`, `logseq.isMainUIVisible`.

Block entity shape seen by plugins: `{uuid, id, content (deprecated in DB → title), format, page:{id}, parent:{id}, left:{id} (file), properties:{}, children:[uuid tuples | BlockEntity[]], marker, priority, scheduled, deadline, refs, pathRefs, collapsed?, ...}`; page entity `{uuid, id, name, originalName, journal?, journalDay, namespace, properties, format, file}`.

### 5.3 Most-used methods (GitHub code-search hit counts, 2026-09-10)

GitHub code search `"<method>"` total hits (files, all languages; includes forks and docs, so treat as relative popularity, not absolute). Raw data: `scratchpad/research/api_counts.tsv`.

| Rank | Method | Hits | Rank | Method | Hits |
| --- | --- | ---: | --- | --- | ---: |
| 1 | `Editor.getBlock` | 662 | 21 | `Editor.upsertBlockProperty` | 203 |
| 2 | `Editor.getPage` | 613 | 22 | `Editor.insertAtEditingCursor` | 186 |
| 3 | `UI.showMsg` | 581 | 23 | `App.showMsg` (legacy alias) | 174 |
| 4 | `Editor.updateBlock` | 433 | 24 | `Editor.appendBlockInPage` | 168 |
| 5 | `useSettingsSchema` | 399 | 25 | `onSettingsChanged` | 157 |
| 6 | `Editor.insertBlock` | 390 | 26 | `App.pushState` | 150 |
| 7 | `DB.datascriptQuery` | 374 | 27 | `Editor.insertBatchBlock` | 149 |
| 8 | `Editor.registerSlashCommand` | 368 | 28 | `DB.q` | 146 |
| 9 | `Editor.getPageBlocksTree` | 340 | 29 | `setMainUIInlineStyle` | 142 |
| 10 | `provideModel` | 338 | 30 | `App.onMacroRendererSlotted` | 136 |
| 11 | `provideStyle` | 337 | 31 | `Editor.registerBlockContextMenuItem` | 130 |
| 12 | `App.registerCommandPalette` | 317 | 32 | `DB.onChanged` | 129 |
| 13 | `App.getUserConfigs` | 298 | 33 | `Editor.getAllPages` | 120 |
| 14 | `Editor.createPage` | 298 | 34 | `Editor.exitEditingMode` | 118 |
| 15 | `Editor.getCurrentBlock` | 294 | 35 | `Editor.getCurrentPageBlocksTree` | 106 |
| 16 | `App.registerUIItem` | 284 | 36 | `beforeunload` | 104 |
| 17 | `hideMainUI` / `showMainUI` | 280 / 267 | 37 | `App.onRouteChanged` / `onThemeModeChanged` | 97 / 97 |
| 18 | `Editor.getCurrentPage` | 263 | 38 | `Editor.deletePage` | 94 |
| 19 | `App.getCurrentGraph` | 231 | 39 | `Editor.editBlock` | 91 |
| 20 | `provideUI` | 223 | 40 | `App.onCurrentGraphChanged` | 88 |

Long tail (< 90): `Editor.openInRightSidebar` 83, `getBlockProperties` 72, `getSelectedBlocks` 69, `getEditingBlockContent` 67, `moveBlock` 65, `scrollToBlockInPage` 62, `getEditingCursorPosition` 61, `getPageLinkedReferences` 60, `App.getInfo` 58, `checkEditing` 56, `setBlockCollapsed` 47, `getBlockProperty` 45, `renamePage` 45, `App.registerCommandShortcut` 41, `App.onSidebarVisibleChanged` 41, `Git.execCommand` 40, `App.registerPageMenuItem` 35, `prependBlockInPage` 30, `Assets.listFilesOfCurrentGraph` 29, `Assets.makeUrl` 26, `DB.onBlockChanged` 25, `getPreviousSiblingBlock` 25, `App.onPageHeadActionsSlotted` 22, `App.queryElementById` 12, `App.onBlockRendererSlotted` 9, `FileStorage.getItem` 7, `provideTheme` 7.

**The ~20 that matter for nooklet's client plugin API**: `getBlock`, `getPage`, `getCurrentBlock`, `getCurrentPage`, `getPageBlocksTree`, `getAllPages`, `insertBlock`, `insertBatchBlock`, `updateBlock`, `removeBlock`, `appendBlockInPage`, `createPage`, `upsertBlockProperty`/`getBlockProperties`, `insertAtEditingCursor`, `registerSlashCommand`, `registerBlockContextMenuItem`, `App.registerCommandPalette`, `App.registerUIItem`, `App.getUserConfigs`, `DB.datascriptQuery`/`DB.q` (replace with a SQL/JSON query API), `DB.onChanged`, `UI.showMsg`, `useSettingsSchema`/`onSettingsChanged`, `provideUI`/`provideStyle`/`provideModel`, `showMainUI`/`hideMainUI`, `App.onMacroRendererSlotted`, `App.pushState`/`onRouteChanged`.

### 5.4 What plugin authors actually build (marketplace `popular.json`, downloads)

journals-calendar 162k, bullet-threading 154k, tabs 144k, todo list 121k, mark-map 86k, tags (tag browser) 78k, markdown-table editor 73k, gpt3-openai 65k, pdf-export 65k, heatmap 59k, agenda 50k, link-preview 42k, block-to-page 41k, kanban 39k, awesome-ui 38k, todo-master 38k, vim-shortcuts 33k, awesome-styler 31k, automatic-linker 31k, graph-analysis 30k, awesome-links 30k, anki-sync 29k, git 28k, banners 24k, move-block 24k, calendars 24k, readwise 19k, emoji-picker 19k, random-note 19k, wordcount 18k, focus-mode 18k, copy-code 18k, helium 16k, diagrams-as-code 15k, smartblocks 14k, toc 13k, habit-tracker 12k, heading-shortcuts 12k, paste-more 12k, pomodoro 12k.

Pattern: (a) *CSS/UX tweaks* (awesome-*, banners, focus-mode, tabs) that need only `provideStyle` + DOM access; (b) *task/journal dashboards* (todo, agenda, kanban, calendar, heatmap) that need Datalog/DSL queries over markers/scheduled/properties + `onChanged`; (c) *importers/sync* (readwise, anki, git, gpt) that need page/block CRUD with `insertBatchBlock`, `createPage`, property upsert; (d) *editing helpers* (automatic-linker, block-to-page, move-block, markdown-table, paste-more, smartblocks) that need editing-cursor APIs, slash commands and context menus; (e) *renderers* (mark-map, diagrams, link-preview) that need `onMacroRendererSlotted` / fenced-code renderers.

Implication for nooklet: a server-side plugin API that exposes query + CRUD + change events covers (b) and (c); a client API with `registerSlashCommand`, `registerBlockContextMenuItem`, `provideUI/provideStyle`, a code-fence/macro renderer hook and cursor insert covers (a), (d), (e). Sandboxing via iframe + postMessage is the right call; DOMPurify for injected HTML.

---

## 6. Why people leave Logseq (and what to avoid)

Collected from HN, the Logseq forum, App Store reviews, GitHub issues #10999/#378/#3872/#5128/#11251, and third-party comparisons:

1. **Sync** — file-sync (OG) is either DIY (git/Syncthing/iCloud, with conflict files and "jumbled hierarchy" merges) or the paid beta that "overwrites what I typed while it syncs" and takes 0–20 s before the mobile app is usable. DB sync is better engineered but paid, invite-only, and needs a Logseq account. *Avoid*: any design where local typing waits on the network; require idempotent, op-based merging and show sync state without blocking.
2. **Mobile** — a wrapped desktop UI; keyboard/toolbar bugs; no plugins on mobile; huge journals slow. *Avoid*: per-block textarea churn, layout that ignores `visualViewport`, features that assume a hardware keyboard.
3. **Performance on large graphs** — OG loads the entire graph into memory and re-parses files; 10k+ blocks got sluggish; the DB rewrite fixed it with a worker and render deltas. *Avoid*: loading everything into the client; page-window queries only.
4. **File format churn and lock-in fear** — three file-name encodings, block `id::` lines "polluting" files, then the DB move that made files export-only. *Avoid*: changing the on-disk contract; keep files canonical, identifiers minimal, and document the format.
5. **Beta forever / dual-codebase stall** — the community felt abandoned for ~2 years. *Avoid*: shipping a "v1" that receives no fixes.
6. **Plugin breakage** — the DB move invalidated most of the 600 plugins (only ~65 updated). *Avoid*: versioned, small, stable plugin API from day one.
7. **Smaller irritants**: `TODO`/`A` pages, property keys becoming pages, unlinked references being slow, no simple way to read the DB with SQL, whiteboards/features dropped, Electron memory use.

---

## 7. Worth stealing

- **Search**: OG electron uses SQLite FTS5 (`blocks_fts(uuid, content, page)`, `pages_fts`) with triggers on `blocks`/`pages` tables; query = FTS `MATCH` (with `and/or/not` → `AND/OR/NOT`, plus a quoted-phrase variant) ordered by rank, then a `LIKE '%q%'` fallback merged and de-duplicated (`og/src/electron/electron/search.cljs`). Browser build uses fuse.js. Page-title search uses a small fuzzy scorer (`og/src/main/frontend/search.cljs` `score`: consecutive-char multiplier, position penalty, exact-substring bonus, length-distance tiebreak) — cheap and good; copy it. DB version adds an embedding index (all-MiniLM-L6-v2, 384 dims, one vector per block, max 10 candidates with score > 0.5, keyword hits ranked first, `PRAGMA user_version` for rebuilds) — same shape nooklet wants with Ollama.
- **Embeds**: `{{embed [[Page]]}}` renders the page's block tree inline and editable; `{{embed ((uuid))}}` renders a block with children; embedded blocks are editable in place (edit-input-id includes the container id). Block refs `((uuid))` render the target's first line inline with a hover preview and a ref-count badge; clicking a ref count opens the referencing blocks.
- **Journals**: today's page auto-created on open/at midnight, journal list = infinite scroll of recent journals (`get-latest-journals`, 50 + 25 per page), `:default-templates {:journals "name"}` applied to new journals, `:default-queries` (scheduled/deadlines next 7 days, and "NOW/DOING" tasks) rendered under today's journal, `Cmd+Shift+J` go to today, `g n`/`g p` next/previous day, `[[Today]]`/`[[Tomorrow]]` NLP dates in the DB version. "Scheduled and deadlines" panel on each journal page = query on `:block/scheduled`/`:block/deadline` ≤ day+N excluding DONE/CANCELED.
- **All pages**: table of `name`, backlinks count, created/updated (from block timestamps or file mtime), journal filter, orphan filter, bulk delete; "Recent" and "Favorites" lists in the left sidebar (favorites stored in `config.edn :favorites`).
- **Tasks**: `Cmd+Enter` cycles markers per `:preferred-workflow` (`TODO→DOING→DONE` or `LATER→NOW→DONE`), `[#A]` priority, `SCHEDULED`/`DEADLINE` date picker with repeaters, `/deadline`, `/scheduled`, `:LOGBOOK:` clocking when DOING. Minimal viable set for nooklet: markers `TODO/DOING/DONE/LATER/NOW/CANCELED`, priority A/B/C, scheduled/deadline as `yyyyMMdd` + optional time, repeaters as opaque text.
- **Contents page** (`pages/contents.md`) as a user-managed sidebar outline; **Templates** (`template:: name` on a block, `/template` inserts a copy, `template-including-parent::`); **Quick capture** with `{time} {text} {url}` templates into today's journal (mobile share sheet); `t o` (toggle open blocks), `t w` (wide mode), `t t` (theme), `g a` (all pages); zoom-in on a block with breadcrumb; right sidebar that can hold pages/blocks; block "hierarchy" section for namespaces.
- **Import repairs** and **fuzz-tested importer** (generated random graphs with broken ids/refs; see `docs/og_import_graph_cases.md`).

---

## 8. Concrete recommendations for nooklet

**Storage & model**
- SQLite is canonical; Markdown files are a *bidirectional projection* written from the DB (Logseq OG did this too — Datascript in memory, files on disk — and it worked; the DB version's mistake was dropping the projection). Store per-block rows (queryable with plain SQL, unlike Logseq's `kvs`), a `refs` table, FTS5 on `content`, and an embeddings table.
- Block: `id (uuid), page_id, parent_id, ord (fractional index), content, props (ordered), collapsed, marker, priority, scheduled, deadline, created_at, updated_at`. Page: `id, name (lowercase NFC, unique), title, journal_day, namespace_parent, alias, tags, file_path`. Derive `path_refs` (recursive CTE or maintained table). Never store "TODO"/"A" as pages; never auto-create property-key pages.
- Ordering: fractional index strings (what Logseq DB adopted after `:block/left` caused endless "duplicate left" corruption assertions in OG's `sort-by-left`). Moves = one row update; sync-friendly.

**File format**
- Read: everything in section 2.4 (tabs or spaces, `key::`, `id::`, `collapsed::`, markers, `[#A]`, `SCHEDULED:`, `[[ ]]`, `#`, `#[[ ]]`, `(( ))`, `{{embed}}`, `title::`/`alias::`/`tags::` pre-block, triple-lowbar and legacy file names, journals `yyyy_MM_dd`, `config.edn` keys listed in 2.2, `logseq/`, `assets/`). Repair duplicate ids, dangling block refs, and file-style journal refs.
- Write: Logseq's exact writer output (tab indent by default, two-space continuation, `id::` only when referenced, `collapsed:: true` only when collapsed, pre-block + blank line, whole-file rewrite, atomic write, backup on external divergence). This keeps graphs openable in Logseq OG and Obsidian.
- Namespace pages: keep `A/B/C` as the page title; write `A___B___C.md`; derive the hierarchy from the title (don't store extra pages unless referenced).

**Sync**
- Op-log with server-ordered `t`, per-client pending ops replayed semantically (insert/save/move/delete/create-page), idempotent page creation by name, tolerate vanished targets, checksums for drift detection, never block the editor. Logseq's ADRs 0004/0006/0010/0015 are a good blueprint; their stress harness (3 clients × 10k ops, offline windows) is the bar.

**Editor**
- Keep Logseq's keyboard semantics (Enter split / sibling-vs-first-child rule, empty-last-child outdent, Backspace merge, Tab/Shift+Tab with direct outdenting, Alt+Up/Down, Esc→select, `[[`/`((`/`#`/`/` popups with autopair). Do not port the per-block `<textarea>` swap to mobile.

**API / plugins**
- Mirror Logseq's REST shape (`pages`, `blocks`, `block-trees`, `block-moves`, `properties`, `capture`, `search`, `references`) with one implementation shared by HTTP and MCP; JSON block entities with the same field names plugins already know (`uuid, content, page, parent, children, properties, marker, scheduled, deadline, refs`).
- Client plugin API: iframe sandbox + postMessage; the ~20 methods in 5.3 cover >90% of published plugins.

**Product**
- Ship files + DB + sync + mobile together; don't fork the product; don't stay in beta; document the file format as a stable contract.
