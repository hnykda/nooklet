# In-app Logseq import

Owner request (2026-10-04): "to import the logseq graph, could we have that as a feature within the
app so the users don't need to run npm commands?"

Branch: `worktree-agent-a0659e9f571d20eb0` (based on `c9d993bb`). Decisions: ADR 031 (and a
pointer amendment on ADR 012).

## Status

- [x] server: import ops, jobs, zip unpacking, importer progress/cancel — `7d447bfd`
- [x] fixes from the scale run (yauzl stream stall, unflagged UTF-8 names), client section,
      e2e, ADR 031, docs, security inventory — second commit on the branch (see `git log`)
- [x] unit tests, e2e for this feature, synthetic scale run
- [ ] real-graph run: **not done** — the real graph's path (`~/notes-graph` here) does not exist on this machine
      (`ls: No such file or directory`, 2026-10-04). Ran a synthetic real-shaped graph instead.
- [ ] iOS Simulator / Tauri desktop window: not run (see "Still unverified")

## Merge with main (DB-version importer)

`git merge main` brought in the DB-version importer (ADR 030, `detectLogseqGraph`), so this work's
ADR is now **031**. The in-app import calls the same `importLogseqGraph`, which detects the format.
The shared allow-list (`packages/core/src/logseq-archive.ts`) now also takes a DB graph's
`db.sqlite`, `db.sqlite-wal`, `mirror/markdown/{pages,journals}/*.md` and `assets/` (root found at
`db.sqlite`; `db.sqlite-shm` and anything else left out); the zip ratio check skips `db.sqlite*`.
Favourite marking now runs under the write lock too. The job summary carries `format` and
`favorites`. Test: `ops/import.http.test.ts` "import a DB-version graph through the app" (main's
synthetic `writeFixtureDbGraph`, zipped, uploaded; counts, assets and favourites equal the CLI's;
image block points at an imported asset). After the merge: `pnpm -r test` core 503, server 951,
web 1674, all passing; typecheck and biome clean; e2e `logseq-import`, `settings`, `commands` 20/20.
The owner's real graph is a DB-version graph; per the coordinator it was not touched.

## What exists

Server (`packages/server/src/`):
- `ops/import.ts` — `import.info|begin|chunk|start|status|cancel`, `admin`, HTTP only.
- `importer/jobs.ts` — `ImportService` (one per `serve` process, attached per graph in `onOpen`),
  staging in `<data>/import-staging/<job>/`, new-graph staging + rename, current-graph rules,
  cancel, reaper, `--import-max-mb`.
- `importer/zip.ts` — central directory via yauzl; names decoded/checked by us; bytes read with
  `readSync` + `inflateRawSync({maxOutputLength})`.
- `importer/logseq.ts` — now async with `onProgress`, `signal`, `runExclusive`, `onPageCreated`.
- `db.ts` — `OpenedDb.close` (staging graph is closed before the rename).

Core: `logseq-archive.ts` (which files are the graph; shared by client and server),
`zip-store.ts` (STORE-only streaming zip writer).

Client: `apps/web/src/data/logseq-import.ts`, `views/ImportSection.tsx` + `import.css`, in Settings
above Devices (not in the graph switcher: another agent is moving that). `bootstrap.ts#addServerGraph`.

## Tests

- `packages/core/src/logseq-archive.test.ts` (root detection, what is kept, traversal names, zip
  writer).
- `packages/server/src/importer/zip.test.ts` — traversal (`../`, absolute, backslash), symlink,
  bomb by ratio, bomb by lying size, total/entry-count limits, non-zip, unflagged UTF-8 names.
- `packages/server/src/ops/import.http.test.ts` — scopes (write/read 403), not on MCP, new graph
  counts == CLI counts + token works + no staging left, existing/invalid id, hostile zip, cancel,
  current graph empty (with an untouched journal page) / non-empty refused, chunk rules, limit,
  one job at a time, other graph's admin cannot see the job.
- `e2e/tests/logseq-import.spec.ts` — folder at desktop width and .zip (made by `zip -r`) at
  390 px; progress view shown; counts on screen == `nooklet import` of the same fixture; Open lands
  in the new graph with its pages.
- `tools/probes/zip-stall.mjs` — reproduces the yauzl stall.

