/**
 * Sync-specific bearer-token gate.
 *
 * `../auth/tokens.ts`'s `bearerAuth` Hono middleware is mounted only at `/api/v1/*`
 * (`../http/app.ts`), so it never runs for `/sync/*`. Every sync route needs the same bearer-token
 * parsing PLUS the orthogonal `can_sync` capability check (00-conventions.md: "device tokens carry
 * `sync` in addition to `write`"; `docs/spec/sql-schema.md` rule 22), so this small helper is
 * called directly from each route instead of being wired as separate middleware — the WebSocket
 * route (`./live.ts`) authenticates from its first message rather than a header (browsers cannot
 * set custom headers on a WS handshake) and needs the same check invoked a different way, so a
 * shared middleware would not cover it anyway.
 */

import type { SqlDriver } from "@nooklet/core";
import type { Context } from "hono";
import { type VerifiedToken, verifyToken } from "../auth/tokens.js";

/** Returns the verified, sync-capable token, or a ready-to-return `Response` on failure
 * (401 missing/invalid token, 403 token lacks `can_sync`) using the conventions doc's error
 * envelope. Callers do `const auth = requireSyncToken(c, driver); if (auth instanceof Response)
 * return auth;`. */
export function requireSyncToken(c: Context, driver: SqlDriver): VerifiedToken | Response {
  const header = c.req.header("authorization");
  const raw = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!raw) {
    return c.json(
      { error: { code: "unauthorized", message: "missing or invalid bearer token" } },
      401,
    );
  }
  const verified = verifyToken(driver, raw);
  if (!verified) {
    return c.json(
      { error: { code: "unauthorized", message: "missing or invalid bearer token" } },
      401,
    );
  }
  if (!verified.canSync) {
    return c.json(
      { error: { code: "forbidden", message: "token does not have sync (can_sync) capability" } },
      403,
    );
  }
  return verified;
}
