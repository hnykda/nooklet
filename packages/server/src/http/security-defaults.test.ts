/**
 * Safe-by-default HTTP behaviour (docs/progress/security-review.md): security headers, the app
 * shell's CSP, request body caps, WWW-Authenticate on 401, and the loopback auto-token being off
 * for a non-loopback bind unless asked for.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestServer } from "../test-helpers.js";
import { MAX_BODY_BYTES, MAX_LARGE_BODY_BYTES } from "./guards.js";
import { shellCsp } from "./web-client.js";

const INLINE = "console.log('build snippet')";
function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nooklet-sec-web-"));
  writeFileSync(
    join(dir, "index.html"),
    `<html><head><script>${INLINE}</script><script type="module" src="/static/a.js"></script></head><body></body></html>`,
  );
  return dir;
}
const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

describe("security headers", () => {
  it("every response carries nosniff, DENY and no-referrer; no HSTS over plain http", async () => {
    const s = makeTestServer();
    for (const path of ["/healthz", "/api/session", "/api/v1/page.list"]) {
      const res = await s.app.request(path, { method: path.includes("v1") ? "POST" : "GET" });
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("strict-transport-security"), path).toBeNull();
    }
  });

  it("HSTS only when a TLS proxy says the request arrived over https", async () => {
    const s = makeTestServer();
    const viaProxy = await s.app.request("/healthz", { headers: { "x-forwarded-proto": "https" } });
    expect(viaProxy.headers.get("strict-transport-security")).toBe("max-age=31536000");
    const forwarded = await s.app.request("/healthz", {
      headers: { forwarded: "for=1.2.3.4;proto=https" },
    });
    expect(forwarded.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("an asset keeps its own stricter CSP (sandbox)", async () => {
    const s = makeTestServer();
    const up = await s.app.request("/api/v1/asset.upload", {
      method: "POST",
      headers: { authorization: `Bearer ${s.writeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "a.txt", mime_type: "text/plain", data_base64: "aGk=" }),
    });
    const { url } = (await up.json()) as { url: string };
    const res = await s.app.request(url);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("401 names the Bearer scheme (RFC 6750)", async () => {
    const s = makeTestServer();
    const res = await s.app.request("/api/v1/page.list", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });
});

describe("app shell CSP", () => {
  it("allows exactly the document's own inline scripts, by hash, and forbids framing/objects", () => {
    const csp = shellCsp(`<script>${INLINE}</script><script src="/x.js"></script>`);
    expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' ${sha(INLINE)}`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("the served shell (with the injected bootstrap) and raw index.html both carry a matching CSP", async () => {
    const s = makeTestServer({ webClientDir: webDir() });
    const shell = await s.app.request("/page/x", { headers: { accept: "text/html" } });
    const html = await shell.text();
    const csp = shell.headers.get("content-security-policy") ?? "";
    const boot = html.match(/<script>(window\.__NOOKLET__=[^<]*)<\/script>/)?.[1];
    expect(boot).toBeDefined();
    expect(csp).toContain(sha(boot as string));
    expect(csp).toContain(sha(INLINE));

    const raw = await s.app.request("/index.html");
    expect(raw.headers.get("content-security-policy")).toContain(sha(INLINE));
  });
});

describe("request body limits", () => {
  it("413 before reading an oversized body (declared length)", async () => {
    const s = makeTestServer();
    const res = await s.app.request("/api/v1/page.list", {
      method: "POST",
      headers: {
        authorization: `Bearer ${s.readToken}`,
        "content-type": "application/json",
        "content-length": String(MAX_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("too_large");
  });

  it("413 for a streamed body that passes the cap with no declared length", async () => {
    const s = makeTestServer();
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ > MAX_BODY_BYTES / chunk.length + 1) c.close();
        else c.enqueue(chunk);
      },
    });
    const res = await s.app.request("/api/v1/page.list", {
      method: "POST",
      headers: { authorization: `Bearer ${s.readToken}`, "content-type": "application/json" },
      body,
      // @ts-expect-error -- Node's fetch needs this for a stream body; not in the DOM lib types.
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });

  it("asset.upload and /sync/push get the larger cap", async () => {
    const s = makeTestServer();
    const res = await s.app.request("/api/v1/asset.upload", {
      method: "POST",
      headers: {
        authorization: `Bearer ${s.writeToken}`,
        "content-type": "application/json",
        "content-length": String(MAX_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect(res.status).not.toBe(413);
    expect(MAX_LARGE_BODY_BYTES).toBeGreaterThan(Math.ceil((25 * 1024 * 1024 * 4) / 3));
  });
});

let running: Server | undefined;
afterEach(async () => {
  if (running) await new Promise<void>((r) => running?.close(() => r()));
  running = undefined;
});

async function sessionOverSocket(app: {
  fetch: (r: Request) => Response | Promise<Response>;
}): Promise<{ token: string | null; reason?: string }> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  running = server;
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/session", headers: { host: `localhost:${port}` } },
      (res) => {
        let data = "";
        res.on("data", (d) => {
          data += d;
        });
        res.on("end", () => resolve(JSON.parse(data)));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("loopback auto-token default", () => {
  it("is on for a loopback bind", async () => {
    const s = makeTestServer();
    expect((await sessionOverSocket(s.app)).token).toMatch(/^nk_/);
  });

  it("is off for a non-loopback bind, even for a genuinely local browser", async () => {
    const s = makeTestServer({ host: "0.0.0.0" });
    const body = await sessionOverSocket(s.app);
    expect(body.token).toBeNull();
    expect(body.reason).toBe("loopback_token_disabled");
  });

  it("an explicit --loopback-token turns it back on for a non-loopback bind", async () => {
    const s = makeTestServer({ host: "0.0.0.0", loopbackToken: true });
    expect((await sessionOverSocket(s.app)).token).toMatch(/^nk_/);
  });
});
