/**
 * The widths a picture can be asked for at `GET /assets/:id?w=<width>` (ADR 035, B-738).
 *
 * A small fixed set, shared by the server (which refuses any other width) and the client (which
 * asks for the smallest one that covers what it displays): a free-form `w` would let any client
 * fill the server's disk with one cached file per pixel width, and would split the browser's
 * cache across near-identical URLs.
 *
 * 480 covers a small or resized picture and a 1x phone; 960 a desktop column at 1x and a phone
 * at 2x; 1600 a desktop column at 2x and a phone at 3x. Anything wider is what the image viewer is
 * for, and it shows the original.
 */
export const ASSET_VARIANT_WIDTHS = [480, 960, 1600] as const;

export type AssetVariantWidth = (typeof ASSET_VARIANT_WIDTHS)[number];

export function isAssetVariantWidth(n: number): n is AssetVariantWidth {
  return (ASSET_VARIANT_WIDTHS as readonly number[]).includes(n);
}
