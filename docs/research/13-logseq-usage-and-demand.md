# 13 — Logseq: what is actually used, what is asked for, and what nooklet should build next

Dated record, 2026-09-12. Like the other files in `docs/research/`, this is kept as written rather
than updated in place. It answers two questions the owner asked — *which Logseq features are most
used* and *which are requested but not implemented* — and maps both onto nooklet's current state.

**Method note, stated up front.** Logseq publishes no telemetry, so every "most used" figure below
is a proxy, and each proxy is named. The session's web-search budget was exhausted before this
task began, so everything here comes from primary endpoints that can be re-fetched without a
search engine: the forum's Discourse JSON API, GitHub's search API via `gh`, the marketplace's own
`stats.json`, HN's Algolia API, the `logseq/docs` and `logseq/og` repositories, and direct reads
of the threads cited. Reddit (`r/logseq`) refused every fetch (HTTP 403 for `www`, `old` and
`api` hosts, with and without a browser user agent), so that proxy is missing — see §6.

Where a number is *counted* here (bucket tallies, keymap sizes) the command is given so it can be
re-run; where a number is *reported* by a source (votes, downloads) the URL is given.

---

## 0. The short version

**What Logseq users lean on daily** (proxies in §2): the journal as the capture surface; the
outliner itself (indent, collapse, zoom-into-block); `[[refs]]`/`#tags` with linked references;
tasks with `Cmd+Enter` cycling; search; and *some* form of sync that most of them fight with.
One tier down, used by a large minority and the source of most help requests: properties and
`tags::`, queries, scheduled/deadline, block refs and embeds, templates, namespaces, aliases,
the right sidebar, and PDF annotation (a distinct academic segment).

**What is asked for and not delivered** (§3): after five years the top-voted requests, all still
open on the forum, are epub reading (285 votes), custom TODO keywords (263, later answered in the
DB version by a status property), longform writing (248), Vim (221), PDF
annotation on mobile (200), plugins on mobile (147), body-text filters for references (140),
cloud-drive sync on iOS (130), a page outline for the sidebar (121), and a namespace redesign
(114). GitHub's most-👍 open issue is XDG config paths (79). But the loud 2025–2026 demand is
not a feature at all — it is *markdown as the source of truth plus reliable sync*, which the
DB version dropped and the OG version cannot do.

**Ranked shortlist for nooklet** (§4.2, reasoning there):

1. Ship the ```` ```query ```` fence already specified in ADR 011 — queries are the forum's single
   largest help topic and the three biggest task plugins (≈350k downloads) all exist to answer
   "show me blocks matching X".
2. Templates: a journal template plus `/template` insert, as a built-in plugin.
3. Block↔page refactors: *turn block into page*, *move block to page…*, *merge pages*.
4. Find and replace across the graph.
5. Linked-references filters (include/exclude by page or tag) and a sort toggle.
6. Appearance basics: font size, content width, a custom-CSS box.
7. A page outline (headings) card in the shelf.
8. Trash/restore and a page-history viewer over the op log that already holds both.
9. Wire a syntax highlighter into the fence seam and load KaTeX for math (both are seams today,
   and `PLAN.md` claims the first as shipped).
10. Orphan-asset GC and a "link all unlinked references" button.

**Stays out** (§4.3): whiteboards, flashcards, kanban, PDF annotation, epub, longform/document
mode, Vim, custom TODO keywords, Datalog queries, E2EE, real-time collaboration, org-mode,
publishing. Each has a reason and, where possible, a plugin-shaped escape hatch.

**Four findings worth two minutes:**

- The two most-downloaded plugins in Logseq's history are cosmetic — a journal calendar
  (270k) and *bullet threading*, i.e. indent guides (238k). nooklet ships both built in.
- Logseq's community is quiet: new forum feature requests went 628 (2022) → 177 (2024) →
  43 (2025) → 20 (2026 to date); GitHub issues filed went 2,701 (2022) → 586 (2024) → 195
  (2026 to date). The demand data is mostly 2021–2023 vintage. Where the people went is
  unverified (§6).
- Logseq's own November 2025 roadmap lists, as future work, things nooklet already has:
  self-hosted sync, two-way markdown sync ("still researching"), repeated tasks, done
  timestamps, page history, a recycle bin, MCP and a CLI, and "agents with Logseq graphs as
  memory".
- The 2026 exodus threads are not about missing features. They are about losing plain files
  ("Transparent native markdown was maybe my top ranking feature"), trust ("perpetual beta",
  sync paid-for and still beta after four years, an EOL Electron), and data loss during sync.

---

## 1. Sources and how the counts were made

| Proxy | Endpoint / file | Fetched |
|---|---|---|
| Forum categories and sizes | `https://discuss.logseq.com/categories.json?include_subcategories=true`, `/site.json` | 2026-09-12 |
| Feature requests, all 1,806, by votes | `https://discuss.logseq.com/c/feedback/feature-requests/7.json?order=votes&page=N`, N = 0…60 | 2026-09-12 |
| Q&A threads, top 300 by views | `https://discuss.logseq.com/c/questions-and-help/8/l/top.json?period=all&page=N`, N = 0…5 | 2026-09-12 |
| Forum tags | `https://discuss.logseq.com/tags.json`; `/tag/<name>.json?order=votes` | 2026-09-12 |
| GitHub issues by 👍 | `gh api search/issues -f q='repo:logseq/logseq is:issue …' -f sort=reactions-+1` | 2026-09-12 |
| Open issues per label | same, one query per label | 2026-09-12 |
| Marketplace downloads | `https://raw.githubusercontent.com/logseq/marketplace/master/stats.json` (per-release GitHub asset download counts, 641 packages) and `popular.json` (`generatedAt` 2026-01-02) | 2026-09-12 |
| HN threads | `https://hn.algolia.com/api/v1/{search,items}` | 2026-09-12 |
| Docs and defaults | `logseq/docs` `pages/*.md`, `db-version.md`, `db-version-changes.md`; `logseq/og` `src/resources/templates/config.edn` (branch `version/file`) and `src/main/frontend/modules/shortcut/config.cljs` | 2026-09-12 |

Caveats that apply throughout:

- **Discourse votes** come from the voting plugin, which limits how many *active* votes each user
  holds, so counts saturate and old threads accumulate. Treat ≥100 as "a real constituency", not
  as a ranking between 140 and 130. The exact per-user cap on this forum is unverified.
- **Marketplace downloads** are cumulative GitHub *release-asset* downloads summed over every
  release, so a plugin updated 40 times counts every update. `popular.json`'s `merged` list is the
  marketplace's own figure and is ~40 % lower for the same plugins; both orderings agree on the
  top ten. Themes are included in `stats.json` and are a large share.
- **GitHub 👍** on `logseq/logseq` mostly predates the April 2026 split; the repository is now the
  DB product and file-graph issues moved to `logseq/og` (34 issues, 289 stars).
- **Bucket tallies** are regex matches on titles (script in §3.2). They over-count broad words
  and under-count anything phrased unusually; they are for ordering areas, not for exact sizes.

---

## 2. Part 1 — What Logseq users actually use

### 2.1 What Logseq itself emphasises

