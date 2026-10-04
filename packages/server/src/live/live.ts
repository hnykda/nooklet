/**
 * `WebSocket /ui/live` (ADR 015): a second, dedicated socket, separate from `/sync/live`
 * (`../sync/live.ts`) on purpose — see that file's header and ADR 015 §1 for why. Where `/sync/live`
 * is a one-way, always-on "poke" fire-and-forget channel, this one carries genuine duplex
 * request/response traffic (the server asks a specific window a question and awaits its answer,
 * `./rpc.ts`) and is optional/per-window: a client opens it only while the human has "let agents
 * view this window" enabled, and closes it the instant that toggle goes off. That single fact —
 * the socket being open is the feature being active — is exactly what the client's consent badge
 * displays.
 *
 * Auth mirrors `../sync/live.ts` exactly: the bearer token travels in the handshake's first
 * *message* (a WS upgrade cannot carry a header from a browser), and MUST be a `can_sync` token —
 * "authenticated the same way the client already authenticates sync, its existing per-device
 * session" (ADR 015 §2.1).
 */

import { upgradeWebSocket } from "@hono/node-server";
import { LIVE_CLOSE } from "@nooklet/core";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { socketTokenId, trackTokenSocket, untrackTokenSocket } from "../auth/token-sockets.js";
import { verifyToken } from "../auth/tokens.js";
import { acceptHello, admitSocket, releaseSocket, shouldReadFrame } from "../live-limits.js";
import { registerWindow, resolvePending, unregisterWindow } from "./registry.js";

interface HelloMessage {
  type: "hello";
  device_id: string;
  window_id: string;
  token: string;
  client?: string;
  control_enabled: boolean;
  page?: { id: string; name: string } | null;
  focused?: boolean;
}

function isHello(x: unknown): x is HelloMessage {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.type === "hello" &&
    typeof o.device_id === "string" &&
    typeof o.window_id === "string" &&
    typeof o.token === "string" &&
    typeof o.control_enabled === "boolean"
  );
}

interface ResultMessage {
  type: "state.result" | "command.result";
  request_id: string;
  [k: string]: unknown;
}

function isResultMessage(x: unknown): x is ResultMessage {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    (o.type === "state.result" || o.type === "command.result") && typeof o.request_id === "string"
  );
}

export function registerUiLive(app: Hono, serverCtx: ServerContext): void {
  app.get(
    "/ui/live",
    upgradeWebSocket(() => ({
      // B-676 H4: same limits as `../sync/live.ts` (`../live-limits.ts`); and, as there, admitted
      // with this graph's driver so retiring the graph (B-713) closes it, hello or not.
      onOpen(_evt, ws) {
        admitSocket(ws, serverCtx.driver);
      },
      onMessage(evt, ws) {
        if (!shouldReadFrame(ws, evt.data)) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(evt.data));
        } catch {
          return; // ignore anything that isn't JSON
        }
        if (isHello(parsed)) {
          const verified = verifyToken(serverCtx.driver, parsed.token);
          if (!verified?.canSync) {
            ws.close(LIVE_CLOSE.forbidden, "forbidden");
            return;
          }
          // A window re-sends hello on every page/focus change; only its first counts against the
          // token's connection cap.
          const tracked = socketTokenId(serverCtx.driver, ws) !== undefined;
          if (!acceptHello(serverCtx, ws, verified.id, tracked)) return;
          // B-676: revoking the token closes this window's socket too.
          trackTokenSocket(serverCtx.driver, verified.id, ws);
          registerWindow(serverCtx.driver, ws, {
            deviceId: parsed.device_id,
            windowId: parsed.window_id,
            client: parsed.client,
            controlEnabled: parsed.control_enabled,
            page: parsed.page,
            focused: parsed.focused,
          });
          return;
        }
        if (isResultMessage(parsed)) {
          // Only the socket a request went to can answer it (`registry.ts#resolvePending`).
          resolvePending(serverCtx.driver, ws, parsed.request_id, parsed);
        }
        // Anything else (unrecognized `type`) is ignored, same tolerance as ../sync/live.ts.
      },
      onClose(_evt, ws) {
        releaseSocket(ws);
        unregisterWindow(serverCtx.driver, ws);
        untrackTokenSocket(serverCtx.driver, ws);
      },
    })),
  );
}
