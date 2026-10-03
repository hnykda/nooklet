# Operating nooklet

A runbook for whoever is running `nooklet serve` for themselves — probably future-you, a year
from now, having forgotten most of this. Design rationale lives in `docs/adr/` and
`docs/spec/`; this document is deliberately just "what do I actually type."

## 1. Running the server

```sh
nooklet serve [--data <dir>] [--port <n>]
```

`--data` picks the data directory: it defaults to `$NOOKLET_DATA`, then `~/.nooklet/default`.
Everything nooklet owns lives under it (see §2). `--port` defaults to 6100.

`nooklet serve` prints the URLs it's listening on:

```
nooklet serving ~/.nooklet/default
  http  http://127.0.0.1:6100/api/v1
  mcp   http://127.0.0.1:6100/mcp
  spec  http://127.0.0.1:6100/openapi.json
  sync  ws://127.0.0.1:6100/sync/live
```

It's a single Node process, single writer connection to SQLite (WAL mode). There's no
supervisor/systemd unit shipped — run it under whatever you already use to keep a process alive
(`systemd --user`, `launchd`, `pm2`, a `screen`/`tmux` session, or just a terminal tab on a
machine that doesn't sleep). Ctrl-C / `SIGTERM` shuts it down cleanly (stops the embedding
indexer, then exits).

Every command below (`backup`, `restore`, `gc`, `verify`, `token`, `plugin`, `embed`, `import`,
`export`) is a **separate, short-lived** `nooklet <cmd>` invocation, not something you send to the
running `serve` process. They open their own connection to the same database file and exit when
done — safe to run while `serve` is up (SQLite's WAL mode is exactly what makes that
work), except where noted otherwise (`restore`, below).

