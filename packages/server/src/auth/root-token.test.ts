import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureRootToken, requireRootToken } from "./root-token.js";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "nooklet-root-token-test-"));
}

describe("ensureRootToken", () => {
  it("mints a token on first call, reports created:true, and persists it for later calls", () => {
    const dir = tempDataDir();
    const first = ensureRootToken(dir);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^nkroot_[a-f0-9]+$/);

    // `nooklet token root` calling this again, any time later: same token, created:false.
    const second = ensureRootToken(dir);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("writes the token file with owner-only permissions", () => {
    const dir = tempDataDir();
    ensureRootToken(dir);
    const mode = statSync(join(dir, "root.token")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("is readable directly off disk, one token per line", () => {
    const dir = tempDataDir();
    const { token } = ensureRootToken(dir);
    expect(readFileSync(join(dir, "root.token"), "utf8").trim()).toBe(token);
  });

  it("mints a fresh token (not the same one) for a different data dir", () => {
    const a = ensureRootToken(tempDataDir());
    const b = ensureRootToken(tempDataDir());
    expect(a.token).not.toBe(b.token);
  });
});

describe("requireRootToken middleware", () => {
  function appWith(rootToken: string): Hono {
    const app = new Hono();
    app.use("*", requireRootToken(rootToken));
    app.get("/", (c) => c.json({ ok: true }));
    return app;
  }

  it("401s with no Authorization header", async () => {
    const res = await appWith("nkroot_abc").request("/");
    expect(res.status).toBe(401);
  });

  it("401s with the wrong token", async () => {
    const res = await appWith("nkroot_abc").request("/", {
      headers: { authorization: "Bearer nkroot_wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("401s with a header that isn't a Bearer token", async () => {
    const res = await appWith("nkroot_abc").request("/", {
      headers: { authorization: "nkroot_abc" },
    });
    expect(res.status).toBe(401);
  });

  it("200s with the right token", async () => {
    const res = await appWith("nkroot_abc").request("/", {
      headers: { authorization: "Bearer nkroot_abc" },
    });
    expect(res.status).toBe(200);
  });
});