Full `pnpm e2e` (port 6555, 2026-10-04): 803 passed, 5 skipped, 2 failed. `commands.spec` B-98
failed because of this work (the import section, then above Plugins, grew after "Open plugin
manager" had scrolled to Plugins); fixed by placing it after Plugins, and that spec,
`settings.spec`, `logseq-import` and `mermaid-lazy-cache` (the other failure) then passed 22/22.

Not covered by a test: cancelling an import into the *current* graph mid-pages (moves imported
pages to Trash). The code path exists; I could not make a deterministic mid-import cancel in a
unit test without a hook, and did not add one.

## Scale run (synthetic, real-shaped; no real content)

`gen-graph.mjs` (scratch only): 950 pages (namespaces, Czech diacritics), 1,500 journals,
26,446 blocks, 300 incompressible 830 KB images; 250 MB zip made by macOS `zip -r`. Server on
port 6556, scratch data dir, `NODE_ENV=production`, `--no-mirror`, 2026-10-04, this Mac under load
from other agents:

| | CLI `nooklet import` | in-app (API, same zip) |
|---|---|---|
| pages / journals / blocks / assets | 950 / 1500 / 26446 / 300 | 950 / 1500 / 26446 / 300 |
| referenced pages / dangling refs / errors | 16 / 0 / 0 | 16 / 0 / 0 |
| time | 39.8 s (17.6 s on a quieter earlier run) | upload 6.8 s, import 38.2 s, verify 2.3 s, total 50.7 s |

Verify ok (28,912 ops, 0 divergences). The new graph answered `graph.overview` with the returned
token. Slowest `import.status` poll: 4.0 s (the event loop is busy in the reference/verify phase).

The first scale attempt failed: "unpacking stalled" — yauzl 2.10's entry stream stops at 786,432
bytes of an 830 KB entry on Node 26 (probe above). Fixed by reading entries ourselves.

## Real-graph run

Not done: the path given (the real graph's path (`~/notes-graph` here)) does not exist here, and I did not look for
the graph elsewhere. To do it: `cp -R <graph> <scratch>/graph && cd <scratch> && zip -r -q -X
graph.zip graph`, then the scale script's flow (CLI import vs `import.*` upload, compare counts).

## Still unverified

- **Tauri desktop window**: whether WKWebView's file panel honours `webkitdirectory` (folder pick)
  in the macOS app. If not, "Choose .zip…" works there. Not run (no desktop GUI allowed).
- **iOS app**: picking a .zip from Files in the Capacitor app, and the "needs admin" message for a
  paired phone. The 390 px layout is covered in Chromium only.
- **Real graph** (above).
- **Finder "Compress" zips** specifically (data descriptors, unflagged UTF-8 names): the macOS `zip`
  CLI shape is tested; Finder's is believed equivalent (central-directory sizes are used, names are
  UTF-8-sniffed) but was not run.

## How to resume

Read ADR 031. Remaining: real-graph run, desktop/iOS checks above, fold the BUGS entries below.

## BUGS.md updates to fold in

- **New, fixed** · *Importing a Logseq graph needs a terminal* (owner request, 2026-10-04). Fixed by
  Settings → Import from Logseq (ADR 031). Tests: `ops/import.http.test.ts`,
  `importer/zip.test.ts`, `e2e/tests/logseq-import.spec.ts`.
- **New, fixed** · *An uploaded graph zip with an image over ~768 KB never finishes unpacking*
  (found in the scale run before shipping): yauzl 2.10's entry stream stalls on Node 26. Fixed by
  reading entry bytes directly. Probe: `tools/probes/zip-stall.mjs`; test: the scale run (not a
  unit test: the unit fixtures are small).
- **New, fixed** · *Page names with diacritics turn into mojibake when the graph was zipped on a
  Mac* (found by the 390 px e2e): macOS writes UTF-8 names without the UTF-8 flag. Test:
  `zip.test.ts` "reads UTF-8 names that lack the UTF-8 flag", and the e2e's zip case.
- **New, open (low)** · *A paired phone cannot start an import*: its token is `write`, import is
  `admin` (ADR 029/030, by design). The section says so; revisit if phones should import.
- **Note for whoever runs `biome check`**: `apps/web/src/sync/http-transport-stall.test.ts:49-50`
  (from `c9d993bb`) has two `noUnsafeOptionalChaining` errors; not touched here.
- **Note**: during this work the shared clone's `core.hooksPath` was mistakenly set to
  `tools/hooks-link`; the worktree guard blocked the command to put it back. Run
  `git config core.hooksPath tools/git-hooks` in the main checkout.
- **New, open (low)** · *`leak-check --staged` skips a staged file whose name has non-ASCII
  letters*: it hands git's quoted path (`"Pl\303\241..."`) back to git, which answers "unknown
  revision", and the run still reports clean. Seen staging the e2e fixture page with a Czech name.
  Likely fix: `-c core.quotepath=off` or `-z` when listing staged files.
