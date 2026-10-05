/**
 * Resized variants of a picture, for `GET /assets/:id?w=<width>` (ADR 035, B-738).
 *
 * Photos are stored as they arrived, 3-4 MB each, and a note shows them a few hundred pixels
 * wide. A variant is the same picture at one of `ASSET_VARIANT_WIDTHS`, as WebP, made the first
 * time someone asks for it and kept on disk beside the asset (`assets/.thumbs/<id>-<w>.webp`),
 * so every later request is a file read. The original is never touched; a variant can always be
 * deleted and is made again.
 *
 * When there is nothing to gain, or nothing can be made, the answer is "serve the original"
 * (`null`): a format that is not a still raster (SVG, GIF, an animated WebP, a PDF), a picture
 * already no wider than the width asked for, bytes the decoder cannot read, or `sharp` failing to
 * load on this platform. The client never has to know which: the URL always answers with a
 * picture.
 *
 * `sharp` (libvips) rather than a WASM codec: ADR 035 has the measurements. It is imported
 * lazily, so a server that never sees `?w=` never loads it, and a platform where its native
 * binary is missing still serves every original.
 */

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ASSET_VARIANT_WIDTHS, isAssetVariantWidth } from "@nooklet/core";

type Sharp = typeof import("sharp").default;

/** Under `<dataDir>/assets/`. A dot-directory, so a person browsing the mirror's `assets/` does not
 * see it; `backup` leaves it out (it is a cache: restore makes it again on demand). */
export const THUMBS_DIR = ".thumbs";

/** Still raster formats worth resizing. GIF is left alone: most worth keeping are animated, and
 * an animated GIF resized to one WebP frame would be a different picture. */
const RESIZABLE_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);

/** Bounded so a page of twenty new photos does not decode twenty 12-megapixel images at once
 * (~48 MB of pixels each) on a small home server. */
const MAX_PARALLEL = 2;

/** WebP at this quality is ~1/20 the bytes of a phone JPEG at 1600 px, with no visible loss at
 * the size it is shown. */
const WEBP_QUALITY = 80;

export type VariantParam =
  | { kind: "original" }
  | { kind: "variant"; width: number }
  | { kind: "bad"; message: string };

/** `w` from the query string (every value Hono saw for it). Absent means the original; anything
 * but exactly one of `ASSET_VARIANT_WIDTHS` is refused rather than rounded, so the set of files and
 * URLs stays the fixed one. */
export function parseVariantParam(values: string[] | undefined): VariantParam {
  if (values === undefined || values.length === 0) return { kind: "original" };
  const allowed = ASSET_VARIANT_WIDTHS.join(", ");
  const [raw] = values;
  if (values.length > 1 || raw === undefined || !/^\d{1,5}$/.test(raw)) {
    return { kind: "bad", message: `w must be one of ${allowed}` };
  }
  const width = Number(raw);
  if (!isAssetVariantWidth(width)) return { kind: "bad", message: `w must be one of ${allowed}` };
  return { kind: "variant", width };
}

export function variantPath(dataDir: string, id: string, width: number): string {
  return join(dataDir, "assets", THUMBS_DIR, `${id}-${width}.webp`);
}

let sharpLoad: Promise<Sharp | null> | undefined;

/**
 * Where `sharp` comes from. In this repo, `node_modules`. In the one-file `server.mjs` (desktop
 * sidecar, container image) there is no `node_modules` to resolve it through, so
 * `apps/desktop/build-sidecar.mjs` ships it and its native halves under `lib/node_modules/` and the
 * bundle's banner points `NOOKLET_SHARP_PATH` at its entry, as it does for sqlite-vec.
 */
function sharpSpecifier(): string {
  const path = process.env.NOOKLET_SHARP_PATH;
  return path ? pathToFileURL(path).href : "sharp";
}

function loadSharp(): Promise<Sharp | null> {
  sharpLoad ??= (import(sharpSpecifier()) as Promise<{ default: Sharp }>).then(
    (m) => {
      const sharp = m.default;
      // libvips' operation cache keeps decoded pixels around for reuse; every variant is made
      // once and then read from disk, so the cache would only hold memory.
      sharp.cache(false);
      return sharp;
    },
    (err: unknown) => {
      console.warn(
        `[nooklet] image variants are off: sharp did not load (${err instanceof Error ? err.message : String(err)}); serving originals`,
      );
      return null;
    },
  );
  return sharpLoad;
}

let running = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** One generation per file at a time: two requests for the same new variant share the work. */
const inflight = new Map<string, Promise<string | null>>();

export interface VariantSource {
  dataDir: string;
  id: string;
  ext: string;
  /** The picture's own width when the asset row has it (`asset.width`). */
  naturalWidth: number | null;
}

/**
 * The file to serve for `source` at `width`: the cached variant, made now if it is missing. `null`
 * means serve the original (see the header for when).
 */
export async function variantFile(source: VariantSource, width: number): Promise<string | null> {
  if (!RESIZABLE_EXTS.has(source.ext.toLowerCase())) return null;
  if (source.naturalWidth !== null && source.naturalWidth <= width) return null;
  const out = variantPath(source.dataDir, source.id, width);
  if (await isFile(out)) return out;
  let pending = inflight.get(out);
  if (!pending) {
    pending = makeVariant(source, width, out).finally(() => inflight.delete(out));
    inflight.set(out, pending);
  }
  return pending;
}

async function makeVariant(
  source: VariantSource,
  width: number,
  out: string,
): Promise<string | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const input = join(source.dataDir, "assets", `${source.id}.${source.ext}`);
  try {
    return await withSlot(async () => {
      // `failOn: "error"`: a photo with a truncated tail still has most of a picture, which is
      // what the browser shows for the original too.
      const image = sharp(input, { failOn: "error" });
      const meta = await image.metadata();
      if ((meta.pages ?? 1) > 1) return null; // animated: a still would be a different picture
      // `autoOrient`: a phone photo stores its pixels sideways plus an EXIF orientation, which
      // browsers honour for the original; the variant has no EXIF, so the turn happens here.
      const bytes = await image
        .autoOrient()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      await mkdir(join(source.dataDir, "assets", THUMBS_DIR), { recursive: true });
      // Written aside and renamed, so a reader never streams a half-written file.
      const tmp = `${out}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, out);
      return out;
    });
  } catch (err) {
    console.warn(
      `[nooklet] no ${width}px variant of asset ${source.id}: ${err instanceof Error ? err.message : String(err)}; serving the original`,
    );
    return null;
  }
}

/** Removes every cached variant of asset `id` (asset GC, which is synchronous). */
export function removeVariants(dataDir: string, id: string): void {
  for (const w of ASSET_VARIANT_WIDTHS) rmSync(variantPath(dataDir, id, w), { force: true });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
