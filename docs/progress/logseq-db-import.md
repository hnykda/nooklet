# Logseq DB-version import (B-715, plus favourites)

Branch: the `logseq-db-import` worktree agent's branch (based on main `ffb50469`, which contains B-711).
Owner decisions folded in: handle both Logseq formats (ADR 030); import favourites from both.

## Done

- `packages/server/src/importer/logseq-db.ts`: read-only reader for a DB graph's `db.sqlite`.
  Copies `db.sqlite` (+ `-wal`) to a temp dir, walks Datascript's EAVT tree from the root node
  (address 0), applies the tail (address 1; negative tx = retraction), decodes transit with
  `transit-js@0.8.874` (exact pin, server-only; `@types/transit-js@0.8.3` dev). `LogseqDbGraph`
  exposes entities, `assets()`, `pages()`, `favoritePages()`, `outlineChildren()` (mirror order),
  `fileContent()` (config.edn kept in the DB). Sources cited in the module header.
- `packages/server/src/importer/logseq-db-import.ts`: `enrichFromLogseqDb` repairs the parsed
  mirror trees before ops are built: folds `* Prop:: value` list items into properties, aligns
  mirror pages/blocks with DB pages/blocks by identity (journal day / exact title, then sibling
  lists level by level with a loose text check), turns asset blocks into image/file links,
  resolves `[[uuid]]` (asset → link, page → `[[name]]`, block → `((id))`, else a dangling `((uuid))`
  so no uuid-named page is minted), restores SCHEDULED/DEADLINE from the DB, returns favourites.
- `importer/logseq.ts`: `detectLogseqGraph` (core, not CLI): `db.sqlite` + `mirror/markdown/` = DB
  graph (also accepts `mirror/` or `mirror/markdown/` as the argument); file graph otherwise; a DB
  graph without a mirror throws with instructions. `parseLogseqConfigEdn` now reads `:favorites`;
  `markFavorites` sets `favorite:: true` (the app's own mechanism, `setPageFavorite`) for both
  formats. Stats gain `format`, `favoritesMarked/Missing`, `logseqDb`.
- CLI `import` says which format it detected (stderr) and the usage text names both folders.
- Tests (synthetic only): `logseq-db-fixture.ts` writes an invented DB graph in the real storage
  shape (branch + two leaves + tail + garbage node, real transit `^` cache refs);
  `logseq-db.test.ts` (8), `logseq-db-import.test.ts` (11, incl. file-graph favourites, verify).
- Docs: ADR 030, ADR 012 status, PLAN.md, `docs/guide/importing-from-logseq.md` (format table),
  getting-started link.

## Real-graph dry run (scratch copy, scratch data dir; counts only)

Importer run on a `cp` of the DB graph root (db.sqlite + wal, assets, mirror) into a fresh data dir:
format `db`; 362 pages, 864 journals, 19,825 blocks (19,993 before, minus 168 property list
items now folded into properties), 0 skipped, 0 errors, 3 warnings (the B-711 merges).
Assets: 154 asset entities (177 files, 172 imported after content dedup); 151 `[[asset uuid]]`
refs → links, 3 timestamp lines → images by position, 0 ambiguous, 0 unresolved, 1 asset entity
whose file is missing from `assets/` (its ref keeps the title as text). Refs: 2 page-uuid refs →
names, 36 block-uuid refs → `((id))`, 4 unresolved (1 missing-file asset, 3 block refs whose
target alignment could not identify, now dangling `((uuid))`). Alignment: 1,217 pages matched,
9 unmatched; 17,387 DB blocks identified, 811 not. Dates: 23 restored from the DB, 1 on an
unidentified block (its mirror date converted from the display format). Favourites: 2 marked.
`nooklet verify`: OK (21,065 ops). Scratch copies deleted afterwards.

## What the mirror loses (audit, counts from the same copy)

| Loss | Count | State |
|---|---|---|
| Image/file shown as `[[uuid]]` (minted uuid-named pages) | 151 refs | fixed |
| Asset block written as bare title (B-715's timestamp line) | 3 | fixed |
| Block refs written as `[[uuid]]` | 39 | 36 fixed, 3 dangling |
| Page refs left as `[[uuid]]` (same-name pages) | 2 | fixed |
| Properties written as `* Title:: value` list items (became empty blocks) | 168 items | fixed (folded) |
| `:default` property values written as block trees under `* Title::` | 249 items | kept as blocks; open |
| SCHEDULED written in display format, not ADR 011 | 24 | fixed (23 from DB, 1 parsed) |
| DEADLINE | 0 in this graph | handled |
| Favourites (not in the mirror at all) | 2 | fixed |
| Tasks: status → marker | 710 DB tasks; mirror markers DONE 658 / TODO 76 / DOING 5 / WAITING 3 | carried (mirror has more markers than DB tasks: embeds copy blocks) |
| Tags | 0 blocks with user tags; 63 tag classes | carried inline by the mirror |
| Whiteboards | 0 | none in this graph; not imported |
| Embeds (`:block/link`) | 7 | expanded inline by the mirror (copies); open |
| Journals vs pages duplicates (B-711) | 3 days | merged (B-711) |

## BUGS.md updates to fold in

(B-716..B-718 are provisional numbers; renumber if another branch took them.)

- **B-715** → fixed (2026-10-04, logseq-db-import). Test: `packages/server/src/importer/logseq-db-import.test.ts`
  "turns the asset block's timestamp line into an image of the imported file" and "turns a [[uuid]]
  ref to an asset into a file link…". Real graph: 151 refs + 3 lines → images/links, 0 ambiguous,
  verify OK. Root cause wider than reported: 151 of the 154 images were `[[asset uuid]]` refs, not
  title lines, and each had minted a page named after a uuid.
- **New, fixed: B-716 · Favourite pages were not carried over by the Logseq import.** Severity
  medium. `parseLogseqConfigEdn` never read `:favorites` (file graph), and DB-version favourites
  live on the hidden `$$$favorites` page. Fix: both now set `favorite:: true`. Tests:
  `logseq-db-import.test.ts` "marks Logseq's favourites as favourites", "marks the pages
  config.edn's :favorites names".
- **New, fixed: B-717 · A DB-version mirror's properties imported as empty blocks.** The mirror
  writes properties as `* Title:: value` list items; each became an empty bullet carrying one
  property (168 on the real graph), and SCHEDULED arrived in the graph's display format. Test:
  "restores SCHEDULED from the database and keeps the task marker" (asserts no empty blocks).
- **New, open: B-718 · DB-version `:default` property values and block embeds import as copies.**
  249 property items whose value is a block tree stay as child blocks; 7 embeds arrive expanded.
  Low severity, no text lost.

## Still unverified

- That the mirror writes Logseq statuses beyond todo/doing/done (backlog, in-review, canceled)
  as markers nooklet accepts: the schema's marker CHECK has no BACKLOG/IN-REVIEW. Not present in
  the real graph, not tested.
- Whiteboards in the DB version: none in the real graph, so whether the mirror writes them is
  unknown.
- The 811 unaligned blocks: sampled shapes show the DB having children the mirror omits and vice
  versa (embeds, property-value trees). They import fine from the mirror; they only lose
  identity-based repairs (3 block refs dangling).

## How to resume / re-import

```sh
NOOKLET_DATA=<scratch data dir> pnpm nooklet import ~/notes-graph --data <scratch data dir>
pnpm nooklet verify --data <scratch data dir>
```

`~/notes-graph` is the DB graph's ROOT folder (the one holding `db.sqlite`), not `mirror/markdown`.
