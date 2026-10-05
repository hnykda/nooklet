import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotateAssetKeys } from "../assets/keys.js";
import { makeTestServer, post, type TestServer } from "../test-helpers.js";

let s: TestServer;

beforeEach(() => {
  s = makeTestServer();
});

afterEach(() => {
  rmSync(s.config.dataDir, { recursive: true, force: true });
});

// A real, tiny (67-byte) 1x1 transparent PNG, so mime-type/content round-tripping is meaningful.
const PNG_1PX_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("asset.upload", () => {
  it("writes the file, records the asset row, and returns id/url/markdown (success)", async () => {
    const { status, json } = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "pixel.png",
      mime_type: "image/png",
      data_base64: PNG_1PX_BASE64,
      alt: "a pixel",
    });
    expect(status).toBe(200);
    expect(json.deduped).toBe(false);
    expect(json.mime_type).toBe("image/png");
    // B-737: the URL carries the asset's own key; the markdown does not.
    expect(json.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(json.url).toBe(`/assets/${json.id}.png?k=${json.key}`);
    expect(json.markdown).toBe(`![a pixel](assets/${json.id}.png)`);
    expect(json.byte_size).toBeGreaterThan(0);

    const bytes = readFileSync(join(s.config.dataDir, "assets", `${json.id}.png`));
    expect(bytes.length).toBe(json.byte_size);
    expect(bytes.toString("base64")).toBe(PNG_1PX_BASE64);

    const row = s.serverCtx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM changes WHERE entity_type = 'asset' AND entity_id = ?",
      [json.id],
    );
    expect(row?.n).toBe(1); // still audited, per sql-schema.md rule 21's op_ids_json = '[]' case
  });

  it("defaults alt text to empty when omitted", async () => {
    const { json } = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "pixel.png",
      mime_type: "image/png",
      data_base64: PNG_1PX_BASE64,
    });
    expect(json.markdown).toBe(`![](assets/${json.id}.png)`);
  });

  it("dedups identical bytes: a second upload returns the same asset and leaves an audit row", async () => {
    const first = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "pixel.png",
      mime_type: "image/png",
      data_base64: PNG_1PX_BASE64,
    });
    const second = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "renamed.png",
      mime_type: "image/png",
      data_base64: PNG_1PX_BASE64,
    });
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);
    expect(second.json.deduped).toBe(true);
    expect(second.json.url).toBe(first.json.url); // the same key, not a new one per upload

    const count = s.serverCtx.driver.get<{ n: number }>("SELECT count(*) AS n FROM asset");
    expect(count?.n).toBe(1);
    const changesCount = s.serverCtx.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM changes WHERE entity_type = 'asset'",
    );
    // B-91: the dedupe hit is not a new write, but it IS a recent touch — asset GC's grace period
    // reads `changes`, and the block that re-embeds this asset may still be on an offline device.
    expect(changesCount?.n).toBe(2);
    const touch = s.serverCtx.driver.get<{ before_json: string | null; after_json: string }>(
      "SELECT before_json, after_json FROM changes WHERE entity_type = 'asset' ORDER BY seq DESC LIMIT 1",
    );
    expect(touch?.before_json).toBe(touch?.after_json); // nothing changed, and it says so
  });

  it("is invalid for malformed base64", async () => {
    const { status, json } = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "x.txt",
      mime_type: "text/plain",
      data_base64: "not-base64!!!",
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("invalid");
  });

  it("is too_large for a file over the 25MB decoded limit", async () => {
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 1).toString("base64");
    const { status, json } = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "big.bin",
      mime_type: "application/octet-stream",
      data_base64: big,
    });
    expect(status).toBe(413);
    expect(json.error.code).toBe("too_large");
  }, 20_000);
});

