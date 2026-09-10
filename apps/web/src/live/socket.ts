/**
 * The real `/ui/live` WebSocket client (ADR 015 §2.1), mirroring `../sync/http-transport.ts`'s
 * shape and its own header comment's reasoning: NOT unit tested — it needs a real `WebSocket` — so
 * it is kept deliberately thin, wiring `./message-handler.ts#handleIncomingFrame` (where all the
 * protocol logic actually lives and is tested) to real socket events. Reconnects with the same
 * backoff `http-transport.ts#connectLive` uses.
 *
 * Callers (`../app/CommandLayer.tsx`) own the policy of WHEN to call `connectLiveSocket`/`stop` —
 * "only while the user has enabled viewing" (ADR 015 §2.6) — this module just connects when asked.
 */

import { handleIncomingFrame, type MessageHandlerDeps } from "./message-handler.js";
import type { HelloMessage } from "./types.js";

export interface LiveSocketOptions extends MessageHandlerDeps {
  /** Origin the app is served from by default; override for a separately-hosted server. Same
   * default convention as `../sync/http-transport.ts`/`../data/api-client.ts`. */
  baseUrl?: string;
  deviceId: string;
  windowId: string;
  client: string;
  getToken: () => string | undefined;
  getControlEnabled: () => boolean;
  getPage: () => { id: string; name: string } | null;
  getFocused: () => boolean;
  onConnectedChange?: (connected: boolean) => void;
}

export interface LiveSocketHandle {
  /** Close the connection and stop reconnecting. */
  stop(): void;
  /** Re-send `hello` on the current connection (if open) to report a control-toggle/page/focus
   * change — ADR 015 §1's "keep it updated." A no-op while disconnected; the next successful
   * connect's own initial hello already reflects current state. */
  reannounce(): void;
}

export function connectLiveSocket(opts: LiveSocketOptions): LiveSocketHandle {
  let closedByCaller = false;
  let socket: WebSocket | undefined;
  let retryDelayMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const wsUrl = (): string => {
    const base = opts.baseUrl ?? "";
    const url = new URL(`${base}/ui/live`, self.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  };

  const hello = (): HelloMessage => ({
    type: "hello",
    device_id: opts.deviceId,
    window_id: opts.windowId,
    token: opts.getToken() ?? "",
    client: opts.client,
    control_enabled: opts.getControlEnabled(),
    page: opts.getPage(),
    focused: opts.getFocused(),
  });

  const connect = (): void => {
    if (closedByCaller) return;
    socket = new WebSocket(wsUrl());
    socket.addEventListener("open", () => {
      retryDelayMs = 1000;
      socket?.send(JSON.stringify(hello()));
      opts.onConnectedChange?.(true);
    });
    socket.addEventListener("message", (ev) => {
      void handleIncomingFrame(String(ev.data), opts).then((reply) => {
        if (reply) socket?.send(reply);
      });
    });
    const scheduleReconnect = (): void => {
      opts.onConnectedChange?.(false);
      if (closedByCaller) return;
      retryTimer = setTimeout(connect, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    };
    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => socket?.close());
  };
  connect();

  return {
    stop() {
      closedByCaller = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    },
    reannounce() {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(hello()));
    },
  };
}
