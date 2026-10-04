/**
 * B-676 H4/H12 against a real ephemeral-port server: the hello timeout, the per-token and total
 * caps, and the frame-size limits on `/sync/live` and `/ui/live`, wired the way `cli.ts` wires them
 * (`createLiveWebSocketServer` for `maxPayload`).
 */

import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import {
  LIVE_CLOSE,
  LIVE_HELLO_TIMEOUT_MS,
  LIVE_MAX_PAYLOAD_BYTES,
  LIVE_MAX_PRE_HELLO_BYTES,
} from "@nooklet/core";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import { parseArgs } from "./cli-args.js";
import {
  configureLiveLimits,
  createLiveWebSocketServer,
  DEFAULT_LIVE_LIMITS,
  openLiveSocketCount,
  parseLiveLimitFlags,
} from "./live-limits.js";
import { makeSyncTestServer } from "./sync/sync-test-helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("live socket limits (B-676 H4)", () => {
  let server: ServerType | undefined;
  let wss: WebSocketServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    configureLiveLimits({});
    wss?.close();
    wss = undefined;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    // Let the server see the terminations, so the process-wide count starts at zero next test.
    for (let i = 0; i < 50 && openLiveSocketCount() > 0; i++) await sleep(10);
  });

  async function start() {
    const s = makeSyncTestServer();
    const live = createLiveWebSocketServer();
    wss = live;
    const port = await new Promise<number>((resolve) => {
      server = serve(
        { fetch: s.app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: live } },
        (info) => resolve(info.port),
      );
    });
    return { ...s, port };
  }

  interface Sock {
    ws: WebSocket;
    /** Resolves with the close code the client saw. */
    closed: Promise<number>;
    /** Set once closed. */
    code?: number;
  }

  function open(port: number, path: "/sync/live" | "/ui/live"): Promise<Sock> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    sockets.push(ws);
    const sock: Sock = {
      ws,
      closed: new Promise<number>((resolve) =>
        ws.once("close", (code) => {
          sock.code = code;
          resolve(code);
        }),
      ),
    };
    ws.on("error", () => {});
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(sock));
      ws.once("error", reject);
    });
  }

  function hello(sock: Sock, token: string, path: "/sync/live" | "/ui/live" = "/sync/live"): void {
    sock.ws.send(
      JSON.stringify(
        path === "/sync/live"
          ? { type: "hello", device_id: "aaaaaaaa", token }
          : {
              type: "hello",
              device_id: "aaaaaaaa",
              window_id: crypto.randomUUID(),
              token,
              control_enabled: false,
            },
      ),
    );
  }

  /** Open and authenticate; resolves once the server has had time to process the hello. */
  async function authed(port: number, token: string, path: "/sync/live" | "/ui/live") {
    const sock = await open(port, path);
    hello(sock, token, path);
    await sleep(30);
    return sock;
  }

  it("defaults: 10 s hello timeout, 20 per token, 500 in total, 512 KiB frames", () => {
    expect(DEFAULT_LIVE_LIMITS).toEqual({
      helloTimeoutMs: LIVE_HELLO_TIMEOUT_MS,
      maxPerToken: 20,
      maxTotal: 500,
    });
    expect(LIVE_HELLO_TIMEOUT_MS).toBe(10_000);
    expect(LIVE_MAX_PAYLOAD_BYTES).toBe(512 * 1024);
  });

  it.each(["/sync/live", "/ui/live"] as const)(
    "%s: a socket that never says hello is closed 4408 when the timeout runs out",
    async (path) => {
      configureLiveLimits({ helloTimeoutMs: 300 });
      const { port, syncToken } = await start();
      const silent = await open(port, path);
      const prompt = await open(port, path);
      hello(prompt, syncToken, path);
      // Garbage that is not a hello does not count as one.
      const chatty = await open(port, path);
      chatty.ws.send(JSON.stringify({ type: "poke" }));

      const t0 = Date.now();
      expect(await silent.closed).toBe(LIVE_CLOSE.helloTimeout);
      expect(await chatty.closed).toBe(LIVE_CLOSE.helloTimeout);
      expect(Date.now() - t0).toBeLessThan(1500);
      await sleep(400);
      expect(prompt.code).toBeUndefined(); // the one that said hello stays open
    },
  );

  it("the 21st socket for one token is refused 4429; other tokens are unaffected; closing one frees a slot", async () => {
    const { port, syncToken, syncToken2 } = await start();
    // Both endpoints count against the same token.
    const first: Sock[] = [];
    for (let i = 0; i < 10; i++) first.push(await authed(port, syncToken, "/sync/live"));
    for (let i = 0; i < 10; i++) first.push(await authed(port, syncToken, "/ui/live"));

    const extra = await open(port, "/sync/live");
    hello(extra, syncToken);
    expect(await extra.closed).toBe(LIVE_CLOSE.overCapacity);
    expect(first.every((s) => s.code === undefined)).toBe(true);

    const other = await authed(port, syncToken2, "/sync/live");
    await sleep(50);
    expect(other.code).toBeUndefined();

    first[0]?.ws.close();
    await first[0]?.closed;
    await sleep(30);
    const again = await authed(port, syncToken, "/sync/live");
    await sleep(50);
    expect(again.code).toBeUndefined();
  });

  it("a /ui/live window re-announcing itself does not use up its token's slots", async () => {
    configureLiveLimits({ maxPerToken: 2 });
    const { port, syncToken } = await start();
    const win = await authed(port, syncToken, "/ui/live");
    for (let i = 0; i < 5; i++) hello(win, syncToken, "/ui/live");
    const second = await authed(port, syncToken, "/ui/live");
    await sleep(50);
    expect(win.code).toBeUndefined();
    expect(second.code).toBeUndefined();
  });

  it("over the server's total, a new socket is refused 4429 before it can say anything", async () => {
    configureLiveLimits({ maxTotal: 3 });
    const { port, syncToken, syncToken2 } = await start();
    const a = await authed(port, syncToken, "/sync/live");
    const b = await open(port, "/ui/live"); // unauthenticated sockets count too
    await authed(port, syncToken2, "/sync/live");

    const refused = await open(port, "/sync/live");
    hello(refused, syncToken);
    expect(await refused.closed).toBe(LIVE_CLOSE.overCapacity);

    b.ws.close();
    await b.closed;
    await sleep(30);
    const admitted = await authed(port, syncToken, "/sync/live");
    await sleep(50);
    expect(admitted.code).toBeUndefined();
    expect(a.code).toBeUndefined();
  });

  it("an authenticated socket sending a frame over 512 KiB is closed 1009; one under it is not", async () => {
    const { port, syncToken } = await start();
    const ok = await authed(port, syncToken, "/ui/live");
    ok.ws.send(JSON.stringify({ type: "noise", pad: "x".repeat(LIVE_MAX_PAYLOAD_BYTES - 100) }));
    const big = await authed(port, syncToken, "/ui/live");
    big.ws.send("x".repeat(LIVE_MAX_PAYLOAD_BYTES + 1));
    expect(await big.closed).toBe(LIVE_CLOSE.tooBig);
    await sleep(50);
    expect(ok.code).toBeUndefined();
  });

  it("before hello, a frame over 16 KiB is closed 1009", async () => {
    const { port } = await start();
    const sock = await open(port, "/sync/live");
    sock.ws.send("x".repeat(LIVE_MAX_PRE_HELLO_BYTES + 1));
    expect(await sock.closed).toBe(LIVE_CLOSE.tooBig);
  });

  it("the loopback auto-token is exempt from the per-token cap (every local tab shares it)", async () => {
    configureLiveLimits({ maxPerToken: 2 });
    const { port } = await start();
    const session = (await (await fetch(`http://127.0.0.1:${port}/api/session`)).json()) as {
      token: string | null;
    };
    expect(session.token).toBeTruthy();
    const all: Sock[] = [];
    for (let i = 0; i < 5; i++) all.push(await authed(port, session.token as string, "/sync/live"));
    await sleep(50);
    expect(all.every((s) => s.code === undefined)).toBe(true);
  });

  it("serve flags: --ws-max-per-token / --ws-max-total take positive whole numbers", () => {
    expect(parseLiveLimitFlags(parseArgs(["serve"]))).toEqual({});
    expect(
      parseLiveLimitFlags(parseArgs(["serve", "--ws-max-per-token", "5", "--ws-max-total=40"])),
    ).toEqual({ maxPerToken: 5, maxTotal: 40 });
    for (const bad of ["0", "-1", "2.5", "lots"]) {
      expect(() => parseLiveLimitFlags(parseArgs(["serve", `--ws-max-total=${bad}`]))).toThrow(
        /--ws-max-total/,
      );
    }
    expect(() => parseLiveLimitFlags(parseArgs(["serve", "--ws-max-per-token"]))).toThrow();
  });
});
