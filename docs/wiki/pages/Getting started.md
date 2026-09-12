type:: guide
summary:: Install the desktop app or run from source, open the app, and write the first journal entry.
tags:: guide

- ## The desktop app (macOS)
  - Download the `.dmg` from the GitHub Releases page, or `brew install --cask hnykda/tap/nooklet`.
  - The app is self-contained. It ships a Node runtime, the server bundled to one file, the `sqlite-vec` extension and the built web client (`apps/desktop/build-sidecar.mjs`), and starts the server itself on launch (`apps/desktop/src-tauri/src/main.rs`). If a `nooklet serve` is already listening on port 6100 it uses that one rather than opening the same database twice.
  - The window loads `http://127.0.0.1:6100`, the same client a browser gets. There is no second copy of the UI to drift out of date.
  - ADR 016 describes a v1 that points at a separately started server and leaves bundling for v2; the build has since done the bundling. The README is right; the ADR's "v1" paragraph is superseded by the code.
  - Linux builds are best-effort; Windows is not built yet.
- ## Run from source
  - Needs Node 24 or newer (`engines` in the root `package.json`; the project develops on Node 26, ADR 001) and pnpm 12.
  - ```sh
    pnpm install
    pnpm --filter @nooklet/web build
    pnpm nooklet serve
    ```
  - Then open http://127.0.0.1:6100. `serve` prints the URLs it listens on; if it prints `app not served — build it`, the client has not been built yet.
  - `pnpm nooklet` runs the CLI from source (`pnpm --filter @nooklet/server exec tsx src/cli.ts`, root `package.json`). Every command on [[Command line]] works as `pnpm nooklet <command>`; a packaged install calls `nooklet` directly.
  - The data directory defaults to `$NOOKLET_DATA`, then `~/.nooklet/default` — the same graph the desktop app opens. Pass `--data <dir>` to use another one.
- ## The first journal entry
  - The app opens on the journal stream: today at the top, earlier non-empty days below. Today is virtual until you type into it; an empty day is never stored.
  - Click the empty bullet under today's date and type. Enter makes a new bullet, Tab indents it, Shift+Tab outdents, Shift+Enter breaks a line inside the bullet.
  - Type `[[` to link to a page, existing or new; `#` for a tag; `((` for a block reference; `/` at the start of a line for the slash menu; `TODO ` at the start of a bullet for a task, or Cmd/Ctrl+Enter to cycle one.
  - Text is written to the local database as you type (debounced about half a second, flushed when you click away or leave the page). The indicator in the top bar reads `synced` when nothing is pending; [[Troubleshooting]] explains the other things it can say.
- ## Bring a Logseq graph
  - `pnpm nooklet import ~/path/to/graph` imports a Logseq file graph into the default data directory. Read [[Import from Logseq]] first; it says what carries over and what does not.
- ## Next
  - [[Concepts]] for the vocabulary, [[Keyboard shortcuts]] for the keys, [[Settings]] for the theme, the journal date format and semantic search.
