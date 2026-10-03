/**
 * A switchable TCP proxy in front of the suite's server — for what the client does when its server
 * really goes away (B-614), without stopping the server every other spec shares.
 *
 * Why a proxy and not a browser-side stand-in: Playwright's `routeWebSocket` does not intercept a
 * socket opened inside a dedicated worker, which is where the sync client's live socket lives
 * (checked: zero sockets routed), so only the network itself can take that socket away. `down()`
 * destroys every open connection and stops listening — new connections are refused, exactly what
 * a stopped server looks like from the browser. `up()` listens again.
 *
 * Its port is `NOOKLET_E2E_SCRATCH_PORT`, defaulting to the suite's own port + 1, so concurrent
 * runs on different suite ports keep apart the same way their main servers do. Being a different
 * origin from the suite's server, a page loaded through it also gets its own storage.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";

const SUITE_PORT = Number(process.env.NOOKLET_E2E_PORT ?? 6188);
export const SCRATCH_PORT = Number(process.env.NOOKLET_E2E_SCRATCH_PORT ?? SUITE_PORT + 1);

export interface SwitchableServer {
  /** The suite's server, reached through the proxy. */
  url: string;
  down(): Promise<void>;
  up(): Promise<void>;
  dispose(): Promise<void>;
}

export async function startSwitchableServer(): Promise<SwitchableServer> {
  const sockets = new Set<Socket>();
  let server: Server | undefined;

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const s = createServer((client) => {
        const upstream = createConnection({ host: "127.0.0.1", port: SUITE_PORT });
        for (const sock of [client, upstream]) {
          sockets.add(sock);
          sock.on("close", () => sockets.delete(sock));
          sock.on("error", () => {
            client.destroy();
            upstream.destroy();
          });
        }
        client.pipe(upstream).pipe(client);
      });
      s.once("error", reject);
      s.listen(SCRATCH_PORT, "127.0.0.1", () => resolve());
      server = s;
    });

  const close = () =>
    new Promise<void>((resolve) => {
      for (const sock of sockets) sock.destroy();
      sockets.clear();
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    });

  await listen();
  return {
    url: `http://127.0.0.1:${SCRATCH_PORT}`,
    down: close,
    up: listen,
    dispose: close,
  };
}
