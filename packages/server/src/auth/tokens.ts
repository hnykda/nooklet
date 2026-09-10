/**
 * API tokens (`docs/spec/sql-schema.md`'s `token` table, `packages/server/src/schema.ts`):
 * creation, verification, revocation, and a small Hono bearer-auth middleware. The raw token is
 * returned exactly once, at creation time; only `sha256(token)` is ever persisted
 * (00-conventions.md's Storage conventions: "tokens live in SQLite, hashed").
 */

import { createHash, randomBytes } from "node:crypto";
import type { SqlDriver } from "@nooklet/core";
import { newId } from "@nooklet/core";
import type { MiddlewareHandler } from "hono";
import type { Scope } from "../ops/registry.js";

export interface TokenRow {
  id: string;
  label: string;
  scope: Scope;
  can_sync: number;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CreateTokenOptions {
  label: string;
  scope: Scope;
  canSync?: boolean;
}

export interface CreatedToken {
  id: string;
  /** The raw bearer token. Shown to the caller exactly once; never recoverable afterward. */
  token: string;
}

export interface VerifiedToken {
  id: string;
  scope: Scope;
  label: string;
  canSync: boolean;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** A token's single stored `scope` implies every weaker scope (00-conventions.md: "read is the
 * minimum scope"): `admin` can do anything `write` can, `write` anything `read` can. */
export function scopesFor(scope: Scope): Scope[] {
  if (scope === "admin") return ["read", "write", "admin"];
  if (scope === "write") return ["read", "write"];
  return ["read"];
}

export function createToken(driver: SqlDriver, opts: CreateTokenOptions): CreatedToken {
  const id = newId();
  const raw = `vrt_${randomBytes(24).toString("hex")}`;
  driver.run(
    `INSERT INTO token(id, label, scope, can_sync, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, opts.label, opts.scope, opts.canSync ? 1 : 0, sha256Hex(raw), Date.now()],
  );
  return { id, token: raw };
}

export function verifyToken(driver: SqlDriver, rawToken: string): VerifiedToken | null {
  const hash = sha256Hex(rawToken);
  const row = driver.get<TokenRow>("SELECT * FROM token WHERE token_hash = ?", [hash]);
  if (!row || row.revoked_at !== null) return null;
  driver.run("UPDATE token SET last_used_at = ? WHERE id = ?", [Date.now(), row.id]);
  return { id: row.id, scope: row.scope, label: row.label, canSync: row.can_sync !== 0 };
}

export function revokeToken(driver: SqlDriver, id: string): boolean {
  const r = driver.run("UPDATE token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [
    Date.now(),
    id,
  ]);
  return r.changes > 0;
}

export function getToken(driver: SqlDriver, id: string): TokenRow | undefined {
  return driver.get<TokenRow>("SELECT * FROM token WHERE id = ?", [id]);
}

declare module "hono" {
  interface ContextVariableMap {
    authScopes: Scope[];
    authActorLabel: string;
    authTokenId: string;
  }
}

/**
 * Bearer-auth middleware: reads `Authorization: Bearer <token>`, verifies it against `driver`, and
 * attaches `{scopes, actor, tokenId}` to the Hono context for downstream handlers
 * (`ops/registry.ts`'s `buildOpCtx`) to read. 401 with the conventions doc's error envelope on a
 * missing, malformed, invalid, or revoked token.
 */
export function bearerAuth(driver: SqlDriver): MiddlewareHandler {
  return async (c, next) => {
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
    c.set("authScopes", scopesFor(verified.scope));
    c.set("authActorLabel", verified.label);
    c.set("authTokenId", verified.id);
    await next();
  };
}
