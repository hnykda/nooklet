import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(json.url).toBe(`/assets/${json.id}.png`);
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
