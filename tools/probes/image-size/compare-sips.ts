/**
 * Probe (2026-10-04, B-703): does `imageSize` (packages/server/src/assets/image-size.ts) agree with
 * a real decoder on real files? macOS `sips` is the reference: it reports the stored pixel size and
 * the EXIF orientation, and `imageSize` must equal that size with width/height swapped for
 * orientations 5-8 (what a browser displays).
 *
 * Run (macOS): `pnpm exec tsx tools/probes/image-size/compare-sips.ts <dir> [<dir>…]` from the repo
 * root. Prints counts only — point it at a private folder without anything leaking.
 * With no arguments it first writes a synthetic set (sips-encoded PNG/JPEG/GIF/TIFF-sourced files
 * in several sizes and one rotated JPEG) to a temp dir and checks that.
 *
 * Result when written: synthetic set (4 PNG, 5 JPEG incl. one sips-rotated, 4 GIF) — 12 agree,
 * 0 disagree, 1 "unreadable": sips itself reports no size for the 4032×3024 GIF (`file` says
 * 4032 x 3024, which is what `imageSize` read). The owner's Logseq graph's `assets/`
 * (~/notes-graph/assets): 147 images (128 PNG, 17 JPEG, 2 WebP) — 147 agree, 0 disagree,
 * 0 unreadable. Set PROBE_VERBOSE=1 to print mismatching file names (not on a private folder).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { imageSize } from "../../../packages/server/src/assets/image-size.js";

const EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function sips(path: string): { w: number; h: number; orientation: number } | null {
  try {
    const out = execFileSync(
      "sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "orientation", path],
      { encoding: "utf8" },
    );
    const num = (k: string) => Number(new RegExp(`${k}: (\\d+)`).exec(out)?.[1] ?? Number.NaN);
    const orientation = num("orientation");
    return {
      w: num("pixelWidth"),
      h: num("pixelHeight"),
      orientation: Number.isNaN(orientation) ? 1 : orientation,
    };
  } catch {
    return null;
  }
}

function syntheticSet(): string {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-image-size-probe-"));
  // A raw PNG to start from (no dependency): solid grey.
  const png = (w: number, h: number): Buffer => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(body));
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const row = Buffer.alloc(1 + w * 3, 0x80);
    row[0] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  for (const [w, h] of [
    [1, 1],
    [1200, 900],
    [390, 2400],
    [4032, 3024],
  ] as const) {
    const base = join(dir, `s-${w}x${h}.png`);
    writeFileSync(base, png(w, h));
    for (const fmt of ["jpeg", "gif"]) {
      execFileSync("sips", ["-s", "format", fmt, base, "--out", join(dir, `s-${w}x${h}.${fmt}`)], {
        stdio: "ignore",
      });
    }
  }
  // Rotated: sips -r physically rotates; then tag orientation 6 on an unrotated copy via EXIF is
  // not something sips writes, so the rotation path is covered by the unit tests' EXIF fixtures.
  execFileSync("sips", ["-r", "90", join(dir, "s-1200x900.jpeg"), "--out", join(dir, "r.jpeg")], {
    stdio: "ignore",
  });
  return dir;
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push(syntheticSet());

let agree = 0;
let disagree = 0;
let unreadable = 0;
const byExt: Record<string, number> = {};
for (const dir of dirs) {
  for (const name of readdirSync(dir)) {
    const ext = extname(name).toLowerCase();
    if (!EXTS.has(ext)) continue;
    byExt[ext] = (byExt[ext] ?? 0) + 1;
    const path = join(dir, name);
    const ours = imageSize(readFileSync(path));
    const ref = sips(path);
    if (!ours || !ref || Number.isNaN(ref.w) || Number.isNaN(ref.h)) {
      unreadable++;
      continue;
    }
    const rotated = ref.orientation >= 5 && ref.orientation <= 8;
    const want = rotated ? { width: ref.h, height: ref.w } : { width: ref.w, height: ref.h };
    if (ours.width === want.width && ours.height === want.height) agree++;
    else {
      disagree++;
      if (process.env.PROBE_VERBOSE) console.log(name, ours, ref);
    }
  }
}
console.log(JSON.stringify({ byExt, agree, disagree, unreadable }));
