/**
 * Request/response over `/ui/live` (ADR 015 §2): the server asks a specific window a question
 * (`state.get`, `command.run`) and awaits its answer, correlated by a fresh `request_id` per call.
 * A window that does not answer within the timeout is reported back as unreachable — never thrown
 * as an error — so a single slow/busy tab degrades one tool call gracefully instead of surfacing
 * as a broken MCP tool.
 */

import type { SqlDriver } from "@nooklet/core";
import type { WSContext } from "hono/ws";
import { clearPending, registerPending } from "./registry.js";

/** ADR 015 §2: "~2s" default. Overridable per call (tests use a much shorter value). */
export const DEFAULT_RPC_TIMEOUT_MS = 2000;

export type RpcResult<T> = { timedOut: false; data: T } | { timedOut: true };

/**
 * Send `message` (any JSON-serializable object without a `request_id` — one is minted here) to
 * `ws` and resolve once a matching `state.result`/`command.result` frame is fed back through
 * `../live/registry.ts#resolvePending`, or after `timeoutMs` elapses. Never rejects: a dead socket
 * (send throws) or a silent window both resolve `{ timedOut: true }`, exactly like a real timeout,
 * so callers have exactly one "did not answer" branch to handle.
 */
export function sendRequest<T = unknown>(
  driver: SqlDriver,
  ws: WSContext,
  message: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<RpcResult<T>> {
  const requestId = crypto.randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearPending(driver, requestId);
      resolve({ timedOut: true });
    }, timeoutMs);
    // Node timers keep the process alive by default; `unref` so a test process (or `nooklet
    // serve` shutting down) never waits out an in-flight request's timeout to exit.
    timer.unref?.();

    registerPending(driver, ws, requestId, {
      resolve: (data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, data: data as T });
      },
      // The window closed mid-request (`registry.ts#unregisterWindow`): same outcome as a
      // timeout, just without the wait.
      fail: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: true });
      },
    });

    try {
      ws.send(JSON.stringify({ ...message, request_id: requestId }));
    } catch {
      // Best-effort send, matching ../sync/realtime.ts's `wirePokeOnCommit`: a dead socket also
      // fires its own `onClose` -> `unregisterWindow`, and this call's own timeout above still
      // fires normally, so the caller sees `{ timedOut: true }` rather than a thrown error.
    }
  });
}
