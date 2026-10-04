# ADR 030: Import Logseq DB-version graphs too, from the mirror plus `db.sqlite`

Date: 2026-10-04. Status: accepted (owner decision). Supersedes ADR 012's "file graph only" scope.

## Context

ADR 012 scoped the importer to the classic file graph. The owner's real graph now lives in the
Logseq DB version, and importing its Markdown Mirror as if it were a file graph lost data (B-711,
B-715): every pasted image arrived as a timestamp or a raw `[[uuid]]`, which minted a page named
after the uuid. The mirror is one-way and lossy by design (Logseq `docs/adr/0016-markdown-mirror.md`):
it leaves refs to non-pages as raw uuids, writes an image block as its bare title, writes properties
and dates as `* Title:: value` list items in the graph's display date format, and omits favourites.
The owner asked: document that only the DB version is supported, or handle both? Decision: both.

## Decision

1. `nooklet import <dir>` auto-detects the format in the importer core (`detectLogseqGraph`), not
   the CLI, so in-app import uses the same path. `db.sqlite` + `mirror/markdown/` is a DB graph;
   anything else is a file graph, read as before.
2. A DB graph's pages still come from the **mirror**, through the same parser and op builder as a
   file graph. What the mirror loses is put back from **`db.sqlite`**, read by our own small
   reader (`importer/logseq-db.ts`): Datascript's storage nodes in `kvs`, transit-JSON, decoded with
   `transit-js` (pinned, server-only, no dependencies). The reader opens a temporary copy, never
   the file Logseq may be holding.
3. Identity, not text: mirror pages are matched to database pages by journal day or exact title,
   and the trees are aligned level by level (`:block/order`, the mirror's own child order). A line
   becomes an image only when its position identifies the asset entity, or, failing that, when its
   title is unique on that page on both sides. Anything else is left as text and counted.

## Alternatives rejected

- **Document "DB version unsupported".** The owner's graph is a DB graph; this leaves them with no
  way in.
- **Read only `db.sqlite`, ignore the mirror.** Rebuilding markdown from Datascript entities means
  re-implementing Logseq's serializer (refs, properties, embeds, headings, code blocks) and owning
  every format change. The mirror is Logseq's own rendering; we only repair what it drops.
- **Match assets by title text alone.** Titles like `image_1700000000000_0` or a timestamp are
  usually unique but not guaranteed; a wrong picture is worse than a visible miss.
- **Use `@logseq/nbb-logseq` / Logseq's own CLI to open the DB.** A ClojureScript runtime and
  better-sqlite3 as server dependencies, to read four attributes.

## Consequences

- The DB-graph path depends on Logseq's storage layout (Datascript `storage.clj`, Logseq
  `sqlite_cli.cljs`) and attribute names (`:block/*`, `:logseq.property.asset/type`,
  `$$$favorites`). A Logseq change there shows up as unmatched counts in the import summary, not
  silent loss; the reader's tests pin the shape with a synthetic fixture.
- Whiteboards, property types and class schemas are not imported from either format.
- `docs/guide/importing-from-logseq.md` is the user-facing table of what carries over.
