# asset-keys — B-737 (and B-659): a secret key in every asset URL (2026-10-05)

Branch: the agent's own worktree branch off `80768eef`. Not merged, not pushed. e2e port 6550.
New bug numbers from B-940.

Owner's choice: option A from B-737 — every asset gets a random key of at least 128 bits in its
own column; `GET /assets/<id>.<ext>?k=<key>[&w=…]` serves only with the matching key; anything
else is a 404. Block content keeps `assets/<id>.<ext>`.

## Status

Code, tests and docs done; full verification in flight (see "Verification").

- [x] B-737/B-659 marked in progress.
- [x] Settled how the client learns a key (evidence below): ADR 036.
- [x] `a31e8a85` server: `asset.url_key` + migration 9, key check in the route (constant time,
      one 404 for every refusal), `asset.upload` returns the keyed URL + key, `asset.sizes` →
      `asset.info` (also MCP `asset_info`), `nooklet asset rotate-key <id> | --all`,
      `Cache-Control: private`, route-inventory `why` + test.
- [x] `d6f8c750` client: `asset-info.ts` (key + size, one batched request, localStorage),
      `assetUrl()` keyed / `undefined` until known, paste seeds the cache, a failed load re-asks
      once, viewer/actions/Alt+Enter, e2e specs.
- [x] docs commit: ADR 036, BUGS (B-737/B-659 fixed, B-940), security guide + inventory,
      mcp-tools, sql-schema, OPERATIONS §8, self-hosting, PLAN M13, ADR 035 note; backup test
      covers `url_key`; probe `tools/probes/asset-keys/migrate-v8.ts`.
- [ ] Full verification (typecheck, biome, unit, FULL e2e, verify, leak-check, gitleaks docker).

## How to resume

Everything is committed on this branch. Re-run the verification list below; if all green, the
only thing left is the report. The owner must update the phone and Mac apps after deploy (old
code builds unkeyed URLs, which now 404).

## Evidence: is the asset table in the client replica?

No. `apps/web/src/db/schema-client.ts` adds only `pending_op`, `sync_state`, `sent_text` to
`@nooklet/core`'s `CORE_SCHEMA_STATEMENTS`, and `asset` is defined only in
`packages/server/src/schema.ts` (server-only bookkeeping). `/sync/snapshot` sends exactly four
tables (`page`, `block`, `block_prop`, `page_prop`; `packages/server/src/sync/snapshot.ts`
`TABLES`), and pull/push carry ops, which assets never are (ADR 003). So a client has no asset rows.

What it does have: `apps/web/src/data/asset-sizes.ts` (B-703), a batched lookup (`asset.sizes`,
one request per tick for every image on screen, chunks of 500) whose answers are kept forever in
memory and in `localStorage`, and which re-renders the image through a per-id signal when an
answer lands. That is exactly the shape a key lookup needs, and every image already pays for it.

## Design (implemented; ADR 036 is the record)

- `asset.sizes` is replaced by `asset.info` (`{ id, key, url, width, height }` per id). One
  request per tick for the images on screen — the same request the sizes already cost, not a
  second one. Read scope: a read token already sees every block, so a key tells it nothing new.
  Exposed to MCP (`asset_info`): an agent reading `assets/<id>.png` in a block otherwise has no
  way to fetch it any more.
- Client cache: `localStorage["nooklet.assetInfo.v2"]`, id → `[key, width, height]` (0 for no size);
  the old `nooklet.assetSizes.v1` is dropped. Synchronous, so `assetUrl()` stays synchronous; it
  returns `undefined` for an asset whose key is not known yet, and the `<img>` gets its `src` when
  the answer lands (it already waits a microtask for the column measurement, so no new flash).
- `asset.upload`'s answer seeds the cache: a pasted image renders without a lookup.
- A keyed `<img>` that fails to load asks for its key again, once per id per session, and keeps
  using the known key until a different one arrives (so an offline failure costs nothing): that
  is how a rotated key reaches a device.
- Offline: an image already seen has its key in localStorage and its bytes in the service
  worker's cache (or WKWebView's HTTP cache on the phone) under the same URL.

## Migration on a realistic graph (not the owner's)

`pnpm --filter @nooklet/server exec tsx ../../tools/probes/asset-keys/migrate-v8.ts <scratch>`:
the e2e fixture Logseq graph plus 300 generated pictures (a page and a journal referencing them),
imported with the real CLI, turned back into a version-8 database (drop `url_key`,
`user_version = 8`), reopened by `nooklet verify` (runs migration 9), then served:

```
imported 301 assets; 298 share a millisecond with another
verify: OK - rebuild() from the op log matches live state exactly.
schema 9; 301 assets, 301 with a 22-char key, 301 distinct
served 301: { bare404: 301, wrong404: 301, keyed200: 301, sameBytes: 301, variant200: 301 }
```

## Verification

(filled in as each runs)
