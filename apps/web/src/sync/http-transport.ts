/**
 * The real `SyncTransport` (ADR 003, research/03-sync.md §6.5): `POST /sync/push`,
 * `GET /sync/pull?since=`, `GET /sync/snapshot`, and a `/sync/live` WebSocket for the poke.
 * The server side is `packages/server/src/sync/`.
 *
 * NOT unit tested — it needs a real fetch/WebSocket and a running server. `sync-client.test.ts`
 * covers the *logic* that matters (queueing, batching, cursor advancement, corrections,
 * bootstrap, crash-safety) against a fake `SyncTransport`, and the e2e suite (`e2e/tests/
 * remote-device.spec.ts`, `connectivity.spec.ts`) exercises this file against the real server; so
 * it stays deliberately thin — it only shapes HTTP/WS calls to match `./types.ts`.
 */

import type {
  PullResponse,
  PushRequestBody,
  PushResponse,
  SnapshotResponse,
  SyncLiveHandlers,
  SyncTransport,
} from "./types.js";

export interface HttpTransportOptions {
  /** Origin the app is served from by default; override for a separately-hosted server. */
  baseUrl?: string;
  /** Bearer token (device pairing, ADR 003/005). */
  getToken?: () => string | undefined;
}

function authHeaders(getToken?: () => string | undefined): HeadersInit {
  const token = getToken?.();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`sync request failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function createHttpTransport(opts: HttpTransportOptions = {}): SyncTransport {
  const base = opts.baseUrl ?? "";

  return {
    async push(body: PushRequestBody): Promise<PushResponse> {
      const res = await fetch(`${base}/sync/push`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(opts.getToken) },
        body: JSON.stringify(body),
      });
      return asJson<PushResponse>(res);
    },

    async pull(deviceId: string, since: number, limit = 1000): Promise<PullResponse> {
      const url = new URL(`${base}/sync/pull`, self.location.origin);
      url.searchParams.set("device_id", deviceId);
      url.searchParams.set("since", String(since));
      url.searchParams.set("limit", String(limit));
      const res = await fetch(url, { headers: authHeaders(opts.getToken) });
      return asJson<PullResponse>(res);
    },

    async snapshot(): Promise<SnapshotResponse> {
      const res = await fetch(`${base}/sync/snapshot`, { headers: authHeaders(opts.getToken) });
      return asJson<SnapshotResponse>(res);
    },

    connectLive(deviceId: string, handlers: SyncLiveHandlers): () => void {
      let closedByCaller = false;
      let socket: WebSocket | undefined;
      let retryDelayMs = 1000;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;

      const wsUrl = () => {
        const url = new URL(`${base}/sync/live`, self.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
      };

      const connect = () => {
        if (closedByCaller) return;
        socket = new WebSocket(wsUrl());
        socket.addEventListener("open", () => {
          retryDelayMs = 1000;
          // Auth + device identity travel in the WS handshake's first *message*, not the URL or
          // headers (a browser cannot set a bearer header on a WebSocket upgrade) — see
          // `packages/server/src/sync/live.ts`'s `HelloMessage`/`isHello`.
          socket?.send(
            JSON.stringify({ type: "hello", device_id: deviceId, token: opts.getToken?.() ?? "" }),
          );
          handlers.onOpen();
        });
        socket.addEventListener("message", (ev) => {
          try {
            const msg = JSON.parse(ev.data as string) as { type?: string; seq?: number };
            if (msg.type === "poke") handlers.onPoke(msg.seq ?? 0);
          } catch {
            // ignore malformed frames
          }
        });
        const scheduleReconnect = () => {
          if (closedByCaller) return;
          retryTimer = setTimeout(connect, retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        };
        socket.addEventListener("close", scheduleReconnect);
        socket.addEventListener("error", () => socket?.close());
      };
      connect();

      return () => {
        closedByCaller = true;
        if (retryTimer) clearTimeout(retryTimer);
        socket?.close();
      };
    },
  };
}
