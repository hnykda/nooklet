/**
 * The "commit -> poke" seam (ADR 003 §6.5 / research/03-sync.md §6.5: "pokes all other devices
 * over WS ... clients then pull").
 *
 * `serverApplyOps` (`../apply-ops.ts`) has no transport role and MUST NOT be edited to know about
 * HTTP/WebSocket concerns (task constraint). Instead, this module exposes a tiny subscribe/notify
 * pair:
 *
 *   - `onCommit(ctx, listener)` registers a listener; used today by `./live.ts` to wire the actual
 *     WebSocket broadcast (`wirePokeOnCommit`).
 *   - `notifyCommit(ctx, seq, originDeviceId?)` is called by whoever just committed something,
 *     right after their own `serverApplyOps` call returns. Today that is only `./push.ts` (the
 *     sync HTTP push route). It is exported from `./index.ts` so a FUTURE write path — most
 *     likely the ops registry's HTTP/MCP write path (`../ops/registry.ts`'s
 *     `buildOpContext().applyOps`, which also wraps `serverApplyOps`) — can opt into the same
 *     poke-on-write behavior later by calling `notifyCommit` itself. Nothing here requires that;
 *     it is a documented extension point, not a dependency.
 *
 * State is keyed by `ServerContext` via a `WeakMap` rather than a bare module-level singleton: in
 * production there is exactly one `ServerContext` per process (ADR: "one graph per server in
 * v1"), so this makes no practical difference there, but it keeps multiple `ServerContext`s
 * created within one test process (e.g. two `makeSyncTestServer()` calls across different tests)
 * from cross-poking each other's WebSocket clients.
 */

import type { WSContext } from "hono/ws";
import type { ServerContext } from "../apply-ops.js";

export interface CommitEvent {
  seq: number;
  /** The device that caused the commit, when known (a device push). Omitted for
   * server/API-originated writes, which have no single "device" to exclude from the poke. */
  deviceId?: string;
}

export type CommitListener = (event: CommitEvent) => void;

interface RealtimeState {
  listeners: Set<CommitListener>;
  /** Live `/sync/live` connections, keyed by the `WSContext` object itself, valued by the
   * `device_id` the connection announced in its `hello` message (unset until then). */
  connections: Map<WSContext, string>;
}

const states = new WeakMap<ServerContext, RealtimeState>();
/** Guards `wirePokeOnCommit` so mounting the sync routes twice against the same `ServerContext`
 * (should not happen in practice, but costs nothing to guard) does not double-broadcast pokes. */
const wired = new WeakSet<ServerContext>();

function stateFor(ctx: ServerContext): RealtimeState {
  let s = states.get(ctx);
  if (!s) {
    s = { listeners: new Set(), connections: new Map() };
    states.set(ctx, s);
  }
  return s;
}

/** Subscribe to commits on `ctx`. Returns an unsubscribe function. */
export function onCommit(ctx: ServerContext, listener: CommitListener): () => void {
  const s = stateFor(ctx);
  s.listeners.add(listener);
  return () => s.listeners.delete(listener);
}

/** Announce that `ctx` just committed something through `serverApplyOps`, up to `seq`. See file
 * header: call this after your own `serverApplyOps` call, do not expect `apply-ops.ts` to call it
 * for you. */
export function notifyCommit(ctx: ServerContext, seq: number, originDeviceId?: string): void {
  const s = stateFor(ctx);
  for (const listener of s.listeners) listener({ seq, deviceId: originDeviceId });
}

export function registerLiveConnection(ctx: ServerContext, ws: WSContext, deviceId: string): void {
  stateFor(ctx).connections.set(ws, deviceId);
}

export function unregisterLiveConnection(ctx: ServerContext, ws: WSContext): void {
  stateFor(ctx).connections.delete(ws);
}

/**
 * Wire the actual poke: on every commit, tell every `/sync/live` connection except the one(s)
 * belonging to the device that caused it (if any) `{type:'poke', seq}` (ADR 003: "poke only, no
 * payload, exactly as ... specified"). Safe to call more than once per `ctx` (a no-op after the
 * first call).
 */
export function wirePokeOnCommit(ctx: ServerContext): void {
  if (wired.has(ctx)) return;
  wired.add(ctx);
  onCommit(ctx, ({ seq, deviceId: originDeviceId }) => {
    const s = stateFor(ctx);
    const message = JSON.stringify({ type: "poke", seq });
    for (const [ws, deviceId] of s.connections) {
      if (deviceId === originDeviceId) continue;
      try {
        ws.send(message);
      } catch {
        // Best-effort: a dead socket also fires its own `onClose`, which unregisters it.
      }
    }
  });
}
