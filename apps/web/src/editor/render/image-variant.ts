/**
 * Which resized copy of a picture to ask the server for (B-738, ADR 035).
 *
 * The server answers `/assets/:id?w=<w>` for each `w` in `ASSET_VARIANT_WIDTHS` with the picture at
 * that width, or with the original when it is no wider. The note asks for the smallest one that
 * still has a device pixel for every pixel it shows: the CSS width the picture is drawn at, times
 * `devicePixelRatio`. The image viewer, Download and Copy keep the original (`assetUrl`).
 *
 * A width rather than `srcset`/`sizes`: `sizes` would have to restate in a media-query string what
 * the box's style already decides (`min(100%, Npx)` of a column whose width only layout knows), and
 * with the picture's own size unknown — the first time it is shown, before `asset.sizes` answers —
 * a `w` descriptor would also set its displayed size. Measuring the column once it is laid out and
 * asking for one URL keeps the picture's size the box's business, as B-703/B-789 made it.
 */
import { ASSET_VARIANT_WIDTHS } from "@nooklet/core";
import { assetIdOf, assetUrl } from "./asset-url.js";

const LARGEST = ASSET_VARIANT_WIDTHS[ASSET_VARIANT_WIDTHS.length - 1] as number;

/** Up to this much short of what the screen could show, the largest variant still serves: at that
 * size a 1600-px picture drawn 1800-2000 device px wide is not visibly softer, and the original is
 * typically 2-3x its bytes. Beyond it, the original. */
const STRETCH = 1.25;

export interface DisplayFacts {
  /** What the content column offers the picture, in CSS px. */
  column: number;
  /** A width the person chose (`{:width N}`, B-789), in CSS px. */
  chosen?: number;
  /** The picture's own size, when known (`asset.sizes`, B-703). */
  natural?: { width: number; height: number };
  /** `innerHeight`: an unchosen picture is capped at 70vh tall (`editor.css`, B-703's box). */
  viewportHeight: number;
}

/** The CSS width the picture is drawn at — the same rule as `ImageView`'s box style. */
export function displayCssWidth(f: DisplayFacts): number {
  if (f.chosen !== undefined) return Math.min(f.column, f.chosen);
  if (f.natural && f.natural.height > 0) {
    return Math.min(
      f.column,
      f.natural.width,
      (0.7 * f.viewportHeight * f.natural.width) / f.natural.height,
    );
  }
  return f.column;
}

/** The variant width to ask for, or `undefined` for the original (more pixels needed than the
 * largest variant has). */
export function variantWidthFor(cssWidth: number, devicePixelRatio: number): number | undefined {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const need = Math.ceil(Math.max(1, cssWidth) * dpr);
  for (const w of ASSET_VARIANT_WIDTHS) if (w >= need) return w;
  return need <= LARGEST * STRETCH ? LARGEST : undefined;
}

/**
 * The URL to draw `src` from at variant width `width` (`undefined`: the original). Only the
 * graph's own assets have variants; any other `src` (`https://…`, `data:`) is `assetUrl`'s answer.
 *
 * A `?w=` URL even when the picture turns out no wider than `width` (the server then answers the
 * original's bytes): its size can arrive after the picture started loading, and switching URLs
 * then would download it twice.
 */
export function variantSrc(src: string, width: number | undefined): string | undefined {
  const url = assetUrl(src);
  // `undefined`: the asset's key is not known yet (`assetUrl`), so there is nothing to ask for.
  if (url === undefined || width === undefined || assetIdOf(src) === undefined) return url;
  // After the key (`?k=…`, B-737), or first when the asset is unknown and has none.
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}

/** The order variants are preferred in when a choice can only grow (`ImageView`): a larger width,
 * and the original above every variant. */
export function variantRank(width: number | undefined): number {
  return width ?? Number.POSITIVE_INFINITY;
}
