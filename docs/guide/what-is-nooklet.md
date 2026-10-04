---
title: What nooklet is
description: A local-first outliner in the spirit of Logseq, built so AI agents can read and write your notes properly.
order: 1
---

# What nooklet is

nooklet is an outliner for one person with several devices. You write in nested bullets, link
pages with `[[wiki links]]` and `#tags`, and walk the graph backwards through references. If you
have used Logseq, Roam or Obsidian's outliner, you know the shape.

It is open source (MIT), self-hosted, and early. The author uses it daily. Expect rough edges and
breaking changes before 1.0.

## Who it is for

- You keep a daily journal and a pile of linked pages, and you want them on your own disk.
- You use more than one device and want them to agree without a cloud account.
- You want an AI agent (Claude Code, Cursor, anything that speaks MCP) to search, read and edit
  your notes block by block, instead of pasting whole pages into a chat.
- You have a Logseq file graph and want to bring it along.

## What makes it different

**Local-first.** Every device holds a full SQLite copy of the graph and works offline. Edits queue
on the device and sync when it reconnects. A server is optional: one machine with no server is a
normal way to run nooklet.

**Agents are first-class users.** One registry of operations drives the HTTP API, the OpenAPI
document, the MCP tools and the typed client. An agent gets the same operations the app uses:
search (keyword, semantic or hybrid), read a page with stable block ids, append markdown, edit an
exact substring inside one bullet, run an atomic batch, and undo that batch. With a separate
permission it can also see and drive a window you have open. See [For AI agents](agents.md).

**A markdown mirror you can walk away with.** The server writes every page to a plain markdown file
with a stable `^id` on each block. Logseq and Obsidian can open those files, and `grep` and `git`
work on them. The files are a copy: SQLite holds the truth and the op log carries sync. See
[How it works](how-it-works.md).

**Everything optional is off.** Sync needs a device you choose to pair. AI access needs a token you
choose to mint. Semantic search needs an embedding model you choose to run. Skip all three and you
have a local outliner with a markdown mirror.

## Non-goals

The scope stays small on purpose. These are not planned:

- flashcards or spaced repetition
- kanban boards, whiteboards, or other "views" of the graph as a canvas
- real-time co-editing with cursors
- multi-user accounts and permissions (one owner, many devices)
- end-to-end encryption (it would block server-side search, embeddings and MCP)
- Logseq's Datalog `{{query}}` blocks, org-mode, LOGBOOK time tracking
- a hosted service or a plugin marketplace

If you want one of these, open an issue and argue for it. A clear "no, because" beats an issue that
sits open forever.

## Platforms

| Platform | State |
|---|---|
| Server (`nooklet serve`) | macOS and Linux. Node 24 or newer. Container image in `deploy/docker/`. |
| Web client | Any modern browser, served by the server. Needs a secure context (HTTPS or `localhost`). |
| macOS desktop app | Tauri shell; supported. Build from source today. |
| Linux desktop app | Best-effort builds. |
| Windows | Not built. |
| iOS app | Capacitor shell; builds and runs. Build it yourself in Xcode. Phone UI is being improved. |
| Android | No project yet. |

Next: [Features](features.md) for a tour, or [Getting started](getting-started.md) to run it.