Startup also runs a self-check in dev: if `NODE_ENV` isn't `production`, `serve` replays the
whole op log into a scratch database and diffs it against live state before opening any port
(same thing `nooklet verify` does — see §5). It never blocks or fails startup, it just logs the
result; if it reports a divergence, treat that as a real bug report (see §5's own section).

## 2. Data directory layout

```
<data>/
  root.token              the /graphs root token (`nooklet token root`; ADR 025)
  graphs/<id>/            one directory per graph; `default` unless you made others (ADR 025)
    graph.json            what makes the directory a graph (id, label); `serve` adopts a
                          graph.sqlite that lacks one (B-607)
    graph.sqlite          the database (WAL mode: also graph.sqlite-wal, -shm alongside it)
    assets/               uploaded files (asset_upload), named <id>.<ext>
    pages/  journals/     the markdown mirror (ADR 002) -- a read-through copy for Logseq/
                          Obsidian/grep/git, NOT the source of truth and NOT the sync medium
    plugins/              installed plugins (each a directory with a manifest -- ADR 007)
    backups/              default destination for `nooklet backup` (see §3)
```

Every command except `serve` works on one graph, `--graph <id>` (default `default`). On a fresh
data dir any of them creates the default graph, so importing or minting tokens before the first
`serve` is fine. Any other graph must already exist (create it with `POST /graphs` or from the app).

Everything that matters is `graph.sqlite` + `assets/`. `pages/`/`journals/` are regenerated from
the database (delete them and they'll be rewritten); `plugins/` is regenerated from whatever
you've installed (it's config/code, not data — back it up separately with your dotfiles if you
hand-edit anything there).

## 3. Backup and restore

### Taking a backup

```sh
nooklet backup [--out <path>] [--data <dir>]
```

Produces one `.tar.gz` file — a real, standard tar archive; `tar tzvf` works on it — containing:

- `manifest.json`: archive format version, the database's schema version, and when it was taken.
- `graph.sqlite`: a **consistent snapshot** of the live database, taken with `VACUUM INTO`
  (SQLite's own online-backup primitive). This works correctly against a live, in-use database —
  it does not stop the server, hold a long lock, or need a maintenance window — and was verified
  through this project's actual driver (`node:sqlite`'s `DatabaseSync`), including a snapshot
  taken while a separate connection had an open write transaction: the backup reflects exactly the
  last *committed* state, nothing torn, nothing from the in-flight write.
- `assets/**`: every file currently under `<data>/assets/`.

Without `--out`, it lands at `<data>/backups/nooklet-backup-<timestamp>.tar.gz`. Copy that file
somewhere off-machine (that's the whole point of a backup) — nooklet doesn't do this for you.

Run it on a schedule (cron, a `launchd` plist, whatever) if you want regular backups; there's
nothing time-based built in.

### Restoring a backup

```sh
nooklet restore <archive> [--data <dir>] [--force]
```

**Stop `nooklet serve` first.** Restore writes directly to `<data>/graph.sqlite` and
`<data>/assets/`; doing that while the server holds the database open is asking for trouble.

By default, restore **refuses to overwrite** an existing database or any existing asset at the
target `--data` directory — you'll get a clear error naming the directory. Pass `--force` once
you're sure. It also refuses an archive whose schema version is *newer* than the running build
understands (you'd need to upgrade nooklet first); an *older* archive restores fine — the normal
migration path (§4) brings it forward the next time it's opened.

```sh
nooklet restore ~/backups/nooklet-backup-2026-09-10T12-00-00-000Z.tar.gz --data ~/.nooklet/default --force
nooklet serve --data ~/.nooklet/default   # restart once restore reports success
```

### Restore drill (do this once, so you trust it)

1. `nooklet backup --data ~/.nooklet/default`
2. `nooklet restore <the archive> --data /tmp/restore-drill`
3. `nooklet verify --data /tmp/restore-drill` — should report OK.
4. `rm -rf /tmp/restore-drill`

If step 3 doesn't say OK, that's worth investigating *before* you actually need this.

## 4. Upgrading (schema migrations)

`nooklet` tracks its schema with `PRAGMA user_version` plus a `schema_migration` audit table
(one row per migration ever applied, with a human description — `SELECT * FROM schema_migration
ORDER BY version` in `sqlite3 graph.sqlite` if you're curious what's been run). Migrations are:

- **additive only** — new tables/columns/indexes, never a dropped or renamed column;
- **forward-only** — no down-migrations; a bad migration is fixed by a new forward one;
- **replay-safe** — safe to run twice (relevant if a migration crashes mid-way: the next `nooklet`
  invocation just resumes from the last completed step).

Practically, upgrading nooklet is:

1. **Take a backup first** (§3). This is the point of scheduling backups — do it before every
   upgrade too, not just on a timer.
2. Update the `nooklet` code/build you're running.
3. Run any `nooklet` command against the data directory (`nooklet verify` is a good, cheap
   choice). It opens the database, notices `PRAGMA user_version` is behind, and runs every
   pending migration in order automatically, before doing anything else.
4. If it instead prints "database schema version N is newer than this build supports" — you
   downgraded the binary relative to the data. Get the newer build back, or restore an older
   backup taken before you upgraded the data.

There's no separate `nooklet migrate` command — opening the database *is* the migration step.

**The client updates itself.** Once the server serves a new web build, an open page reloads onto
it within seconds (the new service worker takes the page over and a listener in `index.html`
reloads onto it, B-532/B-537), and the desktop app shows it on its next launch — one reload flash,
then the new client. The one exception is the launch that installs a client from before B-537: that
page decides with its old code and, if `/api/session` was slow, shows the old client once more. Two things that look like "the update
did not arrive" and are not:

- The desktop app uses whatever nooklet already answers on its port (6100). If that is a
  `nooklet serve` you started from a checkout, the window gets THAT server's `apps/web/dist`;
  rebuilding the `.app` changes nothing it loads. Rebuild the client that server serves.
- A second copy of the desktop app (a test build) needs its own port and graph:
  `NOOKLET_PORT=6420 NOOKLET_DATA=<a copy> <app>/Contents/MacOS/nooklet-desktop`, and a different
  bundle identifier, or it shares the first copy's WebKit store and service worker.

## 5. `nooklet verify`: the rebuild-parity check

```sh
nooklet verify [--data <dir>]
```

Every state table (`page`, `block`, `block_prop`, `page_prop`) is supposed to be a pure function
of the append-only `op` log (ADR 003). `verify` proves that, right now, for your actual data: it
replays the whole op log into a scratch in-memory database via the same `applyOps`/`rebuild` code
the live server uses, then diffs every row and column against live state. This is the single best
regression detector this system has — most sync bugs show up here before they show up as "my
notes are wrong."

A clean run:

```
verify: replayed 5041 op(s) (seq 1..5041) in 38ms
verify: OK - rebuild() from the op log matches live state exactly.
```

A divergence is reported precisely — never just "mismatch: false" — naming the table, the exact
row (by primary key), the column, and both values:

```
verify: DIVERGENCE - 1 difference(s) between live state and rebuild() from the op log:
  - block[id="1k7f3q9xz2hav4"].content: live="edited via sqlite3 directly" rebuilt="original text"
```

That output is exactly "something wrote to `block.content` without going through `applyOps`" —
start looking there (a bare `UPDATE`/`INSERT` somewhere, a migration that touched state tables
directly, manual `sqlite3` surgery).

It also runs automatically every time `nooklet serve` starts, unless `NODE_ENV=production` — see
§1. Set `NODE_ENV=production` on a real deployment once you trust the setup, to skip the replay
cost on every restart; leave it unset while you're still poking at things.

**After a `nooklet gc`, some divergence is expected, not a bug.** GC (§6) deletes old rows from
the `op` table but never touches state tables — so a full replay from empty can no longer recreate
entities whose *creating* op has been garbage-collected, even though live state still has them
correctly. `verify` detects this itself (op log's minimum `seq` > 1) and prefixes the report with
a note saying so. If you see divergence *without* that note, or divergence for something you
know postdates your last GC, that's the real thing to worry about.

## 6. `nooklet gc`: op-log garbage collection

The op log is kept forever by design (PLAN.md's risk table: it's the input to `verify`, §5). On a
single home server used daily for years, that log is also the single largest thing in the
database file (`docs/spec/sql-schema.md`'s sizing table). `nooklet gc` trims it, safely.

```sh
nooklet gc --dry-run          # report what would happen, change nothing
nooklet gc                    # actually drop old ops and orphan assets (takes a backup first)
nooklet gc --no-backup        # skip the automatic pre-GC backup (not recommended)
nooklet gc --asset-grace 30   # only count an asset as orphaned after 30 unreferenced days (default 7)
```

`gc` and `restore` refuse a flag they do not know (`nooklet: unknown flag --dryrun`) instead of
ignoring it and running for real; `--flag=value` works too (`--dry-run=true`, `--asset-grace=30`).

`nooklet gc` does two independent things: trim the op log (this section) and remove orphan
assets (§6.1). The asset half runs even when the op-log half is refused.

**The floor**: an op is only ever deleted once *every* device has confirmed (by pulling past it)
that it doesn't need it — concretely, `MIN(device.acked_seq)` across every device whose token
hasn't been revoked, capped at the log's current tip. This is exactly the point at which no
legitimate `GET /sync/pull?since=` request from any real device could ever ask for that op again.

**Refusals** (GC prints why and changes nothing):

- *No device has ever synced.* There's no basis yet to know what's safe to delete.
- *Some device has never pulled* (`acked_seq = 0`). Its real position is unknown — it might still
  need everything. Get it to sync at least once (or revoke its token, if it's gone for good),
  then GC again.

**Safety net**: unless you pass `--no-backup`, a real (non-dry-run) GC run takes a full backup
(§3) immediately before deleting anything, using the exact same consistent-snapshot mechanism.
If you ever need the untrimmed log back for some reason, that backup has it.

A GC report looks like:

```
gc: floor=48213 (op.seq < floor) - dropped 40112 op(s), retaining 8101
  backup taken first: ~/.nooklet/default/backups/nooklet-backup-2026-09-10T09-00-00-000Z.tar.gz
  reclaimed 31457280 byte(s) on disk
```

("reclaimed" is a real, measured file-size delta — GC runs a `VACUUM` after deleting rows, since
a bare `DELETE` doesn't shrink the SQLite file on its own.)

### 6.1 Orphan assets

Every pasted image and every file an agent uploads lands in `<data>/assets/<id>.<ext>` with an
`asset` row, and is referenced from block text as `assets/<id>.<ext>` (the importer rewrites
Logseq's links to that form). Delete the block, or edit the link out of it, and the file used to
stay forever — Logseq's most-voted assets request (research/13 §3.1). `nooklet gc` now removes
what nothing points at any more:

- An asset is an **orphan** when no block text or property value mentions it — counting
  **tombstoned** blocks and deleted pages as references too, because the trash never expires
  (ADR 022) and a page restored from it must not come back with broken images — and the upload is
  older than the **grace period**.
- The grace period is **7 days** by default (`--asset-grace <days>`, `0` allowed). The one
  legitimate reason an asset is briefly unreferenced is the gap between the upload and the write
  that embeds it: an agent's `asset_upload` then `block_update`, or a paste in the editor whose
  block op sits in that device's push queue until it next syncs. That queue can wait out a closed
  laptop, so the grace is days, not seconds; a week covers a holiday and a monthly GC still
  collects. Lower it only when you know every device has synced.
- `--dry-run` lists every orphan with its file name, size and upload time. A real run tombstones
  the row (so the same bytes can be uploaded again fresh) and unlinks the file, after the same
  automatic backup as the op-log half — the archive includes `assets/`, so a removed file is
  recoverable from it (§3).

The report's asset line reads:

```
gc: assets - 214 on record, removed 3 orphan(s) (unreferenced for over 7 days); 1 unreferenced but within the grace period, 2 referenced only from the trash - both kept
  removed: assets/1k7f3qa9m2xzr7.png ("Screenshot 2024-11-02.png", 184211 bytes, uploaded 2024-11-02T10:14:07.000Z)
  reclaimed 184211 byte(s) of files
```

Known gap (docs/BUGS.md B-91): uploading bytes identical to an already-orphaned asset returns
that asset without recording anything, so if the device then goes offline before pushing the
block that embeds it, a GC run inside that window can remove it. Rare; the fix is one audit row
on the deduplicated upload, which GC already honours as "recent".

## 7. When sync misbehaves

- **"device clock is wrong" / push rejected outright.** A device's clock is more than 60 seconds
  ahead of the server's. Fix the device's clock; the push will succeed on retry. This is
  deliberate (ADR 003) — a wildly-ahead clock would otherwise win every LWW conflict forever.
- **A block briefly shows up under an "Unplaced" pseudo-node.** Two devices moved the same block
  into a cycle (e.g. A under B and B under A) at close to the same time. The server always
  detects this, picks a winner, and issues a corrective op with a fresh server-authored HLC —
  every device converges within one sync round trip. This is expected, occasional behavior for
  genuinely concurrent edits, not a bug to chase.
- **A device seems permanently behind / missing recent notes.** Check `device.acked_seq` for it
  (`sqlite3 graph.sqlite "SELECT id, name, acked_seq, last_seen_at FROM device"`). If it's stuck,
  the simplest fix is to have that device re-bootstrap from `GET /sync/snapshot` (full current
  state) rather than trying to debug its `pull` cursor.
- **You suspect state and the op log have drifted apart for real** (not the expected post-GC
  case): run `nooklet verify` (§5) and read the precise table/row/column it reports. That's your
  starting point, not a guess.
- **A device you don't recognize, or a lost/compromised device**: revoke its token (§8) — a
  revoked token can't push or pull, and (as of the next GC) stops holding the GC floor down.

## 8. Tokens: creating, listing, and rotating

```sh
nooklet token create --label <name> [--scope read|write|admin] [--sync]
nooklet token list
nooklet token revoke <token-id>
```

The raw token is printed **exactly once**, at creation — copy it into whatever's going to use it
(an agent's MCP config, a device's sync settings) immediately; only its hash is ever stored.
`--sync` marks it usable by `/sync/push`/`/sync/pull`/`/sync/snapshot` (a device credential), as
opposed to a plain API/MCP token for an agent that only calls `/api/v1/*` or `/mcp`.

**Rotating a token** (do this periodically for anything long-lived, and immediately if one leaks):

1. `nooklet token create --label <name>-v2 --scope <same scope> [--sync]`
2. Update whatever holds the old token (agent config, device settings) to the new one.
3. Confirm the new token actually works (an agent call, or a device sync round trip).
4. `nooklet token revoke <old-token-id>` (find the id via `nooklet token list`).

Revoking a token used by a *device* also frees its `acked_seq` from ever blocking `nooklet gc`
again (§6) — a gone-for-good device shouldn't hold the op log hostage forever.

## 9. Pointing an agent at it

See the README's "Connecting an agent" section for the exact config JSON. Summary:

- **Claude Code / Cursor** (anything that speaks streamable-HTTP MCP): mint a token
  (`nooklet token create --label <agent-name> --scope write`), point the client at
  `http://127.0.0.1:<port>/mcp` with `Authorization: Bearer <token>`.
- **Claude Desktop** (can't reach `localhost` directly): configure it to launch
  `nooklet mcp --stdio --token <token> --data <dir>` as a local MCP server process instead.

Give an agent a `write`-scope token unless it only ever needs to read; `admin` is for token
management itself, not day-to-day graph edits. `/openapi.json` (printed at `serve` startup) is
the full HTTP surface if you're wiring up something that doesn't speak MCP at all.

## 10. One-off repairs

### `nooklet repair org-dates`

A graph imported before B-143 (2026-09-13) can still hold Logseq's `SCHEDULED: <2023-2-17 Fri>` /
`DEADLINE: <…>` lines as block text: the old importer only understood two-digit months and days,
so those dates were never stored — no chip, nothing in the Tasks view or a journal's Scheduled and
deadline section.

```
nooklet repair org-dates [--data <dir>]           # dry run: every block, text before and after
nooklet repair org-dates --apply [--data <dir>]   # write it
```

It takes exactly the lines today's importer reads as dates (outside code fences), sets the block's
real `scheduled`/`deadline`/`repeat`, and removes the line. All blocks go in **one batch**, through
the normal write path, so every device syncs it and `nooklet verify` stays exact; the output ends
with the `batch_id`, and `batch_undo` with it (MCP, or `POST /api/v1/batch.undo`) restores every
block. It writes all of it or nothing. A block whose text disagrees with a date it already has, or
names two different dates of one kind, is listed as left alone and not touched. Running it again
finds nothing. Quit the app (or stop `serve`) first: the repair runs in its own process, so a running
server never hears of it — an open window keeps showing the old text (checked for 15 s) until it
reloads, the live mirror stays stale until `serve` restarts, and an edit made in that stale window
can put the line back (`tools/probes/repair-org-dates-open-window.mjs`).
