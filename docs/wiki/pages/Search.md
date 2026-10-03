type:: guide
summary:: Keyword search is always on; semantic search is optional, runs on a model you host yourself, and is switched on from Settings.
tags:: guide

- ## Finding a page
  - Cmd/Ctrl+O opens the page switcher: fuzzy match over page names and aliases, accent-insensitive (`č` matches `c`); a journal is found by `2026-09` and by `Sep 7th` alike. Cmd/Ctrl+K — or "Command palette", the first row of the sidebar, which is how a phone gets there — opens the command palette, which mixes pages and commands; type `>` first for commands only, `#` for tags.
- ## Searching content
  - Cmd/Ctrl+Shift+F, or sidebar → Search, opens the search view (`/search`) with a mode toggle: **hybrid** (default), **keyword**, **semantic**. Each hit shows the block or page, a snippet with the match highlighted and a breadcrumb; clicking opens it.
  - Keyword search is SQLite FTS5 with diacritics removed, plus a trigram index for substring matches. The query language is a search box, not FTS5 syntax (B-53): words, `"quoted phrases"`, `-exclusions`, `prefix*`. `c++`, `e-mail` and `what's` are searched for, not parsed.
  - Hybrid fuses keyword and semantic results by reciprocal rank fusion (ADR 010). With no embedding model active, hybrid and semantic fall back to keyword and the view says "Fell back to keyword search".
  - Over the API and MCP the same `search` tool adds filters — tags, exact `properties` (`{"marker": "TODO"}`), a namespace, specific pages, journals only, updated after/before — and pagination. See [[Agents and MCP]].
- ## Turning on semantic search
  - Semantic search finds notes by meaning, across languages — the default model `bge-m3` covers Czech and English — using an embedding model you run yourself. Nothing leaves your machine. It is off by default and keyword search is unaffected either way.
  - Install Ollama and pull a model: `ollama pull bge-m3`.
  - Open Settings (Cmd/Ctrl+, or the top bar's `⋯` menu → Settings) → **Search & embeddings** → **Turn on semantic search…**. Provider `Ollama`, server URL `http://127.0.0.1:11434`, model `bge-m3`, then **Test connection & enable**. nooklet asks the provider for the model's vector size before storing anything, so a wrong URL or an unpulled model fails right there with a message rather than halfway through indexing (B-38).
  - Indexing runs in the background on the server. The panel shows embedded and pending counts and semantic search switches itself on once the backfill drains. Afterwards the same section offers **Change model…** and **Re-index everything**.
  - An OpenAI-compatible provider — LM Studio, llama.cpp, a hosted API — can be chosen instead of Ollama in the same form.
  - From a terminal: `nooklet embed status`, `nooklet embed run`, `nooklet embed model <name> [--provider ollama|openai-compat] [--host <url>]` ([[Command line]]).
  - If the panel says the `sqlite-vec` extension did not load, vectors cannot be stored on that server; no switch is offered and search stays keyword-only. Diagnostics (click the sync indicator) shows the same fact.
- ## Related items
  - "What is near this by meaning" is the `related_find` tool over the API and MCP; it needs an active model.
- Embeddings never sync to other devices; semantic search is always answered by the server (ADR 010).
