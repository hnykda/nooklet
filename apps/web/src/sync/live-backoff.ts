/**
 * When to reconnect a live WebSocket (`/sync/live` in `./http-transport.ts`, `/ui/live` in
 * `../live/socket.ts`) after it closes, by close code (B-676 H4).
 *
 * Both sockets used to reset their delay to 1 s on every `open` and double it on every close. A
 * server that accepts the connection and then refuses it (over its connection cap, 4429) made
 * that a reconnect every second, forever, from every refused tab: exactly the load the cap exists
 * to shed. So:
 *
 *   - 4401 / 4403 (token refused): stop. Only re-pairing fixes it, and that reloads the page.
 *   - 4410 (graph retired on the server, B-713): stop. Reconnecting would only get a 404.
 *   - 4429 (over capacity) / 1009 (frame too big): a refusal, not a blip. Wait 30 s, doubling to
 *     5 min, with ±20% jitter so a server restart's worth of refused clients does not return in
 *     lockstep.
 *   - anything else (1006 network, 1001 server going away, 4408 hello timeout): 1 s, doubling to
 *     30 s, as before.
 *
 * The delays reset only once a socket has stayed open for `STABLE_MS`, not on `open`: a refused
 * socket opens first, then closes when its hello is judged, so `open` proves nothing. `STABLE_MS`
 * is longer than the server's hello timeout, so even a 4408 close never counts as stable.
 */

import { LIVE_CLOSE, LIVE_HELLO_TIMEOUT_MS } from "@nooklet/core";
import { LIVE_TERMINAL_CODES } from "./types.js";

export const LIVE_RETRY_BASE_MS = 1000;
export const LIVE_RETRY_MAX_MS = 30_000;
export const LIVE_REFUSED_BASE_MS = 30_000;
export const LIVE_REFUSED_MAX_MS = 5 * 60_000;
export const STABLE_MS = LIVE_HELLO_TIMEOUT_MS + 5000;

/** Close codes that mean "the server is refusing this connection for now", not "the network
 * dropped": back off long. */
export const LIVE_REFUSED_CODES: ReadonlySet<number> = new Set([
  LIVE_CLOSE.overCapacity,
  LIVE_CLOSE.tooBig,
]);

/** The indicator's explanation for a refused live socket (`SyncStatus.liveNote`). */
export function liveRefusedNote(code: number): string {
  return code === LIVE_CLOSE.overCapacity
    ? "the server is at its connection limit"
    : "the server refused a message as too large";
}

export interface LiveRetry {
  /** The socket opened. */
  onOpen(): void;
  /** The socket closed (or failed to open) with `code`: how long to wait before reconnecting, or
   * `null` to stop. */
  onClose(code: number): number | null;
}

export function createLiveRetry(
  opts: { now?: () => number; random?: () => number } = {},
): LiveRetry {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  let delayMs = LIVE_RETRY_BASE_MS;
  let refusals = 0;
  let openedAt: number | undefined;

  return {
    onOpen() {
      openedAt = now();
    },
    onClose(code) {
      if (openedAt !== undefined && now() - openedAt >= STABLE_MS) {
        delayMs = LIVE_RETRY_BASE_MS;
        refusals = 0;
      }
      openedAt = undefined;
      if (LIVE_TERMINAL_CODES.has(code)) return null;
      if (LIVE_REFUSED_CODES.has(code)) {
        const base = Math.min(LIVE_REFUSED_BASE_MS * 2 ** refusals, LIVE_REFUSED_MAX_MS);
        refusals++;
        return Math.round(base * (0.8 + 0.4 * random()));
      }
      const wait = delayMs;
      delayMs = Math.min(delayMs * 2, LIVE_RETRY_MAX_MS);
      return wait;
    },
  };
}
