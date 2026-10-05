/**
 * Probe (2026-10-05, ADR 035): sharp (native libvips) against the WASM codecs (@jsquash: mozjpeg
 * decode, squoosh resize, libwebp encode) for making a picture's resized variants. Prints times
 * per step and the process RSS at the end. Not runnable from the repo as is: the @jsquash packages
 * are deliberately NOT dependencies. In a scratch directory:
 *
 *   npm init -y && npm i sharp @jsquash/jpeg @jsquash/webp @jsquash/resize
 *   cp <repo>/tools/probes/image-cache/codec-bench.mjs . && node codec-bench.mjs
 *
 * Result 2026-10-05, Apple M-series, Node 26.8, sharp 0.35.5, @jsquash/jpeg 1.6.0, webp 1.5.0,
 * resize 2.1.1; a 4032×3024 (12 MP) gradient-and-grain JPEG of 5.9 MB, three runs each:
 *
 *   step (ms)                     480         960         1600
 *   wasm decode (mozjpeg)         113-126 (shared by all widths)
 *   wasm resize (triangle)        100-490     149-153     261-266
 *   wasm webp encode q75          9-17        37-39       121-126
 *   wasm whole pipeline           220-231     299-356     496-548
 *   sharp whole pipeline          44-50       77-80       169-170
 *   RSS after the run: 1038 MB (the WASM heaps grow to the 48 MB decoded image and never shrink)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import decodeJpeg, { init as initJpegDec } from "@jsquash/jpeg/decode.js";
import encodeJpeg, { init as initJpegEnc } from "@jsquash/jpeg/encode.js";
import resize, { initResize } from "@jsquash/resize";
import encodeWebp, { init as initWebpEnc } from "@jsquash/webp/encode.js";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const wasm = (p) => WebAssembly.compile(readFileSync(require.resolve(p)));

// A photo-shaped JPEG: smooth gradients plus grain, 4032x3024 (12 MP), quality 92.
const W = 4032;
const H = 3024;
const raw = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const n = (Math.random() - 0.5) * 60;
    raw[i] = Math.max(0, Math.min(255, (x / W) * 255 + n));
    raw[i + 1] = Math.max(0, Math.min(255, (y / H) * 255 + n));
    raw[i + 2] = Math.max(0, Math.min(255, 128 + 100 * Math.sin(x / 150) * Math.cos(y / 170) + n));
  }
const jpeg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
  .jpeg({ quality: 92 })
  .toBuffer();
console.log(`source: ${W}x${H} jpeg ${(jpeg.length / 1e6).toFixed(2)} MB`);

await initJpegDec(await wasm("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"));
await initWebpEnc(await wasm("@jsquash/webp/codec/enc/webp_enc_simd.wasm"));
await initJpegEnc(await wasm("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"));
await initResize(await wasm("@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"));

async function time(label, fn, runs = 3) {
  const ts = [];
  let out;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = await fn();
    ts.push(performance.now() - t);
  }
  console.log(
    `${label.padEnd(44)} ${ts.map((t) => t.toFixed(0)).join(" / ")} ms  -> ${out ? `${(out.byteLength / 1e3).toFixed(0)} kB` : ""}`,
  );
  return out;
}

const decoded = await time("wasm: mozjpeg decode", async () => {
  const d = await decodeJpeg(jpeg);
  return { byteLength: d.data.length, d };
});
const img = decoded.d;
for (const w of [480, 960, 1600]) {
  const h = Math.round((img.height * w) / img.width);
  const small = await time(`wasm: resize to ${w} (triangle)`, async () => {
    const r = await resize(img, { width: w, height: h, method: "triangle", fitMethod: "stretch" });
    return { byteLength: r.data.length, r };
  });
  await time(`wasm: webp encode ${w} q75`, () => encodeWebp(small.r, { quality: 75 }));
  await time(`wasm: jpeg encode ${w} q80`, () => encodeJpeg(small.r, { quality: 80 }));
  await time(`wasm: full pipeline ${w} webp`, async () => {
    const d = await decodeJpeg(jpeg);
    const r = await resize(d, { width: w, height: h, method: "triangle", fitMethod: "stretch" });
    return encodeWebp(r, { quality: 75 });
  });
  await time(`sharp: full pipeline ${w} webp`, () =>
    sharp(jpeg).rotate().resize({ width: w }).webp({ quality: 75 }).toBuffer(),
  );
}
console.log(`rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
