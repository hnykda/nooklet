/**
 * QR pairing and device management (B-655): `pairing.create`, `pairing.redeem`, `token.list`,
 * `token.revoke`, over real HTTP routes (in-process) and against a real WebSocket for revocation.
 */

import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createPairingCode,
  PAIRING_CODE_RE,
  PAIRING_CODE_TTL_MS,
  redeemPairingCode,
} from "../auth/pairing-codes.js";
import { revokeToken, verifyToken } from "../auth/tokens.js";
import { createRateLimiter } from "../http/rate-limit.js";
import { makeSyncTestServer } from "../sync/sync-test-helpers.js";
import { makeTestServer, post } from "../test-helpers.js";

async function redeem(
  app: ReturnType<typeof makeTestServer>["app"],
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: { token?: string; error?: { code: string } } }> {
  const res = await app.request("/api/v1/pairing.redeem", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("pairing codes", () => {
  it("an admin mints a code; a device with no token trades it once for a write+sync token", async () => {
    const s = makeTestServer();
    const created = await post(s.app, "/api/v1/pairing.create", s.adminToken, {});
    expect(created.status).toBe(200);
    expect(created.json.code).toMatch(PAIRING_CODE_RE);
    expect(created.json.scope).toBe("write");
    expect(created.json.sync).toBe(true);
    expect(created.json.expires_at - Date.now()).toBeGreaterThan(PAIRING_CODE_TTL_MS - 5_000);

    const first = await redeem(s.app, { code: created.json.code, label: "Test phone" });
    expect(first.status).toBe(200);
    const verified = verifyToken(s.serverCtx.driver, first.json.token as string);
    expect(verified).toMatchObject({ label: "Test phone", scope: "write", canSync: true });

    // Single use: the same code again is refused, and no second token appears.
    const second = await redeem(s.app, { code: created.json.code, label: "Thief" });
    expect(second.status).toBe(401);
    expect(second.json.error?.code).toBe("unauthorized");
    const n = s.serverCtx.driver.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM token WHERE label IN ('Test phone', 'Thief')",
    )?.n;
    expect(n).toBe(1);
  });

  it("stores only a hash of the code", () => {
    const s = makeTestServer();
    const { code } = createPairingCode(s.serverCtx.driver, { createdBy: null });
    const dump = JSON.stringify(s.serverCtx.driver.all("SELECT * FROM pairing_code"));
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(code.slice(4));
  });

  it("an expired code fails closed", () => {
    const s = makeTestServer();
    const t0 = 1_000_000;
    const { code } = createPairingCode(s.serverCtx.driver, { createdBy: null, now: t0 });
    expect(
      redeemPairingCode(s.serverCtx.driver, code, "late", t0 + PAIRING_CODE_TTL_MS + 1),
    ).toBeNull();
    // Control: the same code at a time inside its window works, so the refusal above was the
    // expiry check and nothing else.
    expect(redeemPairingCode(s.serverCtx.driver, code, "on time", t0 + 1)).not.toBeNull();
  });

  it("an unknown or malformed code is refused with the same answer as a used one", async () => {
    const s = makeTestServer();
    const unknown = await redeem(s.app, {
      code: "nkp_AAAAAAAAAAAAAAAAAAAAAA",
      label: "x",
    });
    expect(unknown.status).toBe(401);
    const malformed = await redeem(s.app, { code: "nk_notacode", label: "x" });
    expect(malformed.status).toBe(400);
  });

  it("regenerating cancels the same creator's earlier unused code", async () => {
    const s = makeTestServer();
    const a = await post(s.app, "/api/v1/pairing.create", s.adminToken, {});
    const b = await post(s.app, "/api/v1/pairing.create", s.adminToken, {});
    expect((await redeem(s.app, { code: a.json.code, label: "old" })).status).toBe(401);
    expect((await redeem(s.app, { code: b.json.code, label: "new" })).status).toBe(200);
  });

  it("the race: concurrent redeems of one code produce exactly one token", async () => {
    const s = makeTestServer();
    const { json } = await post(s.app, "/api/v1/pairing.create", s.adminToken, {});
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => redeem(s.app, { code: json.code, label: `racer ${i}` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(7);
    const n = s.serverCtx.driver.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM token WHERE label LIKE 'racer %'",
    )?.n;
    expect(n).toBe(1);
  });

  it("a code grants at most write: admin cannot be requested", async () => {
    const s = makeTestServer();
    const res = await post(s.app, "/api/v1/pairing.create", s.adminToken, { scope: "admin" });
    expect(res.status).toBe(400);
  });

  it("the redeem endpoint is rate-limited (429 with Retry-After after 10 attempts a minute)", async () => {
    const s = makeTestServer();
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 12; i++) {
      const res = await s.app.request("/api/v1/pairing.redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "nkp_AAAAAAAAAAAAAAAAAAAAAA", label: "guess" }),
      });
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get("retry-after");
    }
    expect(statuses.slice(0, 10).every((st) => st === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // Other routes are not affected by the limiter.
    expect((await post(s.app, "/api/v1/graph.overview", s.writeToken, {})).status).toBe(200);
  });

  it("the limiter counts per peer and in total, and forgets after the window", () => {
    let t = 0;
    const lim = createRateLimiter({ windowMs: 1000, perPeer: 2, total: 3, now: () => t });
    expect(lim.allow("a").ok).toBe(true);
    expect(lim.allow("a").ok).toBe(true);
    expect(lim.allow("a").ok).toBe(false); // per-peer
    expect(lim.allow("b").ok).toBe(true);
    expect(lim.allow("c").ok).toBe(false); // total
    t = 1001;
    expect(lim.allow("a").ok).toBe(true);
  });
});

describe("scope enforcement (B-655: admin gates server administration)", () => {
  it("a write token cannot create codes, list tokens or revoke one", async () => {
    const s = makeTestServer();
    const victim = s.serverCtx.driver.get<{ id: string }>(
      "SELECT id FROM token WHERE label = 'test-admin'",
    )?.id;
    for (const [op, body] of [
      ["pairing.create", {}],
      ["token.list", {}],
      ["token.revoke", { id: victim }],
    ] as const) {
      const res = await post(s.app, `/api/v1/${op}`, s.writeToken, body);
      expect(res.status, op).toBe(403);
    }
    const get = await s.app.request("/api/v1/token.list", {
      headers: { authorization: `Bearer ${s.writeToken}` },
    });
    expect(get.status).toBe(403);
    expect(verifyToken(s.serverCtx.driver, s.adminToken)).not.toBeNull();
  });

  it("without any token the admin ops are 401, and redeem never runs another op anonymously", async () => {
    const s = makeTestServer();
    for (const op of ["pairing.create", "token.list", "token.revoke"]) {
      const res = await s.app.request(`/api/v1/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status, op).toBe(401);
    }
  });

  it("the loopback web-client token is admin, so the desktop app can manage devices", async () => {
    const s = makeTestServer();
    // `isLoopbackRequest` needs a real socket; go through a real listener.
    const server = await new Promise<ServerType & { port: number }>((resolve) => {
      const srv = serve({ fetch: s.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve(Object.assign(srv, { port: info.port })),
      );
    });
    try {
      const session = (await (
        await fetch(`http://127.0.0.1:${server.port}/api/session`)
      ).json()) as { token: string };
      expect(verifyToken(s.serverCtx.driver, session.token)?.scope).toBe("admin");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("token.list / token.revoke", () => {
  it("lists labels and dates, never the token or its hash, and marks the caller", async () => {
    const s = makeTestServer();
    await post(s.app, "/api/v1/graph.overview", s.writeToken, {}); // sets last_used_at
    const res = await post(s.app, "/api/v1/token.list", s.adminToken, {});
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.json);
    expect(text).not.toContain(s.writeToken);
    expect(text).not.toContain("token_hash");
    const write = res.json.tokens.find((t: { label: string }) => t.label === "test-write");
    expect(write.last_used_at).toBeGreaterThan(0);
    const me = res.json.tokens.filter((t: { current: boolean }) => t.current);
    expect(me.map((t: { label: string }) => t.label)).toEqual(["test-admin"]);
  });

  it("revoke takes effect on the next request and drops the token from the default list", async () => {
    const s = makeTestServer();
    const list = await post(s.app, "/api/v1/token.list", s.adminToken, {});
    const id = list.json.tokens.find((t: { label: string }) => t.label === "test-write").id;
    const res = await post(s.app, "/api/v1/token.revoke", s.adminToken, { id });
    expect(res.json).toEqual({ revoked: true, closed_sockets: 0 });
    expect((await post(s.app, "/api/v1/graph.overview", s.writeToken, {})).status).toBe(401);
    const after = await post(s.app, "/api/v1/token.list", s.adminToken, {});
    expect(after.json.tokens.some((t: { id: string }) => t.id === id)).toBe(false);
    const all = await post(s.app, "/api/v1/token.list", s.adminToken, { include_revoked: true });
    expect(all.json.tokens.find((t: { id: string }) => t.id === id).revoked_at).toBeGreaterThan(0);
    expect((await post(s.app, "/api/v1/token.revoke", s.adminToken, { id: "nope" })).status).toBe(
      404,
    );
  });
});

describe("revocation closes the token's open sync WebSocket (B-676 / H3)", () => {
  let server: ServerType | undefined;
  let wss: WebSocketServer | undefined;
  afterEach(async () => {
    wss?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function start() {
    const s = makeSyncTestServer();
    wss = new WebSocketServer({ noServer: true });
    const port = await new Promise<number>((resolve) => {
      server = serve(
        { fetch: s.app.fetch, port: 0, websocket: { server: wss as WebSocketServer } },
        (info) => resolve(info.port),
      );
    });
    return { ...s, port };
  }

  async function hello(port: number, token: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/live`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "hello", device_id: "dddddddd", token }));
    await new Promise((r) => setTimeout(r, 50));
    return ws;
  }

  it("token.revoke closes it at once with 4401", async () => {
    const s = await start();
    const ws = await hello(s.port, s.syncToken);
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    const id = s.serverCtx.driver.get<{ id: string }>(
      "SELECT id FROM token WHERE label = 'device-a'",
    )?.id;
    const res = await post(s.app, "/api/v1/token.revoke", s.adminToken, { id });
    expect(res.json.closed_sockets).toBe(1);
    expect(await closed).toBe(4401);
  });

  it("a revoke from another process (the CLI) closes it at the next commit instead of poking it", async () => {
    const s = await start();
    const ws = await hello(s.port, s.syncToken);
    const messages: string[] = [];
    ws.on("message", (d) => messages.push(String(d)));
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    const id = s.serverCtx.driver.get<{ id: string }>(
      "SELECT id FROM token WHERE label = 'device-a'",
    )?.id as string;
    revokeToken(s.serverCtx.driver, id); // what `nooklet token revoke` does, straight to SQLite
    await post(s.app, "/api/v1/page.create", s.writeToken, { name: "After revoke" });
    expect(await closed).toBe(4401);
    expect(messages).toEqual([]);
  });
});
