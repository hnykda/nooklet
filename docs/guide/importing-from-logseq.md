---
title: Importing from Logseq
description: Bring a Logseq graph into nooklet, from either the classic file-based Logseq or the newer database (DB) version, and what carries over from each.
order: 3.5
---

# Importing from Logseq

nooklet imports both kinds of Logseq graph with the same command. It looks at the folder you give
it, says which kind it found, and reads it accordingly.

```sh
pnpm nooklet import <folder> --data <nooklet data dir>
```

The import copies; it never writes to the Logseq folder. Run it with Logseq closed or open.

## Which folder to point at

| Logseq version | How to recognise it | Point the importer at |
|---|---|---|
| **File graph** (classic Logseq) | a folder with `pages/`, `journals/`, `logseq/config.edn` | that folder |
| **DB version** | a folder (usually `~/logseq/graphs/<name>/`) with `db.sqlite`, `assets/` and `mirror/markdown/` | that folder, the one holding `db.sqlite` |

For the DB version, pages come from its **Markdown Mirror**, so turn the mirror on first: in Logseq
(desktop), Settings → Markdown Mirror, then "Regenerate full mirror". The importer reads
`db.sqlite` for what the mirror leaves out. It reads a copy, so a running Logseq holding the
database is fine. Pointing at `mirror/` or `mirror/markdown/` also works; the importer finds the
root itself. A DB graph with no mirror is refused with a message saying how to turn it on.

## What carries over

| | File graph | DB version |
|---|---|---|
| Pages, journals, nesting, block order | yes | yes, from the mirror |
| Block refs `((…))` and page refs `[[…]]` | yes | yes. Refs the mirror leaves as raw ids are resolved from the database |
| Tasks (TODO/DOING/DONE…) | yes | yes |
| SCHEDULED / DEADLINE | yes | yes, the exact date and time from the database |
| Pasted images and files | yes, copied from `assets/` | yes. The database says which picture each line stands for |
| An image's size (and, DB version, alignment) | yes, `{:height …, :width …}` is kept and shown as the size | yes, from the database |
| Page and block properties | yes | yes. A property whose value is a set of blocks stays as child blocks |
| Favourites | yes, from `config.edn` | yes, from the database |
| Tags | yes | yes, as `#tag` in the text |
| Journal title format | suggested in Settings | suggested in Settings |

## What does not carry over yet

| | File graph | DB version |
|---|---|---|
| Whiteboards | no | no |
| Built-in pages (property and class pages) | n/a | no; they are Logseq's own, not your notes |
| Property *types* and class schemas | n/a | no; values come over as text |
| Embeds of blocks | as written | expanded inline by the mirror, so they arrive as copies |
| Pre-2022 "dot" namespace file names (`a.b.md`) | no | n/a |

The import prints a summary. For a DB-version graph it includes how many images were matched,
how many lines were ambiguous and left as text (with a warning for each), and how many refs could
not be resolved. Ambiguous means the importer could not pin a line to one picture by position, and
the title was not unique. It never guesses.

Running the import again skips pages that already exist.
