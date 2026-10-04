# ADR 030: Import a Logseq graph from the app: chunked zip upload, server-side import, `admin` only

Date: 2026-10-04. Status: accepted (built on the in-app-import branch,
`docs/progress/in-app-import.md`). Extends ADR 012 (what is imported) with how it gets to the
server; ADR 012's scope is unchanged.

## Context

The owner: *"to import the logseq graph, could we have that as a feature within the app so the
users don't need to run npm commands?"* Until now the only way in was `nooklet import <dir>` on the
server's own machine. The importer (`packages/server/src/importer/logseq.ts`) reads a directory
with `node:fs` and writes through `serverApplyOps`; the client and the server are often different
machines; a real graph with its images is ~250 MB, five times the largest request body the server
accepts (48 MB, security review).

## Decision

1. **The browser sends a zip; the server imports it.** A picked folder (`<input webkitdirectory>`,
   desktop and web) is zipped in the browser, file by file, STORE only (`packages/core/src/
   zip-store.ts`): the bulk of a graph is already-compressed images. A phone picks a .zip from
   Files (iOS has no folder picker in a web view). Only what the importer reads is sent — the rule
   is one function both sides share (`packages/core/src/logseq-archive.ts`), so `logseq/bak/`,
   `.git/` and the rest never leave the device.
2. **Chunked upload through the op registry.** `import.begin` (target) → `import.chunk` (4 MiB of
   base64 at a time, in order; a resent chunk is accepted) → `import.start` → poll
   `import.status`; `import.cancel` any time; `import.info` says whether this session may import
   and whether the current graph is empty. Ordinary `defineOp`s, so they are in OpenAPI and the
   typed client, and every request stays under the existing 16 MB cap. The import's own total is
   a separate, explicit limit: `nooklet serve --import-max-mb` (default 1024).
3. **`admin` only, HTTP only.** Creating a graph is server administration (ADR 029 made `admin`
   that). The loopback desktop/web session has `admin`; a paired phone (`write`) is told so and
   pointed at the desktop app. Not MCP: an agent on the server has `nooklet import`.
4. **Two targets.**
   - **A new graph** (name it; `graph create` semantics: `isValidGraphId`, refused if it exists).
     Imported into a staging data dir no route can reach, checked with `verifyRebuildParity` (what
     `nooklet verify` runs), given an `admin` + sync token for the caller (as `POST /graphs` does),
     then renamed into `graphs/<id>` in one step. Cancel, failure, a failed check or a crash leave
     no graph behind. The registry opens it lazily on first request; no restart.
   - **The current graph, only while it is empty** (no non-blank block, page property or asset).
     Checked when the job opens and again before importing. Empty pages it does hold (today's
     journal, opened once) are moved to Trash first, or the imported page of the same name would
     collide. Imported page by page behind `writeLock`, so a `dry_run`/`batch` trial on the same
     connection can never swallow an import's writes. Cancel moves the pages imported so far to
     Trash. A graph with content is refused (409): merging an import into existing notes is the
     merge of two independent histories that ADR 025 rules out, and "import into a new graph" is
     always available.
5. **Zip safety** (`packages/server/src/importer/zip.ts`). Entry names are decoded and checked by
   us: absolute, drive-letter and `..` names refuse the archive; output paths are built from four
   fixed directory names and one validated component. Symlink entries are skipped. Limits: 200,000
   entries, 4 GiB unpacked, ratio 200x for entries over 1 MiB, and inflation capped at each entry's
   declared size. yauzl lists the central directory; entry bytes are read and inflated by our code
   (see "Found while building").
6. **Background job with progress.** One job per process. Status carries the phase (upload,
   unpack, import, check) and the live counts (pages, journals, blocks, assets); the finished job
   carries the importer's full summary (dangling block refs and asset links, referenced pages
   created, warnings such as the journal title format, errors) and, for a new graph, its id and
   token. The client polls every 0.7 s; no new socket.
7. **"Just this device" graphs cannot import.** The importer writes through `serverApplyOps`, stores
   assets with `storeAssetBytes` on the server's disk, and mints referenced pages with server code.
   Its parsing half (config, names, id rewriting, ops) is platform-free in principle, but the local-
   only client has no asset store and a different write path; splitting it is real work for a rare
   case. The section says plainly: import on a server (the desktop app has one built in), then add
   that graph. The desktop app's own graphs ("This Mac") are server graphs, so they import.

## Alternatives rejected

- **One large streaming upload route** (`PUT` with a raw body and a raised cap for one path). A
  route outside the registry, a second body limit to reason about, and no resume on a flaky phone
  connection. Chunks reuse the ordinary limit and retry per chunk.
- **Uploading files one by one instead of a zip.** Two upload paths (folder, zip) into two server
  shapes; the zip unifies them, and the phone has nothing but a zip anyway.
- **Running the importer in the browser for every target.** Same blocker as decision 7, for every
  graph, and a 250 MB graph's parse on a phone.
- **Merging into a non-empty graph.** See decision 4.
- **Root token for a new graph.** The owner would have to find and paste `root.token` in the very
  flow meant to avoid a terminal.

## Costs

- `admin` can now create graphs (not list, read or replace them). Before, only the root token could.
- Disk: the upload plus its unpacked copy, up to the limits, in `<data>/import-staging/` while a
  job runs.
- The import blocks the event loop in slices (it yields every 25 files and every 20 unpacked
  entries); the check at the end is one block of a few seconds on a large graph (a status poll
  waited up to ~4 s in the scale run). Other requests wait that long too.
- Importing into the current graph cannot be rolled back after it finishes; only cancel undoes,
  and only by moving pages to Trash.

## Found while building

- yauzl 2.10's entry streams stop part-way through an entry over ~768 KB on Node 26 — no data, no
  error, no end (`tools/probes/zip-stall.mjs`). With `pipeline` or plain listeners the import hung
  forever on a real-shaped graph's first image. Entry bytes are now read with `readSync` and
  `inflateRawSync({ maxOutputLength })`.
- macOS's `zip` and Finder's Compress write UTF-8 names without the UTF-8 flag; read as CP437
  (the spec's default) `Plánování.md` became mojibake. A name that is valid UTF-8 is taken as UTF-8.
