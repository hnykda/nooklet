# asset-keys — B-737 (and B-659): a secret key in every asset URL (2026-10-05)

Branch: the agent's own worktree branch off `80768eef`. Not merged, not pushed. e2e port 6550.
New bug numbers from B-940.

Owner's choice: option A from B-737 — every asset gets a random key of at least 128 bits in its
own column; `GET /assets/<id>.<ext>?k=<key>[&w=…]` serves only with the matching key; anything
else is a 404. Block content keeps `assets/<id>.<ext>`.

## Status

- [x] B-737/B-659 marked in progress.
- [x] Settled how the client learns a key (evidence below). ADR 036 to write.
- [ ] Server: `asset.url_key` column + migration 9, key check in the route, `asset.upload` and
      the new `asset.info` hand out keyed URLs, rotation (`nooklet asset rotate-key`).
- [ ] Client: `asset-sizes.ts` becomes `asset-info.ts` (key + size), `assetUrl()` keyed,
      viewer/actions, paste seeds the cache, a failed load re-asks once (rotation).
- [ ] Tests (server, client, e2e), docs, full verification.

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

## Design (being implemented)

- `asset.sizes` is replaced by `asset.info` (`{ id, key, url, width, height }` per id). One
  request per tick for the images on screen — the same request the sizes already cost, not a
  second one. Read scope: a read token already sees every block, so a key tells it nothing new.
  Exposed to MCP (`asset_info`): an agent reading `assets/<id>.png` in a block otherwise has no
  way to fetch it any more.
- Client cache: `localStorage["nooklet.assetInfo.v2"]`, id → `[key, width|null, height|null]`;
  the old `nooklet.assetSizes.v1` is dropped. Synchronous, so `assetUrl()` stays synchronous; it
  returns `undefined` for an asset whose key is not known yet, and the `<img>` gets its `src` when
  the answer lands (it already waits a microtask for the column measurement, so no new flash).
- `asset.upload`'s answer seeds the cache: a pasted image renders without a lookup.
- A keyed `<img>` that fails to load drops its cached key and asks again, once per id per
  session: that is how a rotated key reaches a device.
- Offline: an image already seen has its key in localStorage and its bytes in the service
  worker's cache (or WKWebView's HTTP cache on the phone) under the same URL.
