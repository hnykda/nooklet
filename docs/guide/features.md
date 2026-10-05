---
title: Features
description: A tour of what nooklet does today, with partial and missing pieces marked.
order: 2
---

# Features

This page describes what the code does as of October 2026. Items marked **partial** work with
gaps; items marked **being improved** have open work against them right now.

## Outliner

- Every bullet is one block of markdown. Blocks nest; Tab and Shift+Tab indent and outdent.
- Enter splits a block at the cursor, Backspace at the start merges into the previous block, and
  Up/Down move between blocks keeping the column.
- Fold a block (Cmd/Ctrl+Up and Down), zoom into it (Cmd/Ctrl+.), move it (Alt+Up and Down), or drag
  it by its bullet.
- Escape selects the block; Shift+Up and Down extend the selection. Copy, cut, delete, indent and
  move work on a selection.
- Blocks hold headings, numbered lists, tables, code fences (highlighted, loaded on demand), KaTeX
  math, images and other pasted files.
- Undo and redo cross blocks and survive sync: the editor records inverse ops.
- Commands: Cmd/Ctrl+K opens a palette listing every command and page. Typing `/` in a block opens
  the slash menu. In-app help lists the bound keys. Rebinding keys in a settings screen is **not
  built** yet.

## Journals

- The Journals view is a stream: today at the top, earlier non-empty days below.
- A day becomes a page only when you write in it. Empty days never exist as pages.
- A calendar opens any day.
- Each day shows a "Scheduled and deadline" section: open tasks and dated blocks for that day, plus
  overdue tasks on today.
- The journal title format is a setting. Pages are stored under ISO names (`2026-09-07`), and
  references written in other date formats resolve to the same day.
- A block marked `journal-template:: true` becomes the starting content of each new day.

## Pages, links and references

- `[[Page]]`, `#tag`, `#[[two words]]`, `((block ref))` and `{{embed}}` of a page or block. A block
  reference renders the referenced block's text.
- Aliases (`alias::`), and namespaces written as `Projects/Aurora`, with a tree of children on the
  namespace page.
- A page exists once something links to it, and a page nothing links to and nobody wrote in goes
  away again.
- Each page lists **linked references** grouped by source page, with filters and sort saved per
  device, plus **unlinked mentions**. "Link all" turns mentions into links.
- Page and block properties (`key:: value`), page-level tags, page icons, and favorites.
- Refactors: turn a block into a page, move a block to another page, merge two pages, rename a
  page (every link follows), and find-and-replace across the graph.
- A graph view of pages and the links between them.
- **Being improved:** references and the graph view come from the server. On a local-only graph
  they say they need a server, and offline they show an error with Retry.

## Tasks

- A block is a task when its first word is a marker: `TODO`, `DOING`, `DONE`, `WAITING`,
  `CANCELED`, or Logseq's other workflow, `LATER` and `NOW`. Each state has its own glyph.
