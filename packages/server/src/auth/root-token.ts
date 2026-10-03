/**
 * The root token (ADR 025): gates `GET /graphs`/`POST /graphs`, the two endpoints that span every
 * graph a server hosts rather than belonging to one. A per-graph token (`./tokens.ts`) can't do
 * this — it lives inside that graph's own SQLite file, so verifying it needs a driver already
 * scoped to the very graph the request is asking to list *alongside* others. This token instead
 * lives outside every graph's file, at `<dataDir>/root.token`: an operator credential for the
 * server as a whole, not a user identity — there is no root-token registry, no scopes, no
 * revocation, just one secret, generated once and reused across restarts (unlike the per-boot
 * `createSoleToken` web-client convenience token in `../http/app.ts`, which is fine to mint fresh
 * every launch since nothing needs to remember it across a restart).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MiddlewareHandler } from "hono";
import { rootTokenPath } from "../graphs/paths.js";

/** Reads `<dataDir>/root.token`, generating and persisting one on first call. Returns
 * `{token, created}` so `nooklet serve` can print it the moment it's minted, unprompted — `nooklet
 * token root` (`cli.ts`) calls this same function afterward, any time, to show it again. */
export function ensureRootToken(dataDir: string): { token: string; created: boolean } {
  const path = rootTokenPath(dataDir);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return { token: existing, created: false };
  } catch {
    // No file yet, or unreadable: fall through and mint one.
  }
  const token = `nkroot_${randomBytes(24).toString("hex")}`;
  // B-638: on a first `serve --data <new dir>` nothing has made the data dir yet — graphs are
  // mounted lazily (ADR 025) — so create it here rather than die with ENOENT. Owner-only, like
  // the token file itself.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return { token, created: true };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Length is compared first (leaks nothing sensitive — token length is fixed and public in
  // shape); timingSafeEqual itself throws on mismatched lengths rather than reporting `false`.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Bearer-auth middleware for the root token alone, mirroring `./tokens.ts#bearerAuth`'s shape but
 * checking against this one fixed secret rather than a `token` table lookup. */
export function requireRootToken(rootToken: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const provided = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!provided || !safeEqual(provided, rootToken)) {
      return c.json(
        { error: { code: "unauthorized", message: "Missing or invalid root token" } },
        401,
      );
    }
    return next();
  };
}
