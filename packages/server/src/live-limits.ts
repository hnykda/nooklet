/**
 * Limits on the two first-message-authenticated WebSockets, `/sync/live` and `/ui/live` (B-676
 * H4/H12). Before this, anyone who could reach the port could open sockets that never said hello
 * and keep them forever, as many as they liked, each allowed to send 100 MiB frames (the `ws`
 * default `maxPayload`): `tools/probes/security/ws-revocation.mjs` held one open for 12 s with
 * nothing closing it.
 *
 * What each socket goes through, in both routes' handlers:
 *
 *   onOpen     `admitSocket`: over the process-wide total -> close 4429; else start the hello timer
 *   onMessage  `shouldReadFrame` before auth: a frame over 16 KiB -> close 1009
 *              `acceptHello` on a valid-token hello: stop the timer; over the token's cap -> 4429
 *   timer      no valid hello within 10 s -> close 4408
 *   onClose    `releaseSocket`
 *
 * The frame limit proper is the `ws` server's `maxPayload` (`createLiveWebSocketServer`), which
 * `ws` enforces while reading the frame, before it is buffered whole.
 *
 * The total is per process, not per graph: every graph's sockets share one `WebSocketServer` and
 * one file-descriptor budget. The per-token count is per graph, because a token id only means
 * something inside its own graph (`./auth/token-sockets.ts`, which this reuses for the count).
 */

import {
  LIVE_CLOSE,
  LIVE_DEFAULT_MAX_PER_TOKEN,
  LIVE_DEFAULT_MAX_TOTAL,
  LIVE_HELLO_TIMEOUT_MS,
  LIVE_MAX_PAYLOAD_BYTES,
  LIVE_MAX_PRE_HELLO_BYTES,
} from "@nooklet/core";
import type { WSContext } from "hono/ws";
import { WebSocketServer } from "ws";
import type { ServerContext } from "./apply-ops.js";
import { tokenSocketCount } from "./auth/token-sockets.js";
import type { Args } from "./cli-args.js";
import { CliArgError } from "./cli-args.js";
import { isWebClientTokenId } from "./http/app.js";

export interface LiveLimits {
  helloTimeoutMs: number;
  maxPerToken: number;
  maxTotal: number;
}

export const DEFAULT_LIVE_LIMITS: Readonly<LiveLimits> = {
  helloTimeoutMs: LIVE_HELLO_TIMEOUT_MS,
  maxPerToken: LIVE_DEFAULT_MAX_PER_TOKEN,
  maxTotal: LIVE_DEFAULT_MAX_TOTAL,
};

let limits: LiveLimits = { ...DEFAULT_LIVE_LIMITS };

/** Set by `nooklet serve` from its flags, and by tests. Unset fields keep their defaults. */
export function configureLiveLimits(patch: Partial<LiveLimits>): void {
  limits = { ...DEFAULT_LIVE_LIMITS, ...patch };
}

export function liveLimits(): Readonly<LiveLimits> {
  return limits;
}

/** The `ws` server both routes are handed to. `maxPayload` is the one limit `ws` itself enforces:
 * a longer frame is refused with 1009 while its header is read, before the payload is buffered. */
export function createLiveWebSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: LIVE_MAX_PAYLOAD_BYTES });
}

/** Sockets admitted and not yet closed, authenticated or not, across every graph. */
const admitted = new Map<
  WSContext,
  { helloTimer: ReturnType<typeof setTimeout>; authed: boolean }
>();

export function openLiveSocketCount(): number {
  return admitted.size;
}

function closeQuietly(ws: WSContext, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closing.
  }
}

/** `onOpen`. Returns false (and closes the socket) when the server is at its total. */
export function admitSocket(ws: WSContext): boolean {
  if (admitted.size >= limits.maxTotal) {
    closeQuietly(ws, LIVE_CLOSE.overCapacity, "server connection limit");
    return false;
  }
  const helloTimer = setTimeout(
    () => closeQuietly(ws, LIVE_CLOSE.helloTimeout, "no hello"),
    limits.helloTimeoutMs,
  );
  // A pending hello timer must not keep a test runner or a shutting-down process alive.
  helloTimer.unref?.();
  admitted.set(ws, { helloTimer, authed: false });
  return true;
}

/** `onClose`. Safe for a socket that was never admitted. */
export function releaseSocket(ws: WSContext): void {
  const entry = admitted.get(ws);
  if (entry) clearTimeout(entry.helloTimer);
  admitted.delete(ws);
}

/**
 * `onMessage`, before parsing: whether to read this frame at all. False for a socket that was
 * refused at `admitSocket` (already closing), and for a frame over `LIVE_MAX_PRE_HELLO_BYTES` from
 * a socket that has not authenticated yet, which is closed with 1009. Text is measured in UTF-16
 * code units, never more than its UTF-8 byte count.
 */
export function shouldReadFrame(ws: WSContext, data: unknown): boolean {
  const entry = admitted.get(ws);
  if (!entry) return false;
  if (entry.authed) return true;
  const size =
    typeof data === "string"
      ? data.length
      : data instanceof ArrayBuffer
        ? data.byteLength
        : String(data).length;
  if (size <= LIVE_MAX_PRE_HELLO_BYTES) return true;
  closeQuietly(ws, LIVE_CLOSE.tooBig, "hello too large");
  return false;
}

/**
 * A hello whose token verified. Stops the hello timer, then applies the per-token cap: returns
 * false (and closes the socket 4429) when the token already has `maxPerToken` sockets open in this
 * graph. Call BEFORE `trackTokenSocket`, which is what the count reads. A repeated hello on a socket
 * already counted (`/ui/live` re-announces page and focus changes) is not a new connection.
 */
export function acceptHello(
  serverCtx: ServerContext,
  ws: WSContext,
  tokenId: string,
  alreadyTracked: boolean,
): boolean {
  const entry = admitted.get(ws);
  if (!entry) return false;
  clearTimeout(entry.helloTimer);
  const exempt = alreadyTracked || isWebClientTokenId(serverCtx, tokenId);
  if (!exempt && tokenSocketCount(serverCtx.driver, tokenId) >= limits.maxPerToken) {
    closeQuietly(ws, LIVE_CLOSE.overCapacity, "too many connections for this token");
    return false;
  }
  entry.authed = true;
  return true;
}

export const LIVE_LIMIT_FLAGS = ["ws-max-per-token", "ws-max-total"] as const;

/** `nooklet serve --ws-max-per-token <n> --ws-max-total <n>`: positive integers. */
export function parseLiveLimitFlags(args: Args): Partial<LiveLimits> {
  const out: Partial<LiveLimits> = {};
  const read = (flag: string): number | undefined => {
    const v = args.flags.get(flag);
    if (v === undefined) return undefined;
    const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : Number.NaN;
    if (!(Number.isSafeInteger(n) && n >= 1)) {
      throw new CliArgError(`--${flag} takes a whole number of connections (1 or more)`);
    }
    return n;
  };
  const perToken = read("ws-max-per-token");
  const total = read("ws-max-total");
  if (perToken !== undefined) out.maxPerToken = perToken;
  if (total !== undefined) out.maxTotal = total;
  return out;
}
