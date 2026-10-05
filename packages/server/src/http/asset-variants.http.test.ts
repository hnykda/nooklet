/**
 * B-738 / ADR 035: `GET /assets/:id?w=<width>` — a resized WebP, made on first request, cached on
 * disk, refused for any width outside the fixed set, and the original whenever there is nothing
 * to resize.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_VARIANT_WIDTHS } from "@nooklet/core";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { THUMBS_DIR, variantPath } from "../assets/variants.js";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

afterEach(() => {
  rmSync(s.config.dataDir, { recursive: true, force: true });
});

/** A photo-shaped JPEG (gradient and grain), `width`×`height`, optionally with an EXIF orientation. */
async function photo(width: number, height: number, orientation?: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = (x * 255) / width;
      raw[i + 1] = (y * 255) / height;
      raw[i + 2] = (x * y) % 256;
    }
  let img = sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 });
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}

async function upload(bytes: Buffer, filename: string, mime: string) {
  const { status, json } = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
    filename,
    mime_type: mime,
    data_base64: bytes.toString("base64"),
  });
  expect(status).toBe(200);
  return json as { id: string; url: string; byte_size: number };
}

const get = (path: string) => s.app.request(path);

describe("GET /assets/:id?w=", () => {
  it("answers a resized WebP and keeps it on disk; the original is untouched", async () => {
    const original = await photo(2000, 1500);
    const a = await upload(original, "garden.jpg", "image/jpeg");

    const res = await get(`${a.url}&w=960`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    // The same headers as the original: immutable, and harmless as a document.
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    const body = Buffer.from(await res.arrayBuffer());
    expect(Number(res.headers.get("content-length"))).toBe(body.length);
    const meta = await sharp(body).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 960, height: 720 });
    expect(body.length).toBeLessThan(original.length / 4);

    const cached = variantPath(s.config.dataDir, a.id, 960);
    expect(cached).toBe(join(s.config.dataDir, "assets", THUMBS_DIR, `${a.id}-960.webp`));
    expect(readFileSync(cached)).toEqual(body);
    // The original route still answers the original bytes.
    const orig = await get(a.url);
    expect(orig.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await orig.arrayBuffer())).toEqual(original);
  });

  it("serves the cached file on later requests instead of making it again", async () => {
    const a = await upload(await photo(1800, 1200), "cached.jpg", "image/jpeg");
    expect((await get(`${a.url}&w=480`)).status).toBe(200);
    const cached = variantPath(s.config.dataDir, a.id, 480);
    // Different bytes in the cache file: if the second answer is these, it came from the cache.
    const marker = await sharp({
      create: { width: 3, height: 2, channels: 3, background: "#123456" },
    })
      .webp()
      .toBuffer();
    writeFileSync(cached, marker);
    const again = await get(`${a.url}&w=480`);
    expect(Buffer.from(await again.arrayBuffer())).toEqual(marker);
  });

  it("two requests for a new variant at once share one generation and get the same bytes", async () => {
    const a = await upload(await photo(1700, 1100), "twice.jpg", "image/jpeg");
    const [r1, r2] = await Promise.all([get(`${a.url}&w=960`), get(`${a.url}&w=960`)]);
    const [b1, b2] = await Promise.all([r1.arrayBuffer(), r2.arrayBuffer()]);
    expect(Buffer.from(b1)).toEqual(Buffer.from(b2));
    expect((await sharp(Buffer.from(b1)).metadata()).width).toBe(960);
  });

  it("turns a phone photo the way its EXIF orientation says (the variant has no EXIF to do it)", async () => {
    // Stored 1600×1200 landscape with orientation 6 ("rotate 90° clockwise"): a portrait photo.
    const a = await upload(await photo(1600, 1200, 6), "portrait.jpg", "image/jpeg");
    const res = await get(`${a.url}&w=480`);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta).toMatchObject({ width: 480, height: 640 });
    expect(meta.orientation ?? 1).toBe(1);
  });

  it("answers the original for a width the picture does not exceed, and caches nothing", async () => {
    const original = await photo(1200, 900);
    const a = await upload(original, "small.jpg", "image/jpeg");
    const res = await get(`${a.url}&w=1600`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(original);
    expect(existsSync(variantPath(s.config.dataDir, a.id, 1600))).toBe(false);
  });

  it("answers the original for a file that is not a still raster (SVG, PDF)", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><rect width="3000" height="2000"/></svg>',
    );
    const a = await upload(svg, "diagram.svg", "image/svg+xml");
    const res = await get(`${a.url}&w=480`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(svg);

    const pdf = await upload(Buffer.from("%PDF-1.4 not much\n"), "doc.pdf", "application/pdf");
    const r2 = await get(`${pdf.url}&w=480`);
    expect(r2.status).toBe(200);
    expect(r2.headers.get("content-type")).toBe("application/pdf");
  });

  it("answers the original when the bytes cannot be decoded, and caches nothing", async () => {
    const junk = Buffer.from("not really a jpeg, just a name that says so");
    const a = await upload(junk, "broken.jpg", "image/jpeg");
    const res = await get(`${a.url}&w=480`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(junk);
    expect(existsSync(variantPath(s.config.dataDir, a.id, 480))).toBe(false);
  });

  it("refuses any w outside the fixed set with 400, and makes nothing", async () => {
    const a = await upload(await photo(2000, 1000), "refused.jpg", "image/jpeg");
    for (const bad of ["500", "0", "-480", "480.5", "abc", "", "1e3", "960&w=480", "99999999"]) {
      const res = await get(`${a.url}&w=${bad}`);
      expect(res.status, `w=${bad}`).toBe(400);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe("bad_request");
      expect(json.error.message).toContain(ASSET_VARIANT_WIDTHS.join(", "));
    }
    expect(existsSync(join(s.config.dataDir, "assets", THUMBS_DIR))).toBe(false);
  });

  it("every allowed width works, and each is a file of its own", async () => {
    const a = await upload(await photo(2400, 1600), "all.jpg", "image/jpeg");
    for (const w of ASSET_VARIANT_WIDTHS) {
      const res = await get(`${a.url}&w=${w}`);
      expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(w);
      expect(statSync(variantPath(s.config.dataDir, a.id, w)).isFile()).toBe(true);
    }
  });

  it("a variant of a missing asset is a 404, like the original", async () => {
    const res = await get("/assets/0000000000000a.jpg?w=480");
    expect(res.status).toBe(404);
  });

  it("B-737: a variant needs the asset's key too, and nothing is made for a request without it", async () => {
    const a = await upload(await photo(2000, 1000), "keyed.jpg", "image/jpeg");
    const bare = a.url.split("?")[0] as string;
    expect((await get(`${bare}?w=480`)).status).toBe(404);
    expect((await get(`${bare}?w=480&k=not-the-key`)).status).toBe(404);
    expect(existsSync(join(s.config.dataDir, "assets", THUMBS_DIR))).toBe(false);
    expect((await get(`${bare}?w=480&${a.url.split("?")[1]}`)).status).toBe(200);
  });
});
