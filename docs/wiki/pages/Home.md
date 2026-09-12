type:: guide
summary:: What nooklet is, in its own README's words, and where everything in this wiki lives.
tags:: guide

- nooklet is a note-taking app in the tradition of Logseq, Roam and Obsidian: everything is a bullet in an outline, pages link to each other with `[[wiki links]]` and `#tags`, and those links turn the notes into a graph you can walk backwards through.
- Built around four things:
  - **Open source and self-hosted.** MIT licensed. Your notes live in a SQLite database on your own disk, with a plain-markdown export you can walk away with. No account, no cloud, nothing phones home.
  - **Simple on purpose.** An outliner, tasks, links, search. No flashcards, no kanban boards, no whiteboards.
  - **Syncable, if you want it.** One machine and nothing else is a perfectly normal way to run it. When you want more, run the server wherever you like — a laptop, a home server, a VPS behind Tailscale — and every device keeps a full local copy that works offline and reconciles when it reconnects. See [[Sync]].
  - **AI as a first-class citizen, and entirely optional.** Agents can read and write the graph over MCP with real precision, search it by meaning, and — if you let them — see and drive the window you have open. Every bit of it is off until you switch it on, and nothing degrades if you never do. See [[Agents and MCP]].
- Nothing here is mandatory. Install it, write notes, and that is the whole product. Sync needs a second device you choose to pair; AI needs a token you choose to mint; semantic search needs Ollama you choose to install. Skip all three and nothing is missing or nagging you to enable it.
- **Status: early.** It works, it is tested, and its author uses it daily. Expect rough edges and breaking changes before 1.0. macOS is the supported platform today; Linux builds are best-effort and Windows is not built yet.
- ## Start here
  - [[Getting started]] — install the desktop app or run from source, then write the first journal entry.
  - [[Concepts]] — pages, blocks, journals, references, tags, properties, namespaces, and the editor's two states.
  - [[Keyboard shortcuts]] — every command and its default key, generated from the code.
- ## Using it
  - [[Journals]] · [[Tasks]] · [[References and tags]] · [[Search]] · [[Settings]]
  - [[Import from Logseq]] — what carries over from a Logseq file graph, and what does not.
  - [[Sync]] — running the server for more than one device, and what a second device does.
  - [[Agents and MCP]] — the tool list, connecting Claude Code and Claude Desktop, and what "let agents view this window" means.
- ## Reference
  - [[Command line]] — every `nooklet` subcommand, from the CLI's own help.
  - [[Markdown format]] — the outline format the export, the importer and the API share.
  - [[Architecture]] — how it is built, with the decision records by number.
  - [[Troubleshooting]] · [[FAQ]] · [[Contributing]]
- ## About this wiki
  - This wiki is itself a nooklet graph: `docs/wiki/` in the repository is a Logseq-style file graph that `nooklet import` loads, so the docs are read in the tool they describe. Pages are grouped by a `tags::` property into [[guide]], [[reference]] and [[concept]].
  - Everything here is derived from the repository. Where the code and the older design documents disagree, the code wins and the page says so.
