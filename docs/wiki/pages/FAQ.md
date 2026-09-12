type:: guide
summary:: Short answers to the questions the README, the plan and the bug log keep answering.
tags:: guide

- **Do I need a server?** One is always running — the desktop app starts it for you, or you run `nooklet serve`. You do not need one anywhere else unless you want a second device. [[Sync]]
- **Is anything sent anywhere?** No. The server binds to localhost, semantic search uses a model on your own machine, and nothing phones home. Sync only goes to a server you run.
- **Where are my notes?** `graph.sqlite` in the data directory (`~/.nooklet/default` by default), plus `assets/`. `nooklet export` writes them out as markdown next to it. [[Architecture]], [[Markdown format]]
- **Can I edit the markdown files in another editor?** Not today: the export is a snapshot, not watched. Edit in the app or over the API. [[Markdown format]]
- **Can I open the export in Logseq or Obsidian?** Yes — it is outline markdown they both read, with Obsidian-style `^id` block ids. Importing back is for Logseq file graphs only. [[Import from Logseq]]
- **Where did my `NOW` and `LATER` tasks go?** Nowhere: they are kept as their own markers and count as open. [[Tasks]]
- **Why is a journal called 2026-09-07?** That is its stored name; pick a display format in Settings. [[Journals]]
- **Why does `[[Page|text]]` not show up in backlinks?** Known bug B-86. [[References and tags]]
- **How do I let Claude read my notes?** Mint a token, add the MCP server to Claude Code or Claude Desktop. [[Agents and MCP]]
- **Can an agent break things?** Every write is attributed and undoable as a batch; `page_delete` is flagged for the user's say-so; a `write` token cannot see or drive your screen without `--ui-control` and the window's own consent toggle. [[Agents and MCP]]
- **Why no flashcards, boards, whiteboards?** Non-goals, on purpose. [[Contributing]]
- **Templates? Query blocks?** Both are M7 work in flight in the tree at the time of writing (a template command and a ```` ```query ```` fence); ADR 011 fixes the query syntax. Not documented here until they land.
- **Phone?** The PWA works, with a keyboard toolbar and a quick-capture route. A store app (Capacitor) is a config file with no build pipeline and has never run on a device (`docs/PLAN.md` M5). macOS desktop is the shipping target.
- **How do I back up?** `nooklet backup` writes one `.tar.gz`; copy it off the machine. `nooklet restore` brings it back. [[Command line]]
- **Something is wrong and the app says nothing.** Click the sync indicator: Diagnostics. [[Troubleshooting]]
- **Is it finished?** Every milestone through M6 is marked done in `docs/PLAN.md`; M7 — the things Logseq users ask for most — is in progress; the README says early, rough edges, breaking changes before 1.0.