- Cmd/Ctrl+Enter cycles the marker. The graph's workflow decides where a cycle starts: `TODO →
  DOING → DONE` or `LATER → NOW → DONE`. An imported Logseq graph keeps its `:preferred-workflow`;
  otherwise nooklet infers the workflow from the markers you use, and Settings can override it.
- Priorities `[#A]`, `[#B]`, `[#C]`.
- `scheduled::` and `deadline::` dates with optional time, set from `/scheduled` and `/deadline`.
  `repeat:: 1w` or `repeat:: 1w from done` repeats a task. Completing a task stamps `done::`.
- The Tasks view lists open tasks by page, with filters for state, tag, namespace and date window.
- **Being improved:** on the phone there is no visible way to set DOING yet.

## Queries

A fenced code block with the language `query` runs a filter against your graph and renders the
matching blocks, grouped by page:

````markdown
```query
(TODO or DOING) [[Project X]] scheduled:<=today sort:deadline
```
````

The language covers markers, priorities, tags and links, page and namespace, journal date windows,
date fields with relative values (`-7d`, `+1m`), text, properties, sort and limit. Queries run on
the device, so they work offline. Logseq's Datalog `{{query}}` is not supported.

## Templates

A block with `template:: name` is a template. `/template` inserts a copy of its subtree at the
cursor with fresh ids, and expands tokens such as `<% today %>`.

## Search

- **On the device first.** Every replica has a full-text index (SQLite FTS5, diacritics folded:
  `c` finds `č`). Results appear within milliseconds, offline and on local-only graphs.
- **Semantic matches from the server.** When the device has a server and the server has an
  embedding model, the app also asks the server for hybrid search (keyword plus vector similarity)
  and merges its extra hits below what you already see. A device never runs a model itself. If
  the server takes longer than 6 seconds, you keep the local results.
- Semantic search is off until you configure an embedding model on the server. See
  [Self-hosting](self-hosting.md#semantic-search-with-ollama).
- The page switcher (Cmd/Ctrl+O) is fuzzy and accent-insensitive.
- Over the API, `related_find` returns similar pages or blocks by embedding. The app has no
  "related" panel yet.

## Trash and history

- Deleting a page or block moves it to the trash. The trash has no expiry. Restore from the Trash
  view.
- Each page has a history view built from the audit log: who changed what (you, an agent's token
  label, sync), with undo of one change and "restore this version".

## Import and export

- `nooklet import <dir>` reads a Logseq **file graph**: journals, pages, properties, front matter,
  `id::` block ids (mapped to nooklet ids, with references rewritten), org-style `SCHEDULED:` and
  `DEADLINE:` lines, and `config.edn`'s journal format and task workflow. The newer Logseq DB
  version's export is not a supported source.
- Running import again skips pages that already exist; it does not update them.
- The markdown mirror writes every page as it changes. `nooklet export` rewrites all of it.

## Plugins

- A plugin is a directory with a manifest and an optional server half and client half. The server
  half can add operations (which also become HTTP routes and, if enabled, MCP tools), hooks,
  scheduled jobs and settings; the client half can add commands, slash items, code-block renderers
  and status items.
- **Partial:** the app loads client halves only for the built-in plugins, which are compiled into
  the web build. A plugin you drop into a graph's `plugins/` directory runs its server half; its
  client half is not loaded yet.
- Plugins are trusted code: a server half runs inside the server process with full access. Install
  only plugins you have read.
- Built-in plugins: `mermaid` (diagrams in code fences), `word-count` (an MCP tool and a command),
  `daily-summary` (off by default).
- Manage them with `nooklet plugin list|enable|disable|reload`.

## Apps and devices

- **Web client.** The server serves it. It works as an installable PWA and keeps its replica in the
  browser's origin-private file system (OPFS). It needs a secure context: HTTPS, or `localhost`.
- **macOS desktop app.** A Tauri window. It runs its own bundled server on port 6100 with the data
  directory `~/.nooklet/default` (or `$NOOKLET_DATA`), and keeps one list of graphs: those on this
  Mac and those on servers (device tokens in the macOS Keychain). The graph menu (or menu bar →
  Graphs…) switches between them without a restart; **Add a graph** creates one on this Mac or
  connects to one on a server, checking the token before it is saved, and can list a server's
  graphs with its root token. A graph on this Mac can be deleted (typed confirmation); its folder
  goes to the macOS Trash.
- **iOS app.** A Capacitor shell around the same client. It can run "Just this device" with no
  server, or sync with one. You build and sign it yourself in Xcode today. **Partial:** tested on
  the iOS Simulator and one physical iPhone; phone layout issues are being fixed.
- **Capture from anywhere on the phone.** `nooklet://capture` links, long-press the app icon (New
  note, Today, Search), "Add to nooklet" in Shortcuts, Siri, Spotlight and the iPhone Action Button
  (works without opening the app), and Android's share sheet. See
  [Capturing from anywhere on the phone](capture.md). **Partial:** verified on the iOS Simulator;
  the Action Button, Siri and Android have not run on a device.
- **Multiple graphs.** One server hosts any number of graphs, each under `/g/<graph-id>/` with its
  own database, mirror, assets and tokens. A device keeps a list of graphs and switches between
  them; a local-only graph can be promoted to a new graph on a server. Two populated graphs are
  never merged.

## Agents

An MCP server and an HTTP API with OpenAPI, covering reading, writing, refactors, search, trash,
history and undo, plus optional live control of an open window. See [For AI agents](agents.md).

## Known gaps

The full list is [docs/BUGS.md](../BUGS.md). Notable open items as of October 2026: a synced block
can render with invisible text until you open it; the slash menu does not open on the phone; a
same-block edit conflict shows the losing text as a `conflict_copy::` property (being changed to
readable blocks); page icons have no emoji picker yet.
