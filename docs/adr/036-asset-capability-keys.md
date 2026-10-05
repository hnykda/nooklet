# ADR 036: A secret key in every asset URL; clients learn it from `asset.info`

Date: 2026-10-05. Status: accepted (B-737, B-659; the owner chose option A). Work record:
`docs/progress/asset-keys.md`. Probe: `tools/probes/asset-keys/migrate-v8.ts`.

## Context

`GET /assets/:id` serves uploaded and imported files without a token, because an `<img src>`
cannot send a bearer header (ADR 013). It was public on the grounds that ids are unguessable.
They are not. Asset ids are `newId()` (ADR 004): 45 bits of millisecond time plus 25 random bits,
and an id made in the same millisecond as the previous one is that id **plus one**. A bulk import
makes many assets per millisecond, so one known asset URL leads to its neighbours, and the time
part narrows any search to the import window. The probe imported a 301-picture graph: 298 of the
301 ids share their millisecond with another id. In production, an asset answered 200 to a
request that had no token (B-737).

B-737 listed three fixes: (a) a separate random key per asset, in the URL; (b) an HttpOnly cookie
set from the bearer token, so `<img>` requests are authenticated; (c) short-lived signed URLs. The
owner chose (a).

## Decision

1. **Every asset has `url_key`**: 16 bytes from `crypto.randomBytes` (128 bits), stored as 22
   base64url characters in its own column (`packages/server/src/assets/keys.ts`). Nothing else is
   derived from it, and it is independent of the id and the content hash. Schema 9 adds the column
   and gives every existing row a key in the same migration. On a fresh database the column is
   `NOT NULL` with no default, so an insert without a key fails. A migrated database has
   `DEFAULT ''`, which `ALTER TABLE ADD COLUMN NOT NULL` requires, and `''` never matches.
2. **`GET /assets/<id>.<ext>?k=<key>` serves only when `k` is the key.** This includes the
   resized variants (`&w=`, ADR 035). The comparison takes the same time whatever the input: both
   sides are hashed with SHA-256 and compared with `timingSafeEqual`, also when there is no row.
   No key, a wrong key and an unknown id all get the same 404 with the same body, so a guess does
   not learn that an id exists. The route stays on `PUBLIC_ROUTES` (no bearer token), and its
   `why` now names the key.
3. **Block content does not change.** It keeps `assets/<id>.<ext>`, so the Markdown mirror, Logseq
   import and export, and the files on disk are unchanged, and none of them contains a key. Only
   URL building changes.
4. **The client learns keys from `asset.info`, which replaces `asset.sizes`.** Assets are not in
   the client replica. `schema-client.ts` adds only `pending_op`, `sync_state` and `sent_text`;
   `/sync/snapshot` sends `page`, `block`, `block_prop` and `page_prop`; and assets are never ops
   (ADR 003). The client already had the right mechanism for images on screen: B-703's
   `asset-sizes.ts`. It is synchronous for rendering, batches every lookup made in one tick into
   one request, keeps every answer in memory and in `localStorage`, and re-renders the image
   through a per-id signal when an answer arrives. The op now answers
   `{ id, url, key, width, height }`, and the module is `apps/web/src/data/asset-info.ts`. An image
   costs no more requests than before: the request that already fetched its size now also brings
   its key.
5. **`assetUrl()` stays synchronous.** It returns the keyed URL, or `undefined` while the key is
   not known. The `<img>` gets no `src` until then. It already waited a microtask for the column
   measurement (ADR 035), so nothing flashes broken. A link gets no `href` until then either.
   `asset.upload`'s answer includes the key and the client records it, so a pasted picture needs
   no lookup. An id the server does not know gets the bare URL, which 404s like any dead link.
6. **Offline, for pictures already seen:** the key is in `localStorage`, and the picture is in the
   service worker's cache (or WKWebView's HTTP cache on the phone) under its full URL, key
   included. Both survive a reload.
7. **Rotation:** `nooklet asset rotate-key <asset-id> | --all` (CLI only). Old URLs then 404. A
   client whose cached key is stale sees the picture fail to load, asks `asset.info` again (once
   per asset per session), and switches to the new URL if the key changed.
8. **Agents:** `asset_upload` returns `url` with `?k=` and the `key`. `asset.info` is also an MCP
   tool (`asset_info`), because an agent that reads `assets/<id>.png` in a block has no other way
   to get a URL it can fetch. It needs `read` scope, which already shows every block, so the key
   adds nothing that scope could not already reach.
9. **`Cache-Control: private`** (was `public`), so a shared cache between the server and the
   device does not keep serving a URL after its key is rotated. The response is still
   `immutable`, `nosniff` and `sandbox`.

## Alternatives rejected

- **Sync the asset rows (id, ext, key) into the replica.** The replica only holds the four
  op-backed state tables. Assets would need a new kind of sync (not ops, no HLC), or a fifth
  snapshot table with pull support. Reading the replica is asynchronous (a worker round trip), so
  `assetUrl()` would still need a synchronous cache in front of it. That is more machinery than
  the cache it would sit behind, and a phone would also receive keys for assets it never shows.
- **Only the upload response, recorded locally.** Only the device that uploaded an asset would
  know its key. Imported assets, and assets uploaded from another device, would have no key.
- **A new `asset.keys` op beside `asset.sizes`.** That would be two requests for every picture,
  when one is enough.
- **(b) a cookie.** The owner chose (a). A cookie would also not work for the phone, where the
  page (`capacitor://localhost`) and the server are different origins, and it would bring CSRF
  questions to every route.
- **(c) short-lived signed URLs.** An expiring URL changes, so the service worker cache, which is
  keyed by URL, would miss on every expiry, and offline viewing (6) would stop working.
- **A compatibility path for unkeyed URLs** (accepting a bare id for a while). Not done: the repo
  carries no backward-compatibility code, and keeping the old path would keep the hole open.

## Consequences

- **Installed apps running older code lose their pictures until they are updated.** They build
  unkeyed URLs, which now 404. This includes the owner's phone and Mac apps.
- A keyed URL is a bearer capability. Anyone who has it can fetch the file without a token until
  the key is rotated. Revoking a token does not change any key. To cut off a revoked device's
  saved URLs, run `rotate-key --all`. Files a device has already cached stay on that device.
- The key is in the query string, so it appears in any access log that records query strings.
  nooklet keeps no access log. A proxy in front of it should leave query strings out of its log
  for `/assets/` (`docs/guide/security.md`). `Referrer-Policy: no-referrer` keeps the key out of
  `Referer` headers.
- `localStorage` now holds asset keys next to the device token. That gives an attacker nothing
  the token would not.
- The `localStorage` copy holds at most 10,000 assets. Past that, the oldest are dropped and
  asked for again when shown.
- `asset.sizes` is gone. Callers use `asset.info`.
