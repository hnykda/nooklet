type:: reference
summary:: Every nooklet subcommand and flag, from the CLI's own usage text (packages/server/src/cli.ts), with what each one does.
tags:: reference

- From source every command is `pnpm nooklet <command>`, which runs `tsx src/cli.ts` with `packages/server` as the working directory — so **paths you pass must be absolute** (a relative `docs/wiki` resolves to `packages/server/docs/wiki`; `~` is fine because the shell expands it). A packaged install has a `nooklet` binary.
- `--data <dir>` on every command picks the data directory: `$NOOKLET_DATA`, then `~/.nooklet/default`. Everything nooklet owns lives there ([[Architecture]]).
- Every command except `serve` is a separate, short-lived process that opens the same database file and exits. Safe to run while `serve` is up (SQLite WAL mode), except `restore`.
- ## Usage
  - ```
    nooklet serve  [--data <dir>] [--port <n>] [--web <dir>]
                   [--host <addr>] [--allow-host <h,h>]   expose on a LAN/tailnet
    nooklet import <logseq-graph-dir> [--data <dir>]
    nooklet export [--data <dir>]
    nooklet mcp --stdio [--token <token>] [--data <dir>]
    nooklet token create --label <label> [--scope read|write|admin] [--sync] [--ui-control]
    nooklet token list
    nooklet token revoke <token-id>
    nooklet embed status
    nooklet embed run
    nooklet embed model <name> [--provider ollama|openai-compat] [--host <url>]
    nooklet plugin list
    nooklet plugin enable <plugin-id>
    nooklet plugin disable <plugin-id>
    nooklet plugin reload <plugin-id>
    nooklet backup [--out <path>] [--data <dir>]
    nooklet restore <archive> [--data <dir>] [--force]
    nooklet gc [--dry-run] [--no-backup] [--asset-grace <days>] [--data <dir>]
    nooklet verify [--data <dir>]
    nooklet repair org-dates [--apply] [--data <dir>]   dry run unless --apply
    ```
- ## serve
  - Runs the HTTP API, the MCP endpoint, sync and the web client in one Node process, port 6100 by default. Prints the URLs — `http` (`/api/v1`), `mcp` (`/mcp`), `spec` (`/openapi.json`), `sync` (`ws://…/sync/live`) and `app` — or, if the client is not built, says so (`pnpm --filter @nooklet/web build`, or point at a build with `--web <dir>`).
  - `--host 0.0.0.0` binds beyond loopback; from then on only requests addressed to a name in `--allow-host` are accepted and everything else is 403 ([[Sync]]).
  - Unless `NODE_ENV=production`, startup replays the whole op log into a scratch database and diffs it against live state — the same check as `verify` — and logs the result without ever refusing to start.
  - `serve` also keeps the markdown mirror current: after each commit, and once on start, changed pages are rewritten under `<data>/pages/` and `<data>/journals/` (B-95). `--no-mirror` is meant to turn that off and does not, because the parser only understands `--flag` and `--flag value`, so it sets a `no-mirror` flag nothing reads ([[Markdown format]]).
- ## import, export
  - `import` is [[Import from Logseq]]. It migrates the database first, imports, then prints the statistics as JSON.
  - `export` writes the whole graph as markdown into `<data>/pages/` and `<data>/journals/` in the outline format ([[Markdown format]]) and prints what it wrote. `serve` keeps the same files current on its own; `export` is for a full rewrite on demand. Editing the files changes nothing in the graph — there is no watcher in that direction.
- ## mcp --stdio
  - The bridge Claude Desktop launches: MCP over stdin/stdout, opening the data directory's database directly ([[Agents and MCP]]). `--token` is the token it acts as; the `ui_*` tools are listed when that token has `--ui-control`.
- ## token
  - `create --label <l>` prints the raw token once; only a hash is stored. `--scope read` (default), `write` or `admin`; `--sync` makes it a device credential that may push and pull; `--ui-control` adds the live-window capability (ADR 015). `list` shows every token; `revoke <id>` ends one.
  - Rotating: create `<name>-v2` with the same flags, move the consumer over, confirm it works, revoke the old id (`docs/OPERATIONS.md` §8).
- ## embed
  - `status` (model, dimensions, indexed and pending counts), `run` (drain the queue now), `model <name>` (register a model and switch to it; `--provider`, `--host`). The Settings panel does the same without a terminal ([[Search]]).
- ## plugin
  - `list` (discovered plugins and any manifest errors), `enable`, `disable`, `reload`. Plugins are looked for in `<data>/plugins/` and, when running from source, in the repository's `plugins/` (`daily-summary`, `mermaid`, `word-count`).
- ## backup, restore
  - `backup` writes one `.tar.gz` — a consistent `VACUUM INTO` snapshot of the database, `assets/`, and a manifest — to `<data>/backups/` or `--out`. Safe while `serve` runs. Nothing schedules it; use cron or launchd, and copy the file off the machine.
  - `restore <archive>` refuses to overwrite an existing database unless `--force`, and refuses an archive from a newer schema than the build understands. **Stop `serve` first.** Do the restore drill in `docs/OPERATIONS.md` §3 once, so you trust it.
- ## gc, verify
  - `gc` trims the op log down to what every device has already pulled (`min(device.acked_seq)`), taking a backup first unless `--no-backup`; `--dry-run` only reports. It refuses when no device has ever synced or some device has never pulled. `--asset-grace <days>` governs orphan-asset removal (M7).
  - `verify` replays the op log and diffs every state row against live state, naming the table, row, column and both values on a divergence. The best regression detector in the system. After a `gc` some divergence is expected and labelled as such.
- ## repair org-dates
  - For a graph imported before B-143: turns Logseq `SCHEDULED: <2023-2-17 Fri>` / `DEADLINE:` lines still sitting in block text into the block's real dates and removes the line. Prints every block before and after and writes nothing; `--apply` writes them all as one batch and prints its `batch_id`, which `batch_undo` reverses. A block whose text disagrees with a date it already has is left alone and listed. Quit the app first (`docs/OPERATIONS.md` §10).
- Upgrading: back up, update the code, run any command — the database migrates itself forward (additive, forward-only, replay-safe). There is no `migrate` command (`docs/OPERATIONS.md` §4).
