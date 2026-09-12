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
import type { Permission, Scope } from "../ops/registry.js";

export interface TokenRow {
  id: string;
  label: string;
  scope: Scope;
  can_sync: number;
  /** ADR 015 §7: the `ui:control` capability, additive to `scope`'s read/write/admin tier — see
   * `../ops/registry.ts`'s `Permission` doc comment. `schema.ts` MIGRATIONS version 3. */
  ui_control: number;
  token_hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CreateTokenOptions {
  label: string;
  scope: Scope;
  canSync?: boolean;
  /** Grants the `ui:control` capability (ADR 015 §7): required by every `ui_*` op in addition to
   * whatever `read`/`write`/`admin` scope it also needs. Defaults to `false` — a token created
   * without `--ui-control` can never see or drive a live window, regardless of its scope tier. */
  uiControl?: boolean;
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
  uiControl: boolean;
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
  // The prefix is cosmetic — it makes a leaked token recognisable in logs and secret scanners.
  // Verification is by `sha256(token)` lookup alone, so tokens minted under an older prefix keep
  // working unchanged.
  const raw = `nk_${randomBytes(24).toString("hex")}`;
  driver.run(
    `INSERT INTO token(id, label, scope, can_sync, ui_control, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.label,
      opts.scope,
      opts.canSync ? 1 : 0,
      opts.uiControl ? 1 : 0,
      sha256Hex(raw),
      Date.now(),
    ],
  );
  return { id, token: raw };
}

/**
 * Mint a token that is the ONLY live one carrying its label: every earlier unrevoked token with
 * the same label is revoked first, in the same transaction.
 *
 * For credentials that belong to a process rather than a person — the served web client's
 * per-boot token (`../http/app.ts#webClientToken`). Minting those with plain `createToken` left
 * one live `write` + `can_sync` token per server start, none ever revoked: the owner's real graph
 * had three. A process that has exited cannot be asked for its token back, so revoking on the
 * next mint is the only place the old one can be retired.
 */
export function createSoleToken(driver: SqlDriver, opts: CreateTokenOptions): CreatedToken {
  return driver.transaction(() => {
    driver.run("UPDATE token SET revoked_at = ? WHERE label = ? AND revoked_at IS NULL", [
      Date.now(),
      opts.label,
    ]);
    return createToken(driver, opts);
  });
}

export function verifyToken(driver: SqlDriver, rawToken: string): VerifiedToken | null {
  const hash = sha256Hex(rawToken);
  const row = driver.get<TokenRow>("SELECT * FROM token WHERE token_hash = ?", [hash]);
  if (!row || row.revoked_at !== null) return null;
  driver.run("UPDATE token SET last_used_at = ? WHERE id = ?", [Date.now(), row.id]);
  return {
    id: row.id,
    scope: row.scope,
    label: row.label,
    canSync: row.can_sync !== 0,
    uiControl: row.ui_control !== 0,
  };
}

/** A verified token's full `Permission` set: its read/write/admin tier's implied scopes
 * (`scopesFor`), plus `"ui:control"` when the token was created with `--ui-control` (ADR 015 §7).
 * `ui:control` is never implied by `admin` or any other tier — it is a separate, explicit grant.
 * The one place both halves are combined; every caller that builds an `OpContext`/MCP `AuthInfo`
 * (`../http/app.ts`'s `bearerAuth`, `../mcp/server.ts`'s `verifyAccessToken`) should use this
 * instead of `scopesFor(verified.scope)` alone. */
export function allScopesFor(verified: VerifiedToken): Permission[] {
  return verified.uiControl
    ? [...scopesFor(verified.scope), "ui:control"]
    : scopesFor(verified.scope);
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
    authScopes: Permission[];
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
    c.set("authScopes", allScopesFor(verified));
    c.set("authActorLabel", verified.label);
    c.set("authTokenId", verified.id);
    await next();
  };
}
