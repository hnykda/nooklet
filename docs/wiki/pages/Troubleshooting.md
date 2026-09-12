type:: guide
summary:: What the top-bar indicator means, stale builds, ports and data directories, second tabs, tokens, and where to look when the app says nothing.
tags:: guide

- First stop: **Diagnostics** — click the sync indicator in the top bar. It shows whether the client has a token and reached the API, the sync state, index sizes, whether `sqlite-vec` loaded, and the embedding backlog. Every early bug that "did nothing" turned out to be visible there (B-01, B-11), and a bug report that includes it is answered faster ([[Contributing]]).
- ## What the indicator says
  - `synced` — nothing pending. `syncing (n)` — n ops waiting to be pushed. `offline` — the server did not answer the last push or pull; edits keep going into the local database and are pushed when it is back.
  - `not saved locally` — the browser could not open its local database (OPFS unavailable: some private modes, some embedded web views, Playwright's WebKit), so this session runs in memory and evaporates on reload. With a server reachable nothing is lost, but do not treat that tab as storage (B-43).
  - `synced via another tab` — a second tab of the same graph; the first tab keeps the local copy and this one relays through the server. Fine to use. To make it the primary, close the other tab and reload (B-81).
- ## Stale build
  - A fix you know is in the code "doesn't work", or the app looks like last week: the client is a PWA and a browser can keep serving the build it first cached. Hard-reload twice, or DevTools → Application → Service Workers → Unregister, then reload (B-20). Running from source, rebuild the client (`pnpm --filter @nooklet/web build`) and restart `serve`; the desktop app shows whatever the server on port 6100 serves.
  - `serve` prints `app not served — build it`: the client build is missing. Run the build line, or pass `--web <dir>`.
- ## Ports, data directories, tokens
  - Something else is on 6100: `nooklet serve --port <n>`. The desktop app always looks for 6100 and reuses a `nooklet serve` it finds there rather than starting its own.
  - The sidebar lists pages that search cannot find, or the app stops on a graph-mismatch screen: the browser's local replica is keyed by origin (`127.0.0.1:6100`), so pointing that address at a different `--data` directory leaves the browser holding the old graph's copy. The app detects the mismatch and asks rather than wiping, because the local copy may hold unpushed edits (B-30). Use one port per data directory.
  - A token is handed out automatically only to a browser on the same machine as the server. From any other device you get the Connect screen and paste one ([[Sync]]). A plain LAN IP (`http://192.168…`) cannot run the client at all — it is not a secure context; use HTTPS or a tailnet (B-27).
  - `403` from another machine: `--host` is set but `--allow-host` does not name the address you are using ([[Sync]]).
- ## Search and embeddings
  - "Couldn't search": check the token in Diagnostics first. A failed search shows an error with Retry rather than "Searching…" forever (B-80).
  - Semantic search returns keyword results ("Fell back to keyword search"): no model is active. Settings → Search & embeddings ([[Search]]). If it says `sqlite-vec` did not load, the server cannot store vectors at all.
  - Semantic hits look thin or stale: check the pending count in Settings — indexing runs in the background; "Re-index everything" rebuilds it.
- ## Editing
  - Typing goes nowhere, and Tab or Backspace do nothing either: focus is not in the editor. Click the block again. Three separate reports were one focus bug (B-15); the giveaway was that Backspace did not work.
  - A `[[link]]` you just typed cannot be clicked: the block is still being edited. Click elsewhere to leave editing, then click the link — or Cmd/Ctrl+click, or Alt+Enter, while editing.
  - Escape did something unexpected: it closes whatever is on top first — a popup, the context menu, the palette — and only then leaves editing (B-72).
- ## Sync and data
  - "device clock is wrong": the device's clock is more than 60 s ahead of the server's. Fix the clock (ADR 003).
  - A block under "Unplaced": two devices made a cycle; the server corrects it within a sync round trip.
  - A device stuck behind: check its `acked_seq` (`sqlite3 graph.sqlite "SELECT id, name, acked_seq, last_seen_at FROM device"`) and re-bootstrap it from a snapshot (`docs/OPERATIONS.md` §7).
  - Suspected corruption: `nooklet verify` names the table, row and column that disagree with the op log. After a `gc` some divergence is expected and labelled as such.
- ## Lessons the bug log keeps
  - A green unit suite proves nothing about the served app; `pnpm e2e` is what catches integration bugs — six bugs shipped past 1,180 passing tests (`docs/BUGS.md`).
  - When a verified fix "doesn't work" for someone, suspect the delivery path — the cached build, the port, the data directory — before the code (B-20, B-30, B-34, B-36).
  - A command that does not say it writes must not write: `backup` and `verify` once migrated the database just by opening it (B-39).
  - "It doesn't update" is usually a resource that returned a stable value instead of a version stamp (`apps/web/src/data/store.ts`, B-05).
