/**
 * The `/ui/live` window registry (ADR 015 §1-2): an in-memory-only table of currently-connected
 * browser/app windows, keyed by `(device_id, window_id)`. Deliberately never persisted and never
 * something `rebuild()` reproduces — it describes "what is on screen right now," which stops being
 * true the instant a tab closes.
 *
 * Modeled as a `WeakMap<SqlDriver, ...>` — keyed by the graph's `SqlDriver` rather than the
 * `ServerContext` wrapper around it — for two reasons: (1) it gives the same "one process, one
 * driver in production; never cross-talk between drivers created within one test process" property
 * `../sync/realtime.ts`'s own `WeakMap<ServerContext, ...>` has, since a `SqlDriver` is exactly as
 * stable an identity per running server; (2) it lets every `ui.*` op handler (`OpContext`) reach
 * this registry through `ctx.db` — a field `@nooklet/plugin-api`'s public `OpContext` ALREADY
 * declares — instead of a new `OpContext.serverCtx` field, which would need to also exist on
 * plugin-api's `OpContext` (a type that deliberately never imports anything server-internal) to
 * keep `packages/plugin-api/src/assignability.test.ts`'s cross-package check passing.
 *
 * This file also owns the request/response correlation table (`sendRequest`/`resolvePending` in
 * `./rpc.ts` read and write it) since both concerns share one per-driver state bag and a window's
 * registry entry and its in-flight requests are naturally the same lifetime (a closed connection
 * should fail its own pending requests immediately rather than waiting out the timeout — see
 * `unregisterWindow`).
 */

import type { SqlDriver } from "@nooklet/core";
import type { WSContext } from "hono/ws";

export interface LiveWindowPage {
  id: string;
  name: string;
}

export interface HelloInfo {
  deviceId: string;
  windowId: string;
  client?: string;
  controlEnabled: boolean;
  /** Optional extra fields a `hello` MAY carry beyond ADR 015's baseline `{device_id, window_id,
   * client, control_enabled}`, so a window can "keep it updated" (§1) by re-sending `hello`
   * whenever its page or focus changes, rather than needing a second message type. */
  page?: LiveWindowPage | null;
  focused?: boolean;
}

export interface LiveWindowRecord {
  ws: WSContext;
  deviceId: string;
  windowId: string;
  client?: string;
  controlEnabled: boolean;
  connectedAt: number;
  lastActiveAt: number;
  /** Internal-only tie-breaker for `mostRecentlyActive`, never put on the wire: a strictly
   * increasing counter, since two windows can register within the same wall-clock millisecond
   * (a reconnect burst, or simply a fast machine) and `lastActiveAt` alone would then tie. */
  activitySeq: number;
  focused: boolean;
  page: LiveWindowPage | null;
}

export interface PendingRequest {
  /** The socket the request went to — the only one allowed to answer it. */
  ws: WSContext;
  resolve: (data: unknown) => void;
  /** Settle as "did not answer" without waiting out the timeout (the window went away). */
  fail: () => void;
}

interface LiveState {
  /** Keyed by the `WSContext` identity, mirroring `../sync/realtime.ts`'s `connections` map. */
  windows: Map<WSContext, LiveWindowRecord>;
  pending: Map<string, PendingRequest>;
  nextActivitySeq: number;
}

const states = new WeakMap<SqlDriver, LiveState>();

function stateFor(driver: SqlDriver): LiveState {
  let s = states.get(driver);
  if (!s) {
    s = { windows: new Map(), pending: new Map(), nextActivitySeq: 0 };
    states.set(driver, s);
  }
  return s;
}

/** Register a fresh connection, or update an existing one in place — a window "keeps `hello`
 * updated" (§1) by re-sending it on its own socket whenever its page/focus changes; this is an
 * upsert keyed by the `WSContext` identity, never a second entry for the same socket. */
export function registerWindow(driver: SqlDriver, ws: WSContext, hello: HelloInfo): void {
  const s = stateFor(driver);
  const now = Date.now();
  const existing = s.windows.get(ws);
  s.windows.set(ws, {
    ws,
    deviceId: hello.deviceId,
    windowId: hello.windowId,
    client: hello.client,
    controlEnabled: hello.controlEnabled,
    connectedAt: existing?.connectedAt ?? now,
    lastActiveAt: now,
    activitySeq: s.nextActivitySeq++,
    focused: hello.focused ?? existing?.focused ?? false,
    page: hello.page !== undefined ? hello.page : (existing?.page ?? null),
  });
}

/** Drop a connection's registry entry and fail any of its in-flight requests immediately (rather
 * than making a caller wait out the full ~2s timeout for a socket that is already known to be
 * gone). Safe to call for a `ws` that was never registered. */
export function unregisterWindow(driver: SqlDriver, ws: WSContext): void {
  const s = stateFor(driver);
  s.windows.delete(ws);
  for (const [requestId, pending] of s.pending) {
    if (pending.ws !== ws) continue;
    s.pending.delete(requestId);
    pending.fail();
  }
}

/** Whether `ws` has announced itself with a valid `hello` and is still connected. */
export function isRegisteredWindow(driver: SqlDriver, ws: WSContext): boolean {
  return stateFor(driver).windows.has(ws);
}

export function listWindows(driver: SqlDriver): LiveWindowRecord[] {
  return [...stateFor(driver).windows.values()];
}

/** Look up a window by `window_id` alone (the wire identity `ui_state`/`ui_run` take —
 * ADR 015 assumes `window_id` is unique per live graph, a random per-tab session id). */
export function findWindowById(driver: SqlDriver, windowId: string): LiveWindowRecord | undefined {
  return listWindows(driver).find((w) => w.windowId === windowId);
}

/** The window that most recently reported a focus/page change via `hello` (§2's resolution
 * policy for reads). Ordered by `activitySeq`, not the wall-clock `lastActiveAt`, so two windows
 * registering within the same millisecond still resolve deterministically to whichever actually
 * registered last. */
export function mostRecentlyActive(driver: SqlDriver): LiveWindowRecord | undefined {
  const all = listWindows(driver);
  if (all.length === 0) return undefined;
  return [...all].sort((a, b) => b.activitySeq - a.activitySeq)[0];
}

// ------------------------------------------------------------------------------------------------
// Request/response correlation (backs ./rpc.ts's sendRequest; see file header)
// ------------------------------------------------------------------------------------------------

export function registerPending(
  driver: SqlDriver,
  ws: WSContext,
  requestId: string,
  handlers: { resolve: (data: unknown) => void; fail: () => void },
): void {
  stateFor(driver).pending.set(requestId, { ws, ...handlers });
}

export function clearPending(driver: SqlDriver, requestId: string): void {
  stateFor(driver).pending.delete(requestId);
}

/**
 * Called by `./live.ts`'s `onMessage` when a `state.result`/`command.result` frame arrives on
 * `ws`. Returns `true` if a pending request was found (and resolved), `false` for an unknown or
 * already-settled `request_id` (a reply just after its own timeout — an expected race, not an
 * error) — and `false` when the request exists but was sent to a DIFFERENT socket: a window may
 * only answer what it was asked. `request_id`s are random UUIDs, so guessing one is not practical,
 * but a socket that never completed `hello` should not be able to answer anything at all.
 */
export function resolvePending(
  driver: SqlDriver,
  ws: WSContext,
  requestId: string,
  data: unknown,
): boolean {
  const s = stateFor(driver);
  const p = s.pending.get(requestId);
  if (!p || p.ws !== ws) return false;
  s.pending.delete(requestId);
  p.resolve(data);
  return true;
}
