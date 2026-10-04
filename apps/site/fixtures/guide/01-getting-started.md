---
title: Getting started
description: Install nooklet, open your first graph, and import a Logseq folder.
order: 1
---

> Placeholder page. The real guide lives in `docs/guide/` at the repository root; the site
> renders these fixtures only while that folder does not exist yet.

nooklet keeps your notes in a SQLite database and writes a plain markdown copy next to it. You
can run it on one machine and stop there.

## Install on macOS

Download the `.dmg` from the GitHub releases page, or use Homebrew:

```sh
brew install --cask hnykda/tap/nooklet
```

The desktop app starts its own server, so opening it is all you need.

## Run it from source

```sh
pnpm install
pnpm --filter @nooklet/web build
pnpm nooklet serve
```

Then open `http://127.0.0.1:6100`.

### Import a Logseq graph

```sh
pnpm nooklet import ~/path/to/logseq-graph
```

The importer reads the classic file graph: `pages/`, `journals/` and `assets/`. See
[Sync between devices](02-sync.md) once you want a second device.

## Where your files live

| What | Where |
|---|---|
| Database | `~/.nooklet/default/graphs/default/graph.sqlite` |
| Markdown mirror | `pages/` and `journals/` beside it |

Set `$NOOKLET_DATA` or pass `--data` to put them somewhere else.
