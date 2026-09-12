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
 * Anything that is not an asset path — `https://…`, `data:`, a bare filename — passes through.
 */

import { apiBaseUrl } from "../../data/bootstrap.js";

const ASSET_PATH_RE = /^(?:\.\.\/|\.\/|\/)?assets\/([^/?#]+)$/;

export function assetUrl(src: string): string {
  const m = ASSET_PATH_RE.exec(src.trim());
  if (!m) return src;
  return `${apiBaseUrl()}/assets/${m[1]}`;
}
