type:: guide
summary:: What the Settings panel offers — theme, journal date format, semantic search, about — and where the other knobs live.
tags:: guide

- Open with Cmd/Ctrl+, the `?` button in the corner → Settings, or "Open settings" in the command palette. It is a panel over the current view, not a route.
- ## Appearance
  - **Theme**: Light, Dark, System. System follows the OS. Stored per device; `Toggle theme` in the palette cycles it.
  - **Journal date format**: how journal days are titled on screen — `Sep 7th, 2026`, `September 7th, 2026`, `2026-09-07`, `Mon, 07.09.2026`, `Monday, 07.09.2026`, `Monday, Sep 7th, 2026`, `07.09.2026`. Stored per device. The stored page name stays the ISO date, so links, search and the markdown export are unaffected (ADR 018). After a Logseq import the graph's own format is offered as the initial value, and appears in the list even when it is not one of the presets. See [[Journals]].
- ## Search & embeddings
  - Whether semantic search is Off, Indexing… or On, with provider, model, dimensions and embedded/pending counts, and buttons to turn it on, change the model, and re-index everything. [[Search]] has the walkthrough.
- ## About
  - Server URL, graph id, data directory, version, and a button to Diagnostics.
- ## Diagnostics
  - Click the sync indicator in the top bar, or "Open diagnostics" in Settings. It shows whether the client has a token and reached the API, the sync state, page/block/op counts, whether the full-text index is populated, whether `sqlite-vec` loaded, and the embedding model and backlog. It exists because every backend failure before it was invisible (B-11). See [[Troubleshooting]].
- ## Agent access to this window
  - The badge in the top bar, not a settings page: "Let agents view this window" (on by default) and "Let agents control this window" (off by default), per window, with a recent-activity log. See [[Agents and MCP]].
- ## Settings that live elsewhere
  - The data directory, port and host: flags to `nooklet serve` ([[Command line]]).
  - Tokens for agents and devices: `nooklet token` ([[Command line]], [[Sync]]).
  - Keybindings: designed as a synced `keybindings.json` (ADR 009); no editing UI yet ([[Keyboard shortcuts]]).
  - Favourites and page icons are page properties (`favorite`, `icon`), set from the Pages view and the page header. They sync with the graph, and an agent can read or set them like any other property.
  - Plugins: `nooklet plugin list|enable|disable|reload` ([[Command line]]); the `Open plugin manager` command exists in the palette.