describe("GET /assets/:id", () => {
  it("serves the uploaded bytes with the recorded content type (success)", async () => {
    const upload = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "pixel.png",
      mime_type: "image/png",
      data_base64: PNG_1PX_BASE64,
    });
    const res = await s.app.request(upload.json.url as string);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString("base64")).toBe(PNG_1PX_BASE64);
  });

  it("is not_found for an unknown asset id", async () => {
    const res = await s.app.request("/assets/1k7f3q9xz2hav4.png");
    expect(res.status).toBe(404);
  });

  describe("B-737: only with the asset's key", () => {
    const pixel = () =>
      post(s.app, "/api/v1/asset.upload", s.writeToken, {
        filename: "pixel.png",
        mime_type: "image/png",
        data_base64: PNG_1PX_BASE64,
      });
    /** What every refused request must answer, byte for byte: nothing that tells an id that
     * exists from one that does not. */
    async function refusal(path: string): Promise<{ status: number; body: string }> {
      const res = await s.app.request(path);
      return { status: res.status, body: await res.text() };
    }

    it("no key, an empty key, a wrong key, another asset's key: 404, the same as an unknown id", async () => {
      const a = (await pixel()).json;
      const b = (
        await post(s.app, "/api/v1/asset.upload", s.writeToken, {
          filename: "b.txt",
          mime_type: "text/plain",
          data_base64: Buffer.from("other").toString("base64"),
        })
      ).json;
      const unknown = await refusal(`/assets/1k7f3q9xz2hav4.png?k=${a.key}`);
      expect(unknown.status).toBe(404);
      const flipped = `${a.key.slice(0, -1)}${a.key.endsWith("A") ? "B" : "A"}`;
      for (const path of [
        `/assets/${a.id}.png`,
        `/assets/${a.id}`,
        `/assets/${a.id}.png?k=`,
        `/assets/${a.id}.png?k=${flipped}`,
        `/assets/${a.id}.png?k=${a.key}x`,
        `/assets/${a.id}.png?k=${a.key.slice(0, 10)}`,
        `/assets/${a.id}.png?k=${b.key}`,
        `/assets/${a.id}.png?key=${a.key}`,
        `/assets/${a.id}.png?w=480`,
        `/assets/${a.id}.png?w=480&k=${b.key}`,
      ]) {
        expect(await refusal(path), path).toEqual(unknown);
      }
      // HEAD too: it is the same route.
      expect((await s.app.request(`/assets/${a.id}.png`, { method: "HEAD" })).status).toBe(404);
    });

    it("the right key serves it, with or without the extension, and as a variant", async () => {
      const a = (await pixel()).json;
      expect((await s.app.request(`/assets/${a.id}.png?k=${a.key}`)).status).toBe(200);
      expect((await s.app.request(`/assets/${a.id}?k=${a.key}`)).status).toBe(200);
      const variant = await s.app.request(`/assets/${a.id}.png?k=${a.key}&w=480`);
      expect(variant.status).toBe(200);
      const swapped = await s.app.request(`/assets/${a.id}.png?w=480&k=${a.key}`);
      expect(swapped.status).toBe(200);
    });

    it("needs no bearer token with the key, and a bearer token does not stand in for it", async () => {
      const a = (await pixel()).json;
      const withToken = await s.app.request(`/assets/${a.id}.png`, {
        headers: { authorization: `Bearer ${s.writeToken}` },
      });
      expect(withToken.status).toBe(404);
    });

    it("is private to the device: no shared cache keeps it past a rotated key", async () => {
      const a = (await pixel()).json;
      const res = await s.app.request(a.url as string);
      expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    });

    it("every asset gets its own 128-bit key, even ones stored in the same millisecond", async () => {
      const keys = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const up = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
          filename: `f${i}.txt`,
          mime_type: "text/plain",
          data_base64: Buffer.from(`file ${i}`).toString("base64"),
        });
        keys.add(up.json.key as string);
        // 22 base64url characters = 132 bits of text for 128 bits of randomness.
        expect(Buffer.from(up.json.key as string, "base64url")).toHaveLength(16);
      }
      expect(keys.size).toBe(20);
    });

    it("rotating a key retires the old URL and asset.info hands out the new one", async () => {
      const a = (await pixel()).json;
      expect(rotateAssetKeys(s.serverCtx.driver, a.id)).toBe(1);
      expect((await s.app.request(a.url as string)).status).toBe(404);
      const { json } = await post(s.app, "/api/v1/asset.info", s.writeToken, { ids: [a.id] });
      expect(json.assets[0].key).not.toBe(a.key);
      expect((await s.app.request(json.assets[0].url)).status).toBe(200);
      // --all: every live asset, and an unknown id changes nothing.
      expect(rotateAssetKeys(s.serverCtx.driver, "zzzzzzzzzzzzzz")).toBe(0);
      expect(rotateAssetKeys(s.serverCtx.driver)).toBe(1);
      expect((await s.app.request(json.assets[0].url)).status).toBe(404);
    });
  });

  it("serves hostile content as an inert document: nosniff + CSP sandbox (B-61)", async () => {
    // An uploaded HTML file (or a scripted SVG) opened in a tab must not run in the app's origin,
    // where it could read localStorage — the device token included.
    const html = Buffer.from("<script>alert(document.cookie)</script>").toString("base64");
    const upload = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "page.html",
      mime_type: "text/html",
      data_base64: html,
    });
    expect(upload.status).toBe(200);
    const res = await s.app.request(upload.json.url as string);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-length")).toBe(String(upload.json.byte_size));
  });

  it("rejects a mime_type that is not a well-formed media type (B-61)", async () => {
    // A newline in the recorded type made `new Response` throw on every later GET: a 500.
    for (const mime_type of ["text/html\r\nx-evil: 1", "image", "image/png; charset=x", ""]) {
      const { status, json } = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
        filename: "x.bin",
        mime_type,
        data_base64: PNG_1PX_BASE64,
      });
      expect(status, JSON.stringify(mime_type)).toBe(400);
      expect(json.error.code).toBe("invalid");
    }
  });
});

