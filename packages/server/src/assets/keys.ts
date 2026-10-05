/**
 * Asset keys (B-737, ADR 036): the secret that makes an asset URL a capability.
 *
 * `GET /assets/:id` cannot ask for a bearer token — an `<img src>` has no way to send one — so it
 * used to rest on asset ids being unguessable. They are not: `newId()` has 25 random bits per
 * millisecond and counts up by one inside a millisecond, so a bulk import's ids are consecutive
 * and one known URL leads to the rest. Every asset now also has `url_key`, 128 bits from the
 * system CSPRNG that nothing else is derived from, and the route serves only a request whose
 * `?k=` matches it.
 *
 * The key lives only in the URL a client builds (`assets/<id>.<ext>` in block content is
 * unchanged, so the Markdown mirror, Logseq import/export and the files on disk are too). A client
 * learns it from `asset.upload`'s answer or from `asset.info`, both behind a token.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlDriver } from "@nooklet/core";

/** 16 bytes = 128 bits, as 22 base64url characters: URL-safe without escaping. */
const KEY_BYTES = 16;
export const ASSET_KEY_LENGTH = 22;

export function newAssetKey(): string {
  return randomBytes(KEY_BYTES).toString("base64url");
}

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/**
 * Whether `given` (a request's `?k=`, maybe absent) is `stored`. Constant time in the contents:
 * both sides are hashed to 32 bytes first, so neither a mismatch's position nor the given value's
 * length shows in the time taken. A stored key that is not a real one (a migrated row the
 * migration somehow left at its `''` default) never matches anything, the empty string included.
 */
export function assetKeyMatches(given: string | undefined, stored: string | null): boolean {
  const real = typeof stored === "string" && stored.length >= ASSET_KEY_LENGTH;
  // Compared even when the answer is already known, so an unknown id and a known id with a
  // wrong key cost the same compare.
  const same = timingSafeEqual(digest(given ?? ""), digest(real ? stored : "\u0000"));
  return real && given !== undefined && same;
}

/** The graph-relative URL that fetches an asset: what `asset.upload` and `asset.info` hand out. */
export function assetUrlPath(a: { id: string; ext: string; key: string }): string {
  return `/assets/${a.id}.${a.ext}?k=${a.key}`;
}

/**
 * A new key for asset `id` (or every live asset, `id` undefined), for a link that was shared and
 * should stop working. Returns how many rows changed. Old URLs 404 from then on; a device that
 * showed the picture keeps the bytes it cached, and a client re-learns the key through
 * `asset.info` when its old URL fails (`apps/web/src/data/asset-info.ts`).
 */
export function rotateAssetKeys(driver: SqlDriver, id?: string): number {
  return driver.transaction(() => {
    const rows = driver.all<{ id: string }>(
      id === undefined
        ? "SELECT id FROM asset WHERE deleted_at IS NULL"
        : "SELECT id FROM asset WHERE id = ? AND deleted_at IS NULL",
      id === undefined ? [] : [id],
    );
    for (const r of rows) {
      driver.run("UPDATE asset SET url_key = ? WHERE id = ?", [newAssetKey(), r.id]);
    }
    return rows.length;
  });
}
