/**
 * Host/peer checks, exercised over a REAL socket.
 *
 * These cannot be written against `app.request()`: both behaviours under test depend on the
 * connection itself — the peer address for "is this loopback?", and the composed middleware chain
 * for "does the Host guard actually run for this route?". An in-process request has no socket, and
 * that is precisely the gap the original bug lived in.
 */

import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { createServerContext } from "../apply-ops.js";
import { verifyToken } from "../auth/tokens.js";
import { openDb } from "../db.js";
import { setSuggestedJournalTitleFormat } from "../journal-format.js";
import { buildRegistry } from "../ops/index.js";
import { setRecordedTaskWorkflow } from "../task-workflow.js";
import { makeTestServer } from "../test-helpers.js";
import { createApp, WEB_CLIENT_TOKEN_LABEL } from "./app.js";

let running: Server | undefined;

async function listen(app: {
  fetch: (r: Request) => Response | Promise<Response>;
}): Promise<number> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server;
  running = server;
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  if (running) {
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = undefined;
  }
});

/**
 * Raw `node:http` rather than `fetch`, because `Host` is a forbidden header name in the Fetch
 * spec — `fetch` silently drops it, so a test written with `fetch` would assert nothing about the
 * very header under test while appearing to pass.
 */
function get(
  port: number,
  path: string,
  host?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { ...(host ? { Host: host } : {}), ...extraHeaders },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("loopback detection", () => {
  it("issues a token to a genuine loopback peer", async () => {
    const s = makeTestServer({ webClientDir: undefined });
    const port = await listen(s.app);
    const body = JSON.parse((await get(port, "/api/session")).body) as { token: string | null };
    expect(body.token).toBeTruthy();
  });

  it("hands the graph's own journal date format to the client (ADR 018)", async () => {
    // Storage is ISO, display is a preference — and an imported graph's own format is the only
    // sensible initial value for that preference, so `/api/session` carries it.
    const s = makeTestServer({ webClientDir: undefined });
    setSuggestedJournalTitleFormat(s.serverCtx.driver, "E, dd.MM.yyyy");
    const port = await listen(s.app);
    const body = JSON.parse((await get(port, "/api/session")).body) as {
      journalTitleFormat?: string;
    };
    expect(body.journalTitleFormat).toBe("E, dd.MM.yyyy");
  });

  it("hands the graph's task workflow to the client (B-608)", async () => {
    const s = makeTestServer({ webClientDir: undefined });
    const port = await listen(s.app);
    const read = async (): Promise<string | undefined> =>
      (JSON.parse((await get(port, "/api/session")).body) as { taskWorkflow?: string })
        .taskWorkflow;
    // Nothing recorded, no tasks: Logseq's default, `now`.
    expect(await read()).toBe("now");
    setRecordedTaskWorkflow(s.serverCtx.driver, "todo");
    expect(await read()).toBe("todo");
  });

  it("a restart retires the previous process's auto token instead of leaving it live (B-54)", async () => {
    // Two `ServerContext`s over one database stand in for two server processes: the raw token
    // lives in process memory, so only the next mint can revoke the row the last one left behind.
    const driver = openDb({ path: ":memory:" });
    const config = {
      dataDir: "/nonexistent",
      graphId: "default",
      timezone: "UTC",
      port: 0,
      mirror: { enabled: false },
    };
    const boot = async (): Promise<string> => {
      const app = createApp({
        serverCtx: createServerContext(driver),
        registry: buildRegistry(),
        config,
      });
      const port = await listen(app);
      const body = JSON.parse((await get(port, "/api/session")).body) as { token: string };
      await new Promise<void>((resolve) => running?.close(() => resolve()));
      running = undefined;
      return body.token;
    };
    const first = await boot();
    expect(verifyToken(driver, first)).not.toBeNull();
    const second = await boot();
    expect(verifyToken(driver, first)).toBeNull();
    expect(verifyToken(driver, second)?.canSync).toBe(true);
    const live = driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM token WHERE label = ? AND revoked_at IS NULL",
      [WEB_CLIENT_TOKEN_LABEL],
    );
    expect(live?.n).toBe(1);
  });

  it("refuses a token when the Host header does not name loopback, even from a loopback peer", async () => {
    // A DNS-rebinding attack looks exactly like this: the victim's own browser (so a loopback
    // peer) carrying the attacker's hostname.
    const s = makeTestServer();
    const port = await listen(s.app);
    const body = JSON.parse((await get(port, "/api/session", "evil.example")).body) as {
      token: string | null;
      reason?: string;
    };
    expect(body.token).toBeNull();
    expect(body.reason).toBe("non_loopback_host");
  });

  it("refuses a token to a request that came through a same-machine reverse proxy, even with a loopback Host", async () => {
    // A proxy on this machine makes every remote client a loopback peer; one that also rewrites
    // Host to its upstream (nginx's default) handed every tailnet/LAN client a write token
    // (`tools/probes/loopback-proxy-token.mjs`). Forwarding headers mark such a request.
    const s = makeTestServer({ webClientDir: undefined });
    const port = await listen(s.app);
    for (const header of ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip"]) {
      const body = JSON.parse(
        (await get(port, "/api/session", `127.0.0.1:${port}`, { [header]: "100.64.0.7" })).body,
      ) as { token: string | null };
      expect(body.token, header).toBeNull();
    }
  });
});

describe("Host allowlist when bound to a non-loopback address", () => {
  it("guards EVERY route, not just the ones with no earlier match", async () => {
    // The regression: `@modelcontextprotocol/hono`'s own guard is merged in last, and Hono
    // composes handlers in registration order, so it only ever ran for paths that had no earlier
    // route — while the CLI printed that unexpected hosts were refused.
    const s = makeTestServer({ host: "0.0.0.0" });
    const port = await listen(s.app);
    for (const path of ["/healthz", "/openapi.json", "/api/session"]) {
      const res = await get(port, path, "evil.example");
      expect(res.status, path).toBe(403);
    }
  });

  it("permits a hostname that was explicitly allowlisted", async () => {
    const s = makeTestServer({ host: "0.0.0.0", allowedHosts: ["nook.local"] });
    const port = await listen(s.app);
    expect((await get(port, "/healthz", "nook.local")).status).toBe(200);
    expect((await get(port, "/healthz", "other.local")).status).toBe(403);
    // Loopback names keep working alongside whatever was added.
    expect((await get(port, "/healthz", "localhost")).status).toBe(200);
  });

  it("does not guard when bound to loopback, which is the default", async () => {
    const s = makeTestServer();
    const port = await listen(s.app);
    expect((await get(port, "/healthz", "anything.example")).status).toBe(200);
  });
});
