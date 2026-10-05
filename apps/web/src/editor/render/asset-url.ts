/**
 * Turn the markdown-relative asset path stored in block content into something the browser can
 * actually fetch, wherever the page happens to be shown from.
 *
 * Block content carries `assets/<id>.<ext>` — relative on purpose: it is what `asset.upload`
 * returns, what the mirror writes to disk, and what a Logseq graph already uses (`../assets/…`).
 * But a relative `src` resolves against the CURRENT URL, so on `/page/Some Page` it became
 * `/page/assets/<id>.png`, the SPA fallback answered with index.html, and every picture below the
 * root route was broken (B-51). The server's route is `/assets/:id`, at the API origin; this is
 * the one place that knowledge lives on the client.
 *
 * The URL also carries the asset's secret key, `?k=` (B-737, ADR 036): without it the server
 * answers 404. The key is not in the block text; `../../data/asset-info.ts` knows it, or asks the
 * server for it (one request per tick for everything on screen, kept for good). Until it is known
 * this returns `undefined`, and the caller shows nothing rather than a URL that would fail — an
 * `<img>` with no `src` yet, a link with no `href` yet. Inside a tracking scope the lookup
 * subscribes, so the caller re-renders once the key lands.
 *
 * Anything that is not an asset path — `https://…`, `data:`, a bare filename — passes through.
 */

import { lookupAssetKey, resolveAssetKey } from "../../data/asset-info.js";
import { apiBaseUrl } from "../../data/bootstrap.js";

const ASSET_PATH_RE = /^(?:\.\.\/|\.\/|\/)?assets\/([^/?#]+)$/;

function keyed(file: string, key: string | null): string {
  const base = `${apiBaseUrl()}/assets/${file}`;
  // `null`: the server has no such asset. The bare URL then fails like any dead link, as it did
  // before keys; there is nothing better to show.
  return key === null ? base : `${base}?k=${key}`;
}

/**
 * The fetchable URL for `src`: an asset path becomes the server's keyed URL (`undefined` while its
 * key is not known yet), anything else is returned as it is.
 */
export function assetUrl(src: string): string | undefined {
  const m = ASSET_PATH_RE.exec(src.trim());
  if (!m?.[1]) return src;
  const key = lookupAssetKey(idOfFile(m[1]));
  return key === undefined ? undefined : keyed(m[1], key);
}

/** `assetUrl`, for an action taken outside rendering (opening a link from the keyboard): waits for
 * the key if it is not known yet. `undefined` only when it could not be learned (offline). */
export async function resolveAssetUrl(src: string): Promise<string | undefined> {
  const m = ASSET_PATH_RE.exec(src.trim());
  if (!m?.[1]) return src;
  const key = await resolveAssetKey(idOfFile(m[1]));
  return key === undefined ? undefined : keyed(m[1], key);
}

/** The asset id in an asset path (`assets/<id>.<ext>`), or `undefined` for any other `src`. */
export function assetIdOf(src: string): string | undefined {
  const m = ASSET_PATH_RE.exec(src.trim());
  return m?.[1] ? idOfFile(m[1]) : undefined;
}

function idOfFile(file: string): string {
  return file.replace(/\.[^.]*$/, "");
}
