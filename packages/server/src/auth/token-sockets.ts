/**
 * Which open WebSockets (`/sync/live`, `/ui/live`) were authenticated by which token, so revoking a
 * token can close them (B-676, recommendation H3).
 *
 * HTTP re-reads the token row on every request, so revocation was already immediate there. A
 * socket authenticates once, in its first message, and before this kept receiving pokes (and, for
 * `/ui/live`, agent requests) for as long as it stayed open after the token was revoked.
 *
 * Keyed by the graph's `SqlDriver`, like `../live/registry.ts`: a token id only means something
 * inside its own graph's database. Close code 4401 tells the client "your credential is gone",
 * distinct from 4403 (a hello with a token that was never valid for sync).
 *
 * Revocation through `token.revoke` closes at once. `nooklet token revoke` runs in another process
 * and cannot reach these sockets; `/sync/live`'s poke re-checks the row before sending
 * (`../sync/realtime.ts`), so such a socket is closed at the next commit instead.
 */

import type { SqlDriver } from "@nooklet/core";
import type { WSContext } from "hono/ws";

export const REVOKED_CLOSE_CODE = 4401;

const sockets = new WeakMap<SqlDriver, Map<WSContext, string>>();

function mapFor(driver: SqlDriver): Map<WSContext, string> {
  let m = sockets.get(driver);
  if (!m) {
    m = new Map();
    sockets.set(driver, m);
  }
  return m;
}

export function trackTokenSocket(driver: SqlDriver, tokenId: string, ws: WSContext): void {
  mapFor(driver).set(ws, tokenId);
}

export function untrackTokenSocket(driver: SqlDriver, ws: WSContext): void {
  sockets.get(driver)?.delete(ws);
}

/** The token a socket authenticated with, if it has. */
export function socketTokenId(driver: SqlDriver, ws: WSContext): string | undefined {
  return sockets.get(driver)?.get(ws);
}

/** Close every socket `tokenId` opened. Returns how many. */
export function closeTokenSockets(driver: SqlDriver, tokenId: string): number {
  const m = sockets.get(driver);
  if (!m) return 0;
  let closed = 0;
  for (const [ws, id] of m) {
    if (id !== tokenId) continue;
    m.delete(ws);
    try {
      ws.close(REVOKED_CLOSE_CODE, "token revoked");
    } catch {
      // Already closing; its own onClose cleans up the rest.
    }
    closed++;
  }
  return closed;
}

/** Whether a token row is revoked (or gone). A plain read: no `last_used_at` write, unlike
 * `verifyToken`, because the poke path calls it on every commit. */
export function isTokenRevoked(driver: SqlDriver, tokenId: string): boolean {
  const row = driver.get<{ revoked_at: number | null }>(
    "SELECT revoked_at FROM token WHERE id = ?",
    [tokenId],
  );
  return !row || row.revoked_at !== null;
}
