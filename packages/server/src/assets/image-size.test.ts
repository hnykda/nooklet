import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { imageSize } from "./image-size.js";
import { readImageSizeFromFile } from "./store.js";

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );

function png(width: number, height: number): Uint8Array {
  const ihdr = bytes(u32be(width), u32be(height), [8, 2, 0, 0, 0]);
  const body = bytes("IHDR", [...ihdr]);
  return bytes([0x89], "PNG\r\n\x1a\n", u32be(13), [...body], u32be(crc32(body)));
}

/** A JPEG's marker stream up to its first frame header, with optional EXIF orientation. */
function jpeg(width: number, height: number, opts: { orientation?: number; le?: boolean } = {}) {
  const segment = (marker: number, body: number[]) => [
    0xff,
    marker,
    ...u16be(body.length + 2),
    ...body,
  ];
  const app0 = segment(0xe0, [...bytes("JFIF\0", [1, 1, 0], u16be(1), u16be(1), [0, 0])]);
  let app1: number[] = [];
  if (opts.orientation !== undefined) {
    const le = opts.le ?? false;
    const u16 = le ? u16le : u16be;
    const u32 = le ? u32le : u32be;
    // TIFF header, IFD0 at 8 with one entry: 0x0112 SHORT count 1 value=orientation.
    const tiff = [
      ...bytes(le ? "II" : "MM"),
      ...u16(42),
      ...u32(8),
      ...u16(1),
      ...u16(0x0112),
      ...u16(3),
      ...u32(1),
      ...u16(opts.orientation),
      0,
      0,
      ...u32(0),
    ];
    app1 = segment(0xe1, [...bytes("Exif\0\0"), ...tiff]);
  }
  // A Huffman table (0xc4) sits in the SOF marker range and must not be read as a frame header.
  const dht = segment(0xc4, new Array(20).fill(0));
  const sof0 = segment(0xc0, [
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  return bytes([0xff, 0xd8], app0, app1, dht, sof0, [0xff, 0xda, 0, 2]);
}

describe("imageSize (B-703)", () => {
  it("reads a PNG's IHDR", () => {
    expect(imageSize(png(1200, 900))).toEqual({ width: 1200, height: 900 });
  });

  it("reads a GIF's logical screen size", () => {
    expect(imageSize(bytes("GIF89a", u16le(320), u16le(200), [0, 0, 0]))).toEqual({
      width: 320,
      height: 200,
    });
  });

  it("reads all three WebP flavours", () => {
    const riff = (chunk: string, payload: number[]) =>
      bytes("RIFF", u32le(4 + 8 + payload.length), "WEBP", chunk, u32le(payload.length), payload);
    // VP8 (lossy): frame tag, start code 9d 01 2a, 14-bit sizes (top 2 bits are scale).
    const vp8 = riff("VP8 ", [
      0,
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      ...u16le(640 | 0x4000),
      ...u16le(480),
      0,
      0,
    ]);
    expect(imageSize(vp8)).toEqual({ width: 640, height: 480 });
    // VP8L (lossless): 0x2f, then (w-1) and (h-1) as 14-bit fields, little-endian.
    const bits = (300 - 1) | ((150 - 1) << 14);
    expect(imageSize(riff("VP8L", [0x2f, ...u32le(bits), 0, 0, 0, 0]))).toEqual({
      width: 300,
      height: 150,
    });
    // VP8X (extended): flags + 3 reserved, then 24-bit (w-1), (h-1).
    const w = 5000 - 1;
    const h = 70000 - 1;
    const vp8x = riff("VP8X", [
      0x10,
      0,
      0,
      0,
      w & 0xff,
      (w >> 8) & 0xff,
      w >> 16,
      h & 0xff,
      (h >> 8) & 0xff,
      h >> 16,
    ]);
    expect(imageSize(vp8x)).toEqual({ width: 5000, height: 70000 });
  });

  it("reads a JPEG's frame header, skipping APP segments and a Huffman table", () => {
    expect(imageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it("swaps a JPEG's size when EXIF says the browser will rotate it (orientation 5-8)", () => {
    expect(imageSize(jpeg(4032, 3024, { orientation: 6 }))).toEqual({ width: 3024, height: 4032 });
    expect(imageSize(jpeg(4032, 3024, { orientation: 8, le: true }))).toEqual({
      width: 3024,
      height: 4032,
    });
    expect(imageSize(jpeg(4032, 3024, { orientation: 3 }))).toEqual({ width: 4032, height: 3024 });
  });

  it("returns null for other formats, truncated headers and zero sizes, never throwing", () => {
    expect(imageSize(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(imageSize(bytes("%PDF-1.7"))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
    expect(imageSize(png(0, 10))).toBeNull();
    expect(imageSize(png(10, 10).subarray(0, 20))).toBeNull();
    const j = jpeg(100, 50);
    for (let cut = 0; cut < j.length - 4; cut++) {
      expect(() => imageSize(j.subarray(0, cut))).not.toThrow();
    }
    expect(imageSize(j.subarray(0, j.length - 20))).toBeNull();
  });
});

describe("readImageSizeFromFile", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds a JPEG frame header behind more than 64 KB of APP segments", () => {
    dir = mkdtempSync(join(tmpdir(), "nooklet-image-size-"));
    const j = jpeg(800, 600);
    // Three ~60 KB APP2 segments (an ICC profile's shape) between SOI and the rest.
    const app2 = [0xff, 0xe2, ...u16be(60_000 + 2), ...new Array(60_000).fill(0)];
    const big = bytes([0xff, 0xd8], app2, app2, app2, [...j.subarray(2)]);
    const path = join(dir, "big.jpg");
    writeFileSync(path, big);
    expect(readImageSizeFromFile(path, "jpg")).toEqual({ width: 800, height: 600 });
    expect(readImageSizeFromFile(path, "pdf")).toBeNull(); // not opened at all
    expect(readImageSizeFromFile(join(dir, "missing.png"), "png")).toBeNull();
  });
});
