# In-app Logseq import

Owner request (2026-10-04): "to import the logseq graph, could we have that as a feature within the
app so the users don't need to run npm commands?"

Branch: `worktree-agent-a0659e9f571d20eb0` (based on `c9d993bb`). Decisions: ADR 030.

## Status

- [ ] ADR 030 + this file
- [ ] server: zip extraction with safety limits (`packages/server/src/importer/zip.ts`)
- [ ] server: importer progress / cancel / yield (`importer/logseq.ts`)
- [ ] server: import jobs + `import.*` ops (`importer/jobs.ts`, `ops/import.ts`), wired in `serve`
- [ ] client: STORE zip writer (`packages/core/src/zip-store.ts`), upload + Settings section
- [ ] tests: unit (zip safety, scope, non-empty refusal), e2e (folder + zip)
- [ ] real-graph run (counts + timing below)
- [ ] docs: getting-started, README, security-inventory

## Design (short; ADR 030 has the why)

- Upload: chunked, through the op registry. `import.begin` -> `import.chunk` (base64, 4 MiB raw per
  call, so every request stays under the existing 16 MB body cap) -> `import.start` ->
  poll `import.status`; `import.cancel` any time. `import.info` tells the client whether it may
  import at all (admin) and whether the current graph is empty. All `admin`, HTTP only.
- Total upload limit: `--import-max-mb` (default 1024). Unpacked limit and file-count limit too.
- Zip read with `yauzl` (central directory, validated entry sizes). Only `pages/*.md`,
  `journals/*.md`, `assets/*`, `logseq/config.edn` are extracted, under names we build ourselves.
- New graph: imported into a staging data dir, verified, token minted, then renamed into
  `<data>/graphs/<id>`. Cancel or failure deletes the staging dir; nothing half-made is visible.
- Current graph: only if it has no content. Imported through the live context under `writeLock`
  page by page. Cancel moves the pages imported so far to Trash.
- Local-only ("Just this device") graphs: importing needs a server (see ADR 030).

## Real-graph run

(not yet)

## How to resume

Read ADR 030, then the Status list above.

## BUGS.md updates to fold in

(none yet)
