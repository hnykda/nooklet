/**
 * Sync protocol (ADR 003 / research/03-sync.md §6.5): `POST /sync/push`, `GET /sync/pull`,
 * `GET /sync/snapshot`, `WebSocket /sync/live`. `mountSync` is the single entry point
 * `../http/app.ts` calls to wire all four onto the shared Hono app.
 */

import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { registerSyncLive } from "./live.js";
import { registerSyncPull } from "./pull.js";
import { registerSyncPush } from "./push.js";
import { registerSyncSnapshot } from "./snapshot.js";

export function mountSync(app: Hono, serverCtx: ServerContext): void {
  registerSyncPush(app, serverCtx);
  registerSyncPull(app, serverCtx);
  registerSyncSnapshot(app, serverCtx);
  registerSyncLive(app, serverCtx);
}

export { type CommitEvent, type CommitListener, notifyCommit, onCommit } from "./realtime.js";