**The official onboarding** (`Start here`, `Getting started with the Journals page` in
[logseq/docs](https://github.com/logseq/docs/tree/master/pages)) is journal-first and task-second:
*"proficient Logseq users write 99% of the time on their journals page"*; *"Two common ways to get
started with Logseq are note-taking and task management"*; tasks are taught as `TODO` + a date link
+ `/date picker`, with queries as the way to *"resurface tasks"* once they accumulate. The
`Search` page documents `Cmd+K` with `/` filters (pages, blocks, files, commands), search-in-page
(`Cmd+Shift+K`), and accent-insensitive matching by default — the same decision nooklet made for
Czech.

**The default `config.edn`** (`logseq/og`, branch `version/file`,
`src/resources/templates/config.edn`) ships with `:preferred-workflow :now`, `:default-templates`
for journals, `:favorites []`, and — the tell — `:default-queries` that render two blocks under
every journal page: *"🔨 NOW"* (NOW/DOING tasks from the last 14 days, sorted by priority) and
*"📅 NEXT"* (scheduled/deadline items in the coming days). Journals, tasks, and scheduling are the
three features the vendor decided every user sees on day one. Journals, flashcards and whiteboards
each have an `enable` flag; only journals default on.

**The default keymap** (`src/main/frontend/modules/shortcut/config.cljs`, 1,128 lines) has ~175
bound commands: `:editor/*` 70, `:whiteboard/*` 29, `:go/*` 19, `:ui/*` 16, `:cards/*` 9,
`:dev/*` 9, `:auto-complete/*` 5, `:pdf/*` 4, `:sidebar/*` 3, plus singletons. Counted with
`grep -oE '^\s*:[a-z-]+/[a-z0-9-]+\s+\{:binding' config.cljs | sed -E 's/\/.*//' | sort | uniq -c`.
What that says: the editor is the product; navigation is `g j` journals, `g a` all pages, `g n`/
`g p` next/previous journal, `g t` tomorrow, `g g` graph, `g f` flashcards, `g w` whiteboards;
UI toggles are `t t` theme, `t w` wide mode, `t d` document mode, `t r`/`t l` sidebars, `t o`
open all blocks, `t b` brackets, `t n` numbered list; and `Cmd+Enter` cycles TODO,
`Cmd+Shift+F` favourites, `Cmd+Shift+A` selects all blocks, `Cmd+J` jumps, `Cmd+K` searches,
`Cmd+Shift+P` opens the palette. Whiteboards got 29 shortcuts and were still removed in the DB
version — a keymap measures vendor investment, not use.

### 2.2 Where the help requests go

The forum has 2,801 Questions & Help topics (10,847 posts). Its **Queries** subcategory alone
holds 458 topics and 2,761 posts — more posts than Bug Reports (1,374) and Look-what-I-built
(1,758) combined. Feature Requests has 1,805 topics / 7,251 posts.
([categories.json](https://discuss.logseq.com/categories.json))

Tag counts ([tags.json](https://discuss.logseq.com/tags.json)): `howto` 628, `queries` 405,
`plugins-development` 166, `pdf` 119, `sync` 73, `db-version` 62, `done` 58, `css` 44,
`whiteboard` 35, `android` 29, `mobile` 27, `reference` 19, `graph` 19, `journal` 15,
`search` 10, `git` 10, `quick-capture` 5.

The 300 highest-ranked Q&A threads (Discourse's all-time "top" ordering, a composite of likes,
replies and views), bucketed by title and summed by views (script as in §3.2):

| Area | threads | total views |
|---|---:|---:|
| Properties, tags, structure | 45 | 271,662 |
| References, links, embeds | 33 | 203,351 |
| Queries | 47 | 175,085 |
| Sync, backup, git | 23 | 140,763 |
| Tasks, scheduling | 30 | 120,962 |
| DB version | 12 | 104,166 |
| Templates, macros | 10 | 76,036 |
| Journal | 21 | 75,469 |
| Sidebar, UI, CSS | 9 | 47,163 |
| Export, publish, import | 7 | 46,381 |
| Mobile | 6 | 41,032 |
| PDF, Zotero | 7 | 33,481 |
| Longform / writing | 5 | 32,547 |
| Search | 3 | 16,892 |
| Flashcards, whiteboard | 0 | 0 |

The most-viewed `howto` threads
([tag/howto?order=views](https://discuss.logseq.com/tag/howto?order=views)): *Queries for task
management* 43,478 views / 144 posts; *How to sync your Logseq graph across devices* 31,416;
*How to publish your Logseq as selfhosted site* 20,953; *The Most Legit Use of Namespaces* 16,723;
*Change text color for individual blocks* 16,330; *How to create aliases and external links*
14,652; *How to create a checklist without TODO status* 11,313; *How to work with the right-hand
sidebar* 11,261; *Using all of page width* 9,861; *How to sync with OneDrive on Android* 8,874.
The most-liked Q&A thread overall is *Different ways to structure data* (254 likes, 90 posts,
37k views), whose author states *"90% of the structure of my graph is properties, 10%
hierarchies"* ([t/8819](https://discuss.logseq.com/t/different-ways-to-structure-data/8819)).

Reading: people do not ask how to write a bullet or link a page. They ask how to *structure*
(properties vs tags vs namespaces), how to *retrieve* (queries), and how to *sync*. Those are the
features that are both heavily used and hard.

### 2.3 What people bolt on: the marketplace

641 packages, 4.51 M cumulative release-asset downloads
([stats.json](https://raw.githubusercontent.com/logseq/marketplace/master/stats.json), summed
with `jq 'to_entries|map({id:.key,dl:([.value.releases[]?[2]]|add)})'`). Top 40:

| # | plugin | downloads | what it says people want |
|--:|---|---:|---|
| 1 | journals-calendar | 269,582 | a calendar over the journal |
| 2 | bullet-threading | 237,946 | indent guides for the outline |
| 3 | tabs | 211,249 | multiple pages open at once |
| 4 | todo-plugin | 204,672 | a task dashboard |
| 5 | bonofix-theme | 163,666 | theming |
| 6 | mark-map | 126,558 | mind-map render of a page |
| 7 | tags | 124,850 | a tag browser |
| 8 | markdown-table | 118,367 | a table editor |
| 9 | pdf-export | 106,695 | export a page to PDF |
| 10 | dev-theme | 95,760 | theming |
| 11 | gpt3-openai | 84,893 | AI in the editor (2022-era) |
| 12 | agenda | 82,818 | tasks on a calendar/timeline |
| 13 | heatmap | 80,406 | journaling streaks |
| 14 | catppuccin | 73,925 | theming |
| 15 | awesome-ui | 71,753 | UI polish |
| 16 | link-preview | 60,107 | hover previews of links |
| 17 | kanban | 59,129 | board view of tasks |
| 18 | atlas-theme | 53,982 | theming |
| 19 | block-to-page | 53,440 | refactor a block into a page |
| 20 | awesome-styler | 51,390 | UI polish |
| 21 | todo-master | 50,938 | task dashboard |
| 22 | git | 49,524 | commit the graph |
| 23 | vim-shortcuts | 49,114 | Vim keys |
| 24 | automatic-linker | 48,888 | auto-link unlinked mentions |
| 25 | graph-analysis | 45,389 | graph metrics |
| 26 | awesome-links | 43,652 | link styling |
| 27 | anki-sync | 40,080 | flashcards, done elsewhere |
| 28 | banners | 36,445 | page banners |
| 29 | calendars | 34,640 | calendar |
| 30 | tocgen | 34,597 | table of contents |
| 31 | bujo-theme | 33,951 | theming |
| 32 | move-block | 32,197 | move a block to another page |
| 33 | copy-code | 32,162 | copy button on fences |
| 34 | emoji-picker | 30,998 | emoji |
| 35 | mermaid | 27,641 | diagrams |
| 36 | block-calendar | 27,429 | calendar |
| 37 | wrap | 27,045 | text wrapping helpers |
| 38 | laurel-theme | 26,996 | theming |
| 39 | toc-plugin | 25,545 | table of contents |
| 40 | omnivore | 24,306 | read-later import |

Grouped: **task/journal dashboards** (todo, agenda, kanban, heatmap, calendars, block-calendar,
todo-master, habit tracker: ≈550k, before the 270k journal calendar), **cosmetic** (six themes
≈450k + three awesome-* restylers ≈170k + bullet-threading 238k + banners 36k: ≈900k),
**navigation** (tabs, tags browser, toc ×2, link-preview: ≈460k), **editing helpers**
(markdown-table, block-to-page, move-block, automatic-linker, copy-code, emoji, paste-more:
≈330k), **renderers** (markmap, mermaid, diagrams-as-code, excalidraw: ≈200k), **integrations**
(git, anki, readwise, omnivore: ≈140k), **AI** (gpt3-openai 85k, filed 2022).

### 2.4 Heavy-user write-ups

- *Three Choices New Users Need to Make* (Luhmann, 2021, 110 likes,
  [t/3411](https://discuss.logseq.com/t/three-choices-new-users-need-to-make/3411)): the choices
  are (1) journal-first or page-first, (2) tags vs hierarchy (`[[a/b]]`) vs page-`tags::`, (3)
  one graph or several. His recommendation: one graph, journal-first, hierarchy expressed in
  page-tags. That the second choice needs a guide at all is the namespace/tag confusion that
  recurs in §3.
- *This chart shows what makes Logseq unique* (Luhmann, 2024,
  [t/30547](https://discuss.logseq.com/t/this-chart-shows-what-makes-logseq-unique/30547)): four
  things — click-to-zoom outlining (*"I can't live without"*), built-in tasks with status,
  deadlines and repeats, *true aliases* (multilingual use), and markdown. A reply (hmijail) calls
  Logseq's markdown *"dirty"* and says it needs cleanup scripts.
- *1,350 Days with Logseq* (ianreppel.org, 2026,
  [link](https://ianreppel.org/goodbye-logseq/)): used daily journals, block-level links (only
  ~25 notes had them), Readwise sync, Datalog queries; never wrote longform in it. Left for
  Obsidian solely because *"SQLite over plain Markdown ruined it"*, adding *"I did not want to
  leave Logseq."*
- *Logseq for notetaking: what's good, what's not* (michelenasti.com, 2023,
  [link](https://michelenasti.com/exploring-logseq-for-notetaking/)): daily journal, `[[links]]`,
  bullets — and *"keeping track of these TODOs is complicated because they're scattered all over
  the pages"*.
- *Logseq from an Org-mode point of view* (karl-voit.at, 2024,
  [link](https://karl-voit.at/2024/01/28/logseq-from-org-pov/)): praises automatic backlinks,
  embeds, queries, block-level metadata; criticises *"There is no search and replace at all!"*,
  tables without formulas, no level-wise fold. Withdrew his endorsement after the DB announcement
  dropped org syntax.
- *HN, Oct 2022* (118 comments, [33218561](https://news.ycombinator.com/item?id=33218561)):
  loved — journals as a time-indexed research log, *"turn this block into its own page"*, tags,
  PDF annotation (*"killer feature"*, easygenes), queries. Complained — slowness past *"a few
  million words"*, data loss, non-standard markdown (*"adds 2 spaces"*), bullets forced on prose,
  sync at $15/mo in closed alpha, thin docs for advanced queries, epub.
- The owner's own graph (`PLAN.md` §2): 840 journal files, ~700 task blocks, 2,200 link lines,
  700 numbered-list lines, 300 images, block refs and embeds rare, namespaces barely used.

### 2.5 Ranked estimate

| Tier | Feature | Evidence it is used |
|---|---|---|
| **A — daily for most** | Journals as capture surface | docs "99 % on journals"; default queries live there; #1 plugin is a journal calendar; every write-up above; owner's 840 journal files |
| A | Outliner editing: indent/outdent, collapse, zoom into block | 70 `:editor/*` shortcuts; "click to zoom … can't live without"; bullet-threading 238k |
| A | `[[page refs]]`, `#tags`, linked references | 2nd-largest Q&A area (203k views); "The difference between [[page links]], #tags, and properties" 42k views |
| A | Tasks: TODO/DONE cycling, priorities | ~700 task blocks in the owner's graph; todo plugins 205k + 51k; NOW/NEXT default queries; "Queries for task management" is the most-viewed how-to |
| A | Search (`Cmd+K`) | "PLEASE fix the search" 142 votes (closed done); Obsidian's better search is a stated reason to leave |
| A | Sync of some kind | 31k-view how-to; 141k views of sync Q&A; the dominant 2025–26 complaint |
| **B — common** | Properties (`key:: value`, `tags::`) | largest Q&A area (272k views); "90 % of my structure is properties"; Lesson 5 on properties 57k views |
| B | Queries (simple and advanced) | 458-topic subcategory, 405 tagged threads, 43k-view how-to; three task-dashboard plugins exist because the built-in query UI is hard |
| B | Scheduled / deadline, date picker | default NEXT query; docs teach `/date picker` first; repeater requests 54 votes |
| B | Block refs `(( ))` and embeds | 60 API hits `getPageLinkedReferences`; "must-have" in the move-to-Obsidian thread; rare in the owner's graph |
| B | Templates | "Templates - how to create" 44k views; `:default-templates` in config; DB roadmap "text template revival" |
| B | Namespaces / hierarchy | 114-vote redesign request; 16.7k-view how-to; "Three choices" needs a whole section for it |
| B | Aliases | listed as one of four unique features; 15k-view how-to; alias bugs are the #2 open GitHub issue (50 👍) |
| B | Right sidebar (shift-click) | 11k-view how-to; `Shift+Enter` and `Cmd+Shift+O` bound; tabs plugin 211k |
| B | Favourites, recent pages | `Cmd+Shift+F`; `:favorites` in config |
| B | PDF annotation | 119 `pdf` topics, 33 open issues, 200-vote mobile request; academic segment; HN "killer feature" |
| B | Images and assets | 300 image lines in the owner's graph; 143 asset-related requests (896 votes) |
| B | Code blocks, tables | markdown-table plugin 118k; copy-code 32k; "Table creation interface" 58 votes |
| B | Themes / custom CSS | five themes in the top 40 (≈470k); 44 `css` topics; "text color" how-to 16k views |
| B | Calendar view of journals/tasks | journals-calendar 270k, agenda 83k, calendars 35k, block-calendar 27k |
| **C — niche** | Whiteboards | 35 tagged topics; 29 shortcuts; removed in DB with little protest in the exodus threads |
| C | Flashcards / SRS | 51 requests (214 votes); SRS bugs open since 2022; anki-sync 40k suggests people export instead |
| C | Graph view | 94 requests (658 votes) but nearly all are "hide X in the graph"; `g g` bound |
| C | Kanban | one 100-vote request; plugin 59k |
| C | Vim | 221 votes; plugin 49k |
| C | Org-mode | dropped in DB; a vocal Emacs minority |
| C | Publishing, git auto-commit, Zotero, slides, Excalidraw | each has a how-to or plugin; each was cut or plugin-ised in DB |

---

## 3. Part 2 — Requested but not implemented (or implemented badly)

### 3.1 Forum feature requests by votes

Top 40 of 1,806 ([feature-requests?order=votes](https://discuss.logseq.com/c/feedback/feature-requests/7?order=votes)).
"Status" is the forum's own tag (`done`, `done-with-db-version`, `on-roadmap`) where present.

| votes | opened | last post | topic | status |
|---:|---|---|---|---|
| 285 | 2021-08 | 2026-06 | Support epub format ebooks | open |
| 263 | 2021-03 | 2024-08 | Add support for customisable TODO keywords | done-with-db (status property) |
| 248 | 2021-11 | 2025-09 | Longform writing in Logseq | on-roadmap |
| 221 | 2021-02 | 2024-08 | Vim-mode Powerful Shortcuts | open |
| 200 | 2022-01 | 2024-10 | PDF annotation on mobile devices | open |
| 147 | 2022-08 | 2025-11 | Plugin Support for iOS & Android Apps | open |
| 142 | 2021-10 | 2024-07 | PLEASE fix the search | closed, done |
| 140 | 2021-06 | 2024-09 | Filters for note body, not just backlinks | open |
| 130 | 2022-01 | 2026-03 | Sync on iOS with OneDrive, Dropbox, Google Drive, iCloud | open |
| 121 | 2021-04 | 2024-08 | Outline Overview for sidebar | open |
| 114 | 2021-12 | 2024-03 | Proposal: Changing How Namespaces Function | open (DB changed them) |
| 110 | 2021-06 | 2025-02 | Pandoc plugin for exporting & Export to PDF | open |
| 109 | 2022-02 | 2026-04 | Hide aliases circles in Graph View | open |
| 104 | 2021-03 | 2025-11 | Mermaid diagram render support | done (plugin) |
| 104 | 2021-10 | 2025-03 | Basic UI Settings e.g. Font Size | open |
| 100 | 2021-06 | 2023-12 | Introduce Kanban boards as a new primitive | open (DB views planned) |
| 85 | 2022-04 | 2026-08 | Task notifications | open |
| 84 | 2021-02 | 2022-11 | Outlines Collapsed by Default | open |
| 83 | 2021-02 | 2026-04 | Tabbed windows / multiple instances | partial |
| 83 | 2020-12 | 2023-03 | Search operators / filters for the search box | open |
| 82 | 2021-08 | 2025-03 | Auto delete empty journal | open |
| 78 | 2022-09 | 2024-05 | Sort linked references | open |
| 78 | 2021-04 | 2025-03 | Google Calendar Sync | open |
| 78 | 2021-08 | 2024-09 | Search inside PDF / in page with Ctrl+F | done |
| 77 | 2022-04 | 2025-12 | View and delete orphan assets | open |
| 73 | 2021-09 | 2025-09 | Option to disable auto-close parenthesis | open |
| 73 | 2021-11 | 2023-09 | Customized Zotero import fields | open |
| 70 | 2022-01 | 2025-01 | Portable Windows installer | open |
| 69 | 2022-02 | 2025-11 | Lock a page as read-only | open |
| 67 | 2021-07 | 2026-01 | Find and replace across occurrences | open (DB promised) |
| 67 | 2021-11 | 2025-12 | Folders and subfolders | open |
| 61 | 2022-04 | 2026-02 | Local (on-server) storage for self-hosted Logseq | open |
| 61 | 2022-03 | 2024-05 | Export PDF with highlights | open |
| 58 | 2021-08 | 2026-05 | Table creation interface (not query table) | open |
| 58 | 2023-02 | 2025-09 | Progressive Web App with full features | open |
| 58 | 2021-03 | 2024-02 | Merge pages into one page | open |
| 56 | 2021-12 | 2024-04 | Show block references on the graph view | open |
| 56 | 2021-01 | 2023-11 | Collapse namespace prefixes | open |
| 54 | 2021-06 | 2025-09 | Additional repeater options | open |
| 52 | 2021-02 | 2023-11 | Readwise integration | done (plugin) |

Further down but relevant to nooklet: *Moving a block to another page / converting it to a page*
52; *Block Timestamps* 46 (done-with-db); *Add a done date to done tasks that is query-able* 42
(done-with-db); *Block reference by name not UUID* 40 (done-with-db); *Automatically link
Unlinked References* 40 (plugin); *Hide namespace parents* 39 (done-with-db); *NOW / NEXT / LATER
workflow* 36 (done-with-db); *Password protection for journal* 27; *Native Quick Capture /
Clipper* 26; *Phone widget for quick capture* 26; *Copy and paste rich text* 29; *Cursor placement
within a template* 36; *Add :pages to :default-queries* 28; *Multi-cursor* 28.

Distribution: 16 topics have ≥100 votes, 46 have ≥50, 149 have ≥20, 326 have ≥10, and 305 have
none. Total 13,805 votes. **Creation by year: 2020: 14, 2021: 473, 2022: 628, 2023: 451,
2024: 177, 2025: 43, 2026: 20** (to 2026-09-12).

### 3.2 Demand by area, all 1,806 requests

Paging the category by votes returned 1,806 rows against the category's stated 1,805 topics —
presumably one pinned topic listed twice; rows were not deduplicated. Titles bucketed by regex
(a title can land in several buckets):

```
python3 - <<'EOF'   # over fr-all.tsv: votes, posts, views, created, last, id, title
buckets = {'editor/formatting/markdown': r'editor|format|markdown|wysiwyg|heading|bold|italic|paste|copy|cursor|indent|outdent|bullet|numbered|\blists?\b|vim|keyboard|shortcut|hotkey|autocomplete|auto-?pair|spell|multi.?cursor|find and replace|undo',
  'refs/embeds/links': r'block ref|reference|embed|\blinks?\b|backlink|transclu|linked|unlinked|alias',
  'ui/layout/sidebar/tabs': r'sidebar|\btabs?\b|window|pane|font|\bui\b|layout|width|zoom|dark mode|theme|toolbar|collapse|fold|icon|breadcrumb|wide mode',
  'pdf/epub/annotation': r'\bpdf|epub|annotat|highlight',
  'tasks/scheduling/calendar': r'\btasks?\b|todo|\bdone\b|deadline|schedul|repeat|recurr|reminder|notification|priorit|logbook|habit|pomodoro|calendar|agenda|checklist|checkbox',
  # … remaining buckets as listed in the table
}
EOF
```

| Area | topics | votes | top request |
|---|---:|---:|---|
| Editor, formatting, markdown | 287 | 2,132 | epub 285, Vim 221 |
| Refs, embeds, links, aliases | 254 | 1,902 | body-text filters 140, hide alias nodes 109, sort refs 78 |
| UI, layout, sidebar, tabs | 192 | 1,473 | outline in sidebar 121, font size 104, collapsed by default 84 |
| PDF, epub, annotation | 124 | 1,355 | epub 285, PDF on mobile 200 |
| Tasks, scheduling, calendar | 102 | 1,298 | custom TODO keywords 263, notifications 85 |
| Assets, images, media | 143 | 896 | orphan assets 77, export PDF with highlights 61, audio 43 |
| Integrations (Zotero, Readwise, GCal…) | 67 | 884 | Google Calendar 78, Zotero fields 73 |
| Search | 99 | 834 | fix search 142, body filters 140, operators 83 |
| Mobile | 58 | 718 | PDF on mobile 200, plugins on mobile 147, cloud sync iOS 130 |
| Namespaces, hierarchy, folders | 75 | 706 | namespace redesign 114, folders 67 |
| Plugins, API, themes, CSS | 74 | 673 | plugins on mobile 147 |
| Queries | 102 | 658 | table UI 58, done date 42, reusable queries 41 |
| Graph view | 94 | 658 | hide alias nodes 109, show block refs 56 |
| Export, import, publish | 76 | 637 | pandoc/PDF export 110 |
| Whiteboard, drawing, diagrams | 70 | 490 | mermaid 104, draw.io 46 |
| Sync, backup, git | 59 | 469 | cloud sync on iOS 130, Nextcloud 40 |
| Properties | 65 | 366 | hide property headings 34, inline `::` 29 |
| Longform / document mode | 5 | 298 | longform 248, non-outline text 31 |
| Journal | 51 | 270 | auto-delete empty 82, password 27 |
| Tables | 29 | 247 | table UI 58 |
| Templates | 21 | 246 | cursor in template 36, hotkeys 21 |
| Flashcards / SRS | 51 | 214 | SRS improvements 38 |
| Encryption, privacy, lock | 18 | 199 | read-only page 69, encrypted blocks 27 |
| Kanban, board, timeline | 3 | 105 | kanban 100 |
| i18n / language | 17 | 102 | RTL 20 (plugin), spellcheck language 17 |
| AI / LLM | 15 | 77 | native LLM integration 21 |
| Multi-graph / collaboration | 7 | 64 | cross-graph refs 26 |
| Performance | 8 | 48 | — |

Two readings. First, the *editor and references* dominate by volume: people want the core
outliner to be better, not a new primitive. Second, **sync is under-represented here** (59
topics) relative to its weight in Q&A (141k views) and in the exodus threads — because sync was
sold as a paid product, complaints went to Q&A, GitHub and Discord rather than to the request
board. Do not read 469 votes as "sync is a minor want".

### 3.3 GitHub issues by 👍

`logseq/logseq` has 44,876 stars and 943 open issues (841 that GitHub's search counts as issues;
84 labelled `:type/feature-request`, 331 `:type/enhancement`, 215 `:type/bug`). Issues filed per
year: 2022: 2,701; 2024: 586; 2026 to date: 195 (116 still open).
([issues sorted by 👍](https://github.com/logseq/logseq/issues?q=is%3Aissue+sort%3Areactions-%2B1-desc))

| 👍 | opened | state | issue |
|---:|---|---|---|
| 79 | 2021-12 | open | [#3462](https://github.com/logseq/logseq/issues/3462) Move config/cache to `~/.config/logseq` (XDG) |
| 51 | 2022-02 | closed | [#4107](https://github.com/logseq/logseq/issues/4107) Logseq in Docker — open a directory on the server |
| 50 | 2022-03 | open | [#4709](https://github.com/logseq/logseq/issues/4709) Aliases duplicated in graph view and search results |
| 43 | 2022-04 | closed | [#5064](https://github.com/logseq/logseq/issues/5064) A notification and reminder system |
| 43 | 2024-06 | closed | [#11378](https://github.com/logseq/logseq/issues/11378) Electron 28 has reached end-of-life |
| 41 | 2021-11 | open | [#3150](https://github.com/logseq/logseq/issues/3150) Allow "changing history" (LOGBOOK) |
| 40 | 2024-12 | closed | [#11644](https://github.com/logseq/logseq/issues/11644) Electron version outdated and marked insecure |
| 36 | 2023-05 | open | [#9403](https://github.com/logseq/logseq/issues/9403) Android: cannot select a Nextcloud-hosted directory |
| 30 | 2022-03 | closed | [#4592](https://github.com/logseq/logseq/issues/4592) Self-hosting suggestions/ideas |
| 29 | 2022-05 | open | [#5421](https://github.com/logseq/logseq/issues/5421) i18n of weekday names in dates |
| 26 | 2020-11 | closed | [#652](https://github.com/logseq/logseq/issues/652) Tables creation command + autoformat |
| 26 | 2020-08 | closed | [#133](https://github.com/logseq/logseq/issues/133) Google Drive storage support |
| 23 | 2022-01 | closed | [#3967](https://github.com/logseq/logseq/issues/3967) Ctrl+W should not close the app |
| 22 | 2024-04 | open | [#11240](https://github.com/logseq/logseq/issues/11240) Logseq on Ubuntu 24.04 |
| 20 | 2022-01 | closed | [#3763](https://github.com/logseq/logseq/issues/3763) Queries should recognise aliases |
| 20 | 2022-09 | open | [#6817](https://github.com/logseq/logseq/issues/6817) `exclude-from-graph-view` ignored in page graph |
| 20 | 2022-02 | open | [#4332](https://github.com/logseq/logseq/issues/4332) Plugin install fails behind a corporate proxy |
| 19 | 2023-11 | closed | [#10449](https://github.com/logseq/logseq/issues/10449) Release on F-Droid |
| 18 | 2021-08 | open | [#2637](https://github.com/logseq/logseq/issues/2637) Remove orphan assets |
| 18 | 2024-03 | open | [#11090](https://github.com/logseq/logseq/issues/11090) Cannot open a new window on macOS |
| 17 | 2023-03 | open | [#8836](https://github.com/logseq/logseq/issues/8836) Plugin: execute external commands |
| 16 | 2023-03 | open | [#8890](https://github.com/logseq/logseq/issues/8890) SRS algorithm is faulty |
| 15 | 2022-03 | open | [#4484](https://github.com/logseq/logseq/issues/4484) Flashcards/SRS improvements |
| 12 | 2020-10 | closed | [#554](https://github.com/logseq/logseq/issues/554) Convert block to page |

Open issues per area label (one search each): `ux` 71, `parser` 55, `editor` 37, `query` 36,
`pdf` 33, `shortcuts` 31, `page-ref` 31, `props` 25, `search` 24, `plugins` 21,
`format:markdown` 18, `card` 16, `logbook` 14, `graph` 13, `mobile:ios` 12, `mobile:android` 12,
`publishing` 10, `hierarchy` 9, `:type/performance` 9, `themes` 7.

**Bugs people have lived with for years** — a bug tolerated this long is a feature gap:

- [#10854](https://github.com/logseq/logseq/issues/10854) linked references jump around and
  reorder while editing them (12 👍, 2024, unlabelled).
- [#11453](https://github.com/logseq/logseq/issues/11453) slow start-up (12 👍, 2024).
- [#3622](https://github.com/logseq/logseq/issues/3622) footnote rendered incorrectly (13 👍,
  2021, still the top open bug).
- [#7519](https://github.com/logseq/logseq/issues/7519) renaming a page does not update queries
  that use it (2022; "estimate: very large").
- [#9036](https://github.com/logseq/logseq/issues/9036) undo/redo broken inside the code editor.
- [#10105](https://github.com/logseq/logseq/issues/10105) / [#8485](https://github.com/logseq/logseq/issues/8485)
  `/scheduled` or `/deadline` deletes part of the block's text (2023).
- [#3312](https://github.com/logseq/logseq/issues/3312) empty journal pages are never deleted or
  hidden (10 👍, 2021) — nooklet's virtual-day design makes this impossible by construction.
- [#4709](https://github.com/logseq/logseq/issues/4709) aliases duplicate in graph and search
  (50 👍, 2022) — alias handling is where nooklet's search/backlinks should be tested hardest.
- [#9721](https://github.com/logseq/logseq/issues/9721) navigating back loses scroll position.
- [#5224](https://github.com/logseq/logseq/issues/5224) Android "system" theme does not work
  (2022); [#8655](https://github.com/logseq/logseq/issues/8655) hamburger menu unreliable on
  Android; [#3330](https://github.com/logseq/logseq/issues/3330) image resizing ignored.

In the DB era (issues since 2025-07, 351 of them), the most-reacted are YouTube embeds broken
(13 👍, fixed), the PDF viewer not showing pages (11), the Flatpak stuck on 0.10.14 (8), "how to
disable search with Google" (8), "Turning off Journals" (7), Electron EOL again (7), and
[#12493](https://github.com/logseq/logseq/issues/12493) "updated to 0.10.15, all plugins stopped
working" — small numbers, which is itself a finding: the audience filing issues has thinned.

### 3.4 The DB migration: what it dropped, changed, and still lacks

Primary source: [`db-version-changes.md`](https://github.com/logseq/docs/blob/master/db-version-changes.md)
and [`db-version.md`](https://github.com/logseq/docs/blob/master/db-version.md) in `logseq/docs`,
plus the split announcement ([logseq.io](https://logseq.io/page/b2ad9ce1-9cb7-4436-8083-54cb4516d324/df4dc09d-0a12-4c87-904e-22a9bf4c350a),
April 2026): OG gets *"security fixes and patches"* and *"Electron and dependency upgrades"* only.

What the DB version **removed or plugin-ised** (its own words): whiteboards (*"will hopefully be
available as a plugin"*), slides, Excalidraw `/draw`, the built-in Zotero integration, org-mode
(*"Markdown is the only supported format"*), the previous flashcard data (*"none of the properties
and srs data … is imported"*), the `{{namespace}}` macro, the old table component, and ~20
`config.edn` options including `:favorites`, `:default-templates`, `:preferred-workflow`,
`:journal/page-title-format`, `:hidden`. Markdown syntax for headings/quotes *"is no longer
visible or editable"*. Tasks are *"no longer created by typing keywords like `TODO`"* but via
`/todo`. A block may hold only one query, one embed, or one quote. Only *"65+ plugins"* of 641
support DB graphs. There is no re-index. Namespaced page names no longer contain their path.

What it **added** that users had asked for: typed properties with choices, tags-as-classes with
inheritance, created/updated timestamps on everything, a done-status history, repeat tasks, an
inline-editable table view, find-and-replace (promised in the "why DB" post), unique-per-tag page
names, an EDN export, a CLI, a local MCP server on `127.0.0.1:12315/mcp`, a native iOS app, a
one-way markdown mirror (Electron only), self-hostable sync — *"This paid feature requires an
account used with Sync. This feature can also be self hosted!"*

What users say is **worse or missing**, with sources:

- Files. *"Transparent native markdown was maybe my top ranking feature"* (gegtik); *"At a time
  when half the edits are done by Claude and tracked with jujutsu"* (Valodim); *"Ain't no way I'm
  giving up my dumb file syncing that works for decades"* (Groxx) — HN
  [48896229](https://news.ycombinator.com/item?id=48896229), July 2026, 85 comments, in which
  "obsidian" appears in 22 comments, "sync" in 19, "claude/llm/agent/ai" in 13, "markdown" in 12.
- *"Two way mirroring"* is *"still in development"* (Matias_Gonzalez); the announcement says the
  team is *"still researching the best way to do this"*.
- Sync cost: *"synchronizing really bandwidth and time consuming"* with SQLite (damien.flament);
  *"maybe to get more folk using sync via the paid service rather than using good tools like
  Syncthing"* (bldgzr) — [t/35091](https://discuss.logseq.com/t/is-anyone-planning-to-use-og-version-indefinitely/35091),
  July 2026, 118 likes.
- Trust: *"abandon the current version and start a perpetual beta that you're expected to use as
  your daily driver"* (ReluctantLaser); *"I donated $15/month … to try Logseq Sync when it was in
  beta … It's still in beta"* (gareim); *"No mention of a migration guide from V1 to V2"*
  (jellyroll42); Electron *"39 (or is it even 38?), which is EoLed"* (Gleb_Popov).
- Import gaps ([t/31172](https://discuss.logseq.com/t/current-logseq-db-import-limitations/31172)):
  no org files, no `#+BEGIN` blocks, page and block embeds not imported, repeat settings on
  scheduled/deadline dropped, custom NOW/LATER workflows lost, tags silently becoming links.
- Tags and namespaces ([t/28558](https://discuss.logseq.com/t/its-hard-to-migrate-to-the-logseq-db-version-for-logseq-md-users-logically-speaking-about-the-new-tag-feature-and-removed-namespace/28558)):
  hundreds of `[[golang/class]]`-style pages whose hierarchy tags could not express; later
  answered by the "Library" parent property.
- Mobile: *"I need mobile (can't even login to mobile anymore)"*, *"iOS app has just failed
  completely (paid sync supporter etc)"* —
  [t/34942](https://discuss.logseq.com/t/leaving-logseq-alternative-suggestions/34942), April 2026,
  62 posts. Android DB app *"has not been opened up for alpha testing yet"* (db-version.md).
- Search: *"My biggest logseq complaint is the search. It's just missing stuff for me"*
  (Matt_Lynch, same thread); Obsidian's is *"much better"*.

The **roadmap** ([logseq.io/p/NX4mc_ggEV](https://logseq.io/p/NX4mc_ggEV), announced
2025-11-28) lists as planned: two-way markdown↔DB sync, export DB graph to markdown, self-hosted
sync, native Android, page publishing, list/table/gallery/kanban views, canvas research,
recycle-bin restore, page history, property history, repeated tasks, notifications, tabs and
windows, calendar integration, whiteboard, rich-text editor, plugins on web, template revival,
CLI with headless sync, REST API and MCP, a ChatGPT plugin, "Logseq Pro", CRDT for block
conflicts, and *"Agents with Logseq graphs as memory"*. Compare with nooklet's `README.md`.

### 3.5 Why people leave, and what they say they will miss

| Left for | What pulled them | What they miss from Logseq | Source |
|---|---|---|---|
| Obsidian | *"Obsidian's markdown is so much cleaner … Logseq is a mess"* (unused ids, `collapsed:: true`); header links without ids; wider adoption; better search; faster; tabs and Vim built in; Zotero integration *"improved considerably"* | ref inheritance to children (*"which I use extensively"*), editable transclusion in backlinks, block properties, seeing child blocks in backlinks | [t/20733](https://discuss.logseq.com/t/what-if-i-you-had-to-move-to-obsidian/20733), [t/34886](https://discuss.logseq.com/t/preparing-a-logseq-graph-for-migration-to-obsidian-what-should-i-watch-out-for/34886), ianreppel.org, HN 48896229 |
| Tana | supertags with typed fields, schema changes that propagate live, a query builder with table/kanban/tab views | open source, offline, plugins, owning the data | [t/13579](https://discuss.logseq.com/t/what-are-the-biggest-differences-between-tana-and-logeq/13579), [t/18293](https://discuss.logseq.com/t/what-i-am-missing-from-tana/18293) |
| Obsidian + iCloud, Joplin, org-mode, SilverBullet, Trilium, AnyType, GitJournal, Foam | reliable sync without data loss; *"less and less lock-in"*; mobile that opens | outliner zoom, journals, block refs, queries, inherited task context | [t/34942](https://discuss.logseq.com/t/leaving-logseq-alternative-suggestions/34942), [t/33283](https://discuss.logseq.com/t/the-endless-wait-for-logseq-db/33283), [t/28770](https://discuss.logseq.com/t/logseq-is-not-a-reliable-note-taking-app/28770) |
| Stacks / TickTick / Planner (for tasks only) | *"no calendar or timeline view or features like highlighting overdue tasks"*; backlinks *"a disorganised mess"*; 350+ tasks with no overview | still uses Logseq daily for capture | [t/5815](https://discuss.logseq.com/t/why-i-no-longer-use-logseq-for-taskmanagement-but-somehow-still-do/5815), 93 likes |
| Dendron / plain files | *"chronic sync errors"*, page deleted while typing, hard to write multi-line blocks, quick capture on iOS | *"writing notes actually became quite addicting"*, offline, git | HN [32248543](https://news.ycombinator.com/item?id=32248543) |

Sync specifically ([t/33502](https://discuss.logseq.com/t/discussion-is-git-the-only-truly-reliable-self-hosted-sync-for-multiple-devices-in-2025/33502),
Sept 2025): Syncthing users report data loss *"more than half the time"* (pmorch) or none in four
years if you never edit on two devices at once (CalmDownMonkey); the root cause named by merdely
— two devices holding the same block open, one writing an empty line over the other's text — is
exactly what an op log with per-field LWW prevents. Demand for self-hosted sync is old and
sustained: the reverse-engineered OSS backend thread ([t/21850](https://discuss.logseq.com/t/building-a-self-hostable-sync-implementation/21850),
2023, 52 likes: *"something I've been hoping and wishing for for at least a year"*),
[#4592](https://github.com/logseq/logseq/issues/4592) (30 👍), [#4107](https://github.com/logseq/logseq/issues/4107)
(51 👍), the 61-vote *Local storage for self-hosted Logseq* request, and *"Will logseq sync be
open source?"* (98 likes, 2025). Capacities barely registers as a destination (6 HN comments
mention both; the forum's 43 hits are almost all unrelated).

---

## 4. Part 3 — Map to nooklet

nooklet's status below was checked against the tree on 2026-09-12 (`apps/web/src/views/`,
`apps/web/src/commands/registrations/`, `packages/server/src/ops/`, `plugins/`), not against
`PLAN.md`. Three places where the tree and `PLAN.md` disagree are flagged in the table:
`GraphView.tsx` exists although graph view is a listed non-goal; "code fences with highlighting"
is a seam with no highlighter wired (`render/tokens.tsx:52`, test "no highlighter wired");
the Capacitor shell is a `capacitor.config.ts` in `apps/web` with no `apps/mobile` and no store
build. A fourth is unverified rather than contradicted: the journal-day "Scheduled and deadline"
section described in `PLAN.md` §8 was not found by grepping the views.

### 4.1 Feature table

| Feature | Logseq tier | Demand evidence | nooklet | Recommendation |
|---|---|---|---|---|
| Journal stream, calendar, virtual days | A | docs; #1 plugin 270k; "auto delete empty journal" 82 votes, #3312 | **have** (`JournalStreamView`, `Calendar`, `VirtualJournalDay`) | keep; the empty-day design already answers a 5-year-old request |
| Outliner: indent, collapse, zoom, move, multi-select | A | 70 editor shortcuts; "can't live without" zoom | **have** | keep |
| Indent guides ("bullet threading") | A | plugin 238k | **have** (B-13) | keep |
| `[[refs]]`, `#tags`, linked refs grouped by page, path-ref inheritance | A | 203k views; "inheritance … I use extensively" | **have** | keep; test alias + inheritance edge cases (#4709) |
| Unlinked references | B | "Automatically link unlinked" 40 votes; plugin 49k | **have** (list) / **missing** (link-all) | add a one-click "link" per mention and "link all" |
| Tasks: markers, `Cmd+Enter`, priorities, checkbox | A | 700 task blocks; todo plugins 255k | **have** | keep |
| Scheduled/deadline, repeat, done timestamp | B | "done date query-able" 42, repeaters 54; DB roadmap | **have** (`repeat::`, `done::`) | keep; verify the journal-day section exists (§4 preamble) |
| Tasks view with filters | B | "Queries for task management" 43k views; agenda 83k | **have** (`TasksView`, due-date and state filters) | keep; it is the answer to most task queries |
| Query fence (```` ```query ````) | B | 458-topic subcategory; 405 tagged; 102 requests / 658 votes | **spec'd, not shipped** (ADR 011) | **build next, #1** |
| Custom TODO keywords | B | 263 votes; DB replaced with a status property | **missing**, fixed set of 10 markers | non-goal: keeps parser, import, MCP and UI simple; WAITING/CANCELED cover the common extra |
| Task notifications | B | 85 votes; #5064 43 👍; DB roadmap | **missing** | later, with the Capacitor shell (local notifications need a native layer) |
| Search: FTS, filters, phrases, exclusions | A | "fix the search" 142; operators 83; leavers cite Obsidian's search | **have** (`search` op: mode, tags, properties, namespace, pages, date range; SearchView UI) | expose tag/marker filters in the UI, not only in the op |
| Semantic / hybrid search | — | gpt3 plugin 85k; "native LLM integration" 21 | **have** (Ollama, sqlite-vec) | keep; unique |
| Search in current page | B | `Cmd+Shift+K`; 78-vote request done | **missing** | small: filter the rendered outline by text |
| Find and replace across graph | B | 67 votes; karl-voit; DB promised | **missing** | **build, #4** — server op + palette command, batch-undoable |
| Properties on pages and blocks, typed | B | 272k views; "90 % properties" | **have** (`PageProperties`, property defs) | keep |
| Tag pages declaring property templates | B | Tana supertags threads; DB "NewTags" 8.8k views | **partial** — ADR 017 accepted; template mechanism not found in code | verify; if absent, it is the cheap version of supertags |
| Templates (`/template`, journal template) | B | 44k views; `:default-templates`; roadmap "revival" | **missing** | **build, #2** as a built-in plugin |
| Block refs `(( ))`, embeds | B | must-miss in Obsidian threads | **have** | keep |
| Block ref by name | C | 40 votes (done in DB) | **missing** | skip; ids are stable and short |
| Namespaces, hierarchy view | B | 114-vote redesign; 16.7k how-to | **have** (`NamespaceChildren`, short-form display) | keep; shortest-unambiguous-suffix resolution answers the redesign thread |
| Aliases | B | unique-feature list; #4709 | **have** | keep; add to e2e for search/backlink dedup |
| Right sidebar / shelf | B | 11k how-to; tabs 211k | **have** (`Shelf`) | keep |
| Tabs / multiple windows | B | 83 votes; 211k; #11090 | **missing** | medium, after Tauri multi-window is cheap; not before |
| Favourites, recent | B | `Cmd+Shift+F` | **have** (synced `favorite` property) | keep |
| Page outline / TOC | B | 121 votes; toc plugins 60k | **missing** | **build, #7** as a shelf card |
| Collapsed by default | B | 84 votes | **missing** (state persists per block) | small setting |
| Sort / filter linked references | B | 78 + 140 votes; #10854 (jumping refs) | **partial** — grouped, recency-sorted, collapsible; no filter | **build, #5** |
| Graph view | C | 94 requests, mostly "hide X" | **have** (`GraphView.tsx`, `graph.links` op) — contradicts PLAN non-goal | keep as is; zero further investment; fix PLAN wording |
| Code fences | B | copy-code 32k | **have**; highlighting is a seam only (PLAN says shipped) | **wire a highlighter, #9** |
| Math / LaTeX | B | 50 votes; 6.9k how-to | **partial** — token recognised, no KaTeX loaded | load KaTeX in a plugin, #9 |
| Tables | B | 118k plugin; 58 votes | **have** render + `/table` insert; no editor | low; a cell-editing widget later |
| Numbered lists, headings | B | 700 numbered lines in owner's graph | **have** | keep |
| Images, assets, mobile capture | B | 300 images; 896 votes of asset requests | **have** | keep |
| Orphan-asset cleanup | B | 77 votes; #2637 18 👍 | **missing** | **build, #10** — `nooklet gc --assets` |
| Mermaid | C | 104 votes; 27k | **have** (`plugins/mermaid`) | keep |
| Word count | C | 34 votes; 18k | **have** (`plugins/word-count`) | keep |
| Custom CSS, font size, content width, wide mode | B | 104 + 24 votes; `t w`; 44 css topics; ~600k theme and restyler downloads | **missing** (Appearance has theme + date format) | **build, #6** — three settings and a CSS box |
| Dark / system theme | A | #10289, #5224 | **have** | keep |
| Keybindings editable | B | Vim 221; "remove hotkey" #8208 | **have** (`keybindings.json`, synced) | keep; settings UI listing conflicts per ADR 009 |
| Vim mode | C | 221 votes; 49k | **missing** | non-goal in core; CM6 `@replit/codemirror-vim` inside a block is a plausible plugin |
| Longform / document mode | C | 248 votes (#3 request); `t d` | **missing** | non-goal; a "hide bullets" CSS toggle could be a plugin |
| Multi-line paste creates blocks | B | "paste rich text" 29; paste-more 16k | **have** (markdown); HTML→markdown unverified | check HTML paste from a browser |
| Copy as markdown | B | — | **have** | keep |
| Turn block into page / move block to page / merge pages | B | 52 + 52 + 58 votes; block-to-page 53k; move-block 32k; #554 | **missing** in UI (`block.move` op exists) | **build, #3** |
| Page rename with link rewrite, old name as alias | A | #7519 | **have** (`page.update`) | keep |
| Trash / restore | B | DB roadmap "recycle to restore" | **partial** — soft delete, `batch_undo` for agents, no UI | **build, #8** |
| Page history / versions | B | roadmap "page history"; #3150 41 👍 | **partial** — op log holds every change, no viewer | #8, same UI |
| Block timestamps | B | 46 votes (done in DB) | **partial** — in the model, not shown | show in context menu / properties panel; trivial |
| Undo across blocks, sync-safe | A | "unreliable undo" in the why-DB post; #9036 | **have** | keep |
| Sync, self-hosted, offline, op log | A | §3.5 entirely | **have** | keep; this is the product |
| Cloud-drive file sync (iCloud/Dropbox) | A | 130 votes | n/a — the mirror can live in a synced folder but is not the medium | document that; do not build file-sync |
| E2EE | C | "encrypted blocks" 27; DB has it | **non-goal** (research 11) | keep non-goal; state the trade-off in README (done) |
| Mobile: PWA, keyboard toolbar, gestures | A | "iOS unusable" threads; mobile 718 votes | **have** (PWA, `MobileToolbar`, swipe) | keep; test on device |
| Capacitor store apps | A | 147-vote plugins-on-mobile; DB Android not even alpha | **partial** — `apps/web/capacitor.config.ts`, no build/store pipeline | finish when the PWA editing feel is proven |
| Quick capture, share target | B | 26 + 26 votes; `Cmd+E` quick add in DB | **have** (`CaptureView`, `share_target`) | keep; widget later |
| Plugins on mobile | B | 147 votes | **by architecture** (client plugins are ES modules) — unverified on device | verify on a phone |
| Plugin API, marketplace | B | 166 plugins-dev topics; 641 packages | **have** API; no marketplace | fine for now |
| MCP, HTTP API, CLI, live UI control | — | DB roadmap; HN "half my edits are done by Claude" | **have** | keep; ahead of Logseq |
| Export: markdown mirror, one-shot export | A | #2871 24 votes; leavers' #1 reason | **have** | keep; document a pandoc recipe instead of building PDF export |
| Publishing | C | 21k how-to | **missing** | non-goal; the mirror feeds any static site tool |
| Git auto-commit | C | 28k plugin; 10 git topics | **missing** | document a cron/launchd recipe over the mirror |
| PDF viewer / annotation | B (segment) | 119 topics; 200 + 42 votes; 33 open issues | **missing** | non-goal; open in system viewer; `hl-*` import stays plugin territory |
| Epub | C | 285 votes, #1 request | **missing** | non-goal |
| Whiteboards, Excalidraw, drawing | C | 70 requests; removed in DB | **missing** | non-goal |
| Flashcards / SRS | C | 51 requests; SRS bugs open since 2022; anki-sync 40k | **missing** | non-goal; an export-to-Anki plugin is the community's own answer |
| Kanban | C | 100 votes; 59k | **missing** | non-goal; query fence + Tasks view cover the "overview" need |
| Google Calendar sync | B | 78 votes; roadmap | **missing** | plugin territory |
| Zotero, Readwise, Omnivore | C | 73 + 52 votes; 24k + 24k | **missing** | plugin territory |
| Audio recording | C | 43 votes; DB has it | **missing** | later, Capacitor |
| i18n of dates / UI | B | #5421 29 👍; #11428 | **partial** — journal title format is a setting; locale handling unverified | check Czech weekday names in the journal title formats |
| Multiple graphs | B | "Three choices" #3 | **partial** — one graph per server | document running two servers |
| Real-time collaboration, multi-user | C | 7 requests / 64 votes | **non-goal** (research 12) | keep non-goal |
| Org-mode | C | dropped in DB | **missing** | non-goal |

### 4.2 Ranked shortlist: what nooklet should build next

Ranking weighs (a) demand evidence above, (b) whether it serves outliner + refs + sync + API +
embeddings + plugins (PLAN principle 3), (c) cost given what exists.

1. **Ship the ```` ```query ```` fence (ADR 011).** Queries are the single largest help topic on the
   forum (458 topics / 2,761 posts; the most-viewed how-to is *Queries for task management*, 43k
   views), and the three largest task plugins (≈350k downloads) exist because the built-in query
   UI is hard. nooklet already has the filter language (Tasks view, `search` op) and the spec;
   what is missing is the fence renderer. Ship the filter language, not Datalog — Logseq's own DB
   version moved simple queries to a builder and hid the Datalog behind "advanced".
2. **Templates.** A per-graph journal template and `/template <name>` inserting a block subtree.
   "Templates — how to create, edit, and insert?" has 44k views; `:default-templates` is in the
   default config; Logseq's roadmap lists "text template revival" after the DB version broke
   them. Cost is small as a built-in plugin using `block.insert` with a subtree.
3. **Block↔page refactors.** *Turn block into page* (block-to-page plugin 53k downloads, #554,
   52 votes), *Move block to page…* (move-block 32k, same request), *Merge pages* (58 votes).
   `block.move` and `page.update` exist; these are palette commands plus a page picker.
4. **Find and replace across the graph.** 67 votes, promised by Logseq's DB post, Karl Voit's
   headline complaint. One server op that returns a preview and applies as a `batch` so
   `batch_undo` reverses it.
5. **Linked-references filters and sort.** "Filters for note body" 140 votes, "Sort linked
   references" 78, and the long-tolerated #10854. The panel already groups by page; add
   include/exclude by page or tag (Logseq's `filters::` semantics, stored as a page property so it
   syncs) and a recency/alphabetical toggle.
6. **Appearance basics.** Font size, content width / wide mode, and a custom-CSS box. 104 votes,
   `t w` is a default shortcut, and the marketplace's top-40 contains six themes plus three
   "awesome-*" restylers (~600k downloads). Three settings and a `<style>` tag.
7. **Page outline card in the shelf.** 121 votes; two TOC plugins ≈60k. Headings already exist
   in the model; the shelf already holds cards.
8. **Trash/restore and history viewer.** The op log already holds both; Logseq's roadmap lists
   "recycle to restore deleted pages" and "page history"; the data-loss threads (§3.5) are the
   trust killer. A "Trash" view plus "History" on a page, both read-only over the op log.
9. **Wire the syntax highlighter and load KaTeX.** Both are seams today; `PLAN.md` describes
   highlighting as shipped. Lazy-load per language inside the mermaid-style plugin pattern.
10. **Orphan-asset GC and "link all unlinked references".** 77 votes / 18 👍 and 40 votes; both
    small server-side jobs.

Deliberately *not* in the top ten despite demand: tabs/multi-window (wait for Tauri to make it
cheap), task notifications (needs the native shell), Capacitor store builds (finish the PWA
feel first; ADR 005), plugins-on-mobile verification (a test, not a feature).

### 4.3 Popular in Logseq, staying out of nooklet

| Feature | Demand | Why it stays out |
|---|---|---|
| Epub reader | 285 votes, #1 | A reader-with-annotations is a second product; Logseq never built it either |
| Custom TODO keywords | 263 | Every consumer (parser, mirror, importer, MCP, Tasks view, glyphs) would need to be data-driven; WAITING/CANCELED plus properties cover the cases; Logseq DB solved it by making status a property, which nooklet's typed properties already allow for user-defined states |
| Longform / document mode | 248 | nooklet is an outliner on purpose; Logseq's own `t d` mode is judged "inadequate" in the forced-outlining thread. A bullet-hiding CSS toggle can be a plugin |
| Vim | 221 | Plugin territory: CM6 has a Vim extension; block-level motions are the hard part and belong to whoever wants them |
| PDF annotation | 200 + 42; 119 topics | A genuine segment, but the thread of Zotero users leaving for Obsidian shows it is an ecosystem, not a feature; keep `hl-*` import as plugin territory |
| Kanban / boards | 100; 59k | Named non-goal; the query fence plus Tasks view give the "overview" the task-management thread asked for |
| Whiteboards, Excalidraw, mind maps | 70 requests; markmap 127k | Named non-goal; Logseq itself removed them and got little protest |
| Flashcards / SRS | 51 requests; SRS bugs since 2022 | Named non-goal; the community's own answer is anki-sync (40k) — an export plugin |
| Datalog / advanced queries | 30 votes for an editor; 36 open query issues | One filter language shared with search and Tasks (ADR 011); Datalog is why 458 help topics exist |
| E2EE sync | 27 | Blocks server-side embeddings and MCP (research 11); a tailnet is the answer |
| Real-time collaboration | 64 votes total | One user, many devices (research 12) |
| Google Calendar, Zotero, Readwise | 78, 73, 52 | Plugin territory by design |
| Org-mode | — | Dropped by Logseq DB too; import-only |
| Publishing | 21k how-to | The markdown mirror plus any static site generator; no second renderer |
| Graph view | 658 votes of tweaks | Already exists; freeze it |

---

## 5. What this changes in the record

- `PLAN.md` §2 lists "graph view" as a non-goal while `apps/web/src/views/GraphView.tsx` ships
  one; §2 says "code fences with highlighting" and §15 marks M5 "Capacitor shell" done — both are
  seams/config only. Not edited here (this task writes one file); the coordinator should
  reconcile.
- ADR 011's query fence moves from "specified, v1.x" to the top of the build list on the strength
  of §2.2.
- The "templates later as a plugin" decision in `PLAN.md` §17 is kept, with the plugin now
  scheduled second.

---

## 6. Still unverified

1. **Reddit.** `r/logseq` top posts, recurring "how do I" threads and the subscriber count could
   not be fetched (HTTP 403 on `www.reddit.com`, `old.reddit.com` and `api.reddit.com`, with and
   without a browser user agent; the WebFetch tool refuses the host). The forum and HN stand in
   for it. A human with a browser can check
   `https://www.reddit.com/r/logseq/top/?t=all` in a minute.
2. **Published user surveys.** Forum search for "survey" returns only a 2021 plugin-system
   survey; HN's index has none. Whether Logseq ever published usage-survey results is unknown; no
   claim here rests on one.
3. **Discourse vote cap.** The per-user active-vote limit on `discuss.logseq.com` was not found in
   `site.json`; the plugin's default is small (single digits to low tens). This affects how much
   the ≥100 tier can be read as a ranking.
4. **Where the community went.** The decline in forum requests and GitHub issues is measured;
   whether the people moved to Discord (linked from the docs), left, or simply stopped asking is
   not. Discord member counts were not fetched.
5. **Marketplace `stats.json` freshness.** Per-package `lastFetchedAt` values cluster around
   2026-08; the `popular.json` snapshot is dated 2026-01-02. Download sums include updates and
   themes, as stated in §1.
6. **nooklet's journal-day "Scheduled and deadline" section** (`PLAN.md` §8): not found by a
   grep of `apps/web/src/views/` for plausible names. It may live elsewhere or not exist; check
   before citing it as shipped.
7. **Tag-page property templates** (`PLAN.md` §8, ADR 017): the ADR is accepted; no template
   mechanism was found in `packages/core` or `packages/server`. Same check.
8. **HTML paste**, **plugins on a real phone**, **Czech weekday names in journal titles**: each is
   a five-minute manual check, none was done here.
9. **The two-way markdown mirror in Logseq DB**: "still researching" per the April 2026
   announcement and "PR mentioned" per a July 2026 forum post; whether it has since shipped was
   not checked against the DB repo.
10. **Logseq Sync pricing** in 2026: the docs say "paid feature requires an account"; the price
    was not fetched.