describe("B-703: image sizes", () => {
  const upload = (data_base64: string, filename = "pic.png") =>
    post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename,
      mime_type: "image/png",
      data_base64,
    });

  it("asset.upload records and returns the size; asset.info reads it back with the key", async () => {
    const up = await upload(solidPng(120, 45, [10, 20, 30]).toString("base64"));
    expect(up.json).toMatchObject({ width: 120, height: 45 });
    const pdf = await post(s.app, "/api/v1/asset.upload", s.writeToken, {
      filename: "doc.pdf",
      mime_type: "application/pdf",
      data_base64: Buffer.from("%PDF-1.7\n").toString("base64"),
    });
    expect(pdf.json).toMatchObject({ width: null, height: null });

    const { status, json } = await post(s.app, "/api/v1/asset.info", s.readToken, {
      ids: [up.json.id, pdf.json.id, "zzzzzzzzzzzzzz"],
    });
    expect(status).toBe(200);
    expect(json.assets).toEqual([
      { id: up.json.id, url: up.json.url, key: up.json.key, width: 120, height: 45 },
      { id: pdf.json.id, url: pdf.json.url, key: pdf.json.key, width: null, height: null },
    ]);
  });

  it("an asset stored before sizes were recorded gets its size from the file on first read", async () => {
    const up = await upload(PNG_1PX_BASE64);
    s.serverCtx.driver.run("UPDATE asset SET width = NULL, height = NULL WHERE id = ?", [
      up.json.id,
    ]);
    const { json } = await post(s.app, "/api/v1/asset.info", s.writeToken, { ids: [up.json.id] });
    expect(json.assets).toMatchObject([{ id: up.json.id, width: 1, height: 1 }]);
    const row = s.serverCtx.driver.get<{ width: number; height: number }>(
      "SELECT width, height FROM asset WHERE id = ?",
      [up.json.id],
    );
    expect(row).toEqual({ width: 1, height: 1 }); // written back, so the file is read only once
  });

  it("a re-upload of identical bytes fills in a size the first upload did not record", async () => {
    const up = await upload(PNG_1PX_BASE64);
    s.serverCtx.driver.run("UPDATE asset SET width = NULL, height = NULL WHERE id = ?", [
      up.json.id,
    ]);
    const again = await upload(PNG_1PX_BASE64, "again.png");
    expect(again.json).toMatchObject({ deduped: true, width: 1, height: 1 });
  });

  it("asset.info needs a token, like every /api/v1 route", async () => {
    const res = await s.app.request("/api/v1/asset.info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(401);
  });
});

/** A solid RGB PNG of a known size, built in memory. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
