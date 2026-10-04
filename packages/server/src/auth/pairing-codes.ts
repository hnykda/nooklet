/**
 * One-time pairing codes: what a QR code carries instead of a device token (B-655, B-603's
 * follow-up). An admin session mints a code (`pairing.create`); the phone trades it, with no other
 * credential, for a token of its own (`pairing.redeem`, the one unauthenticated op).
 *
 * Why not just put a token in the QR, as `nooklet token create --link` does: a token in a link is
 * a long-lived credential wherever the link travels (clipboard, screenshots, chat, history). A code
 * here is worth nothing ten minutes later, or after it is used once, and the token it becomes is
 * minted on the phone's request and never shown anywhere but in that one response.
 *
 * Guessing: a code is 128 random bits. With the redeem endpoint's rate limit
 * (`../http/rate-limit.ts`, 10 attempts per minute per peer, 60 per minute in total) and at most a
 * handful of live codes at once, the chance of hitting one is ~2^-120 per attempt. The limiter is
 * there for the database and the log, not the arithmetic.
 *
 * Fails closed: an unknown, expired, already used or cancelled code all get the same answer, so
 * the endpoint is not an oracle for which state a code is in.
 */

import { createHash, randomBytes } from "node:crypto";
import type { SqlDriver } from "@nooklet/core";
import { newId } from "@nooklet/core";
import { createToken } from "./tokens.js";

/** 10 minutes: long enough to find the phone and open the camera, short enough that a QR seen
 * over a shoulder or left in a screenshot is dead by the time anyone could use it. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const MIN_PAIRING_TTL_MS = 60 * 1000;
export const MAX_PAIRING_TTL_MS = 60 * 60 * 1000;

/** `nkp_` + 22 base64url chars (16 random bytes, 128 bits). The prefix makes a leaked code
 * recognisable to secret scanners, as `nk_` does for tokens. */
export const PAIRING_CODE_RE = /^nkp_[A-Za-z0-9_-]{22}$/;

export type PairingScope = "read" | "write";

export interface CreatePairingCodeOptions {
  scope?: PairingScope;
  canSync?: boolean;
  ttlMs?: number;
  /** The token that asked for the code, for the audit trail and so that a new code cancels the
   * same creator's earlier unused ones ("regenerate"). `null` for the CLI. */
  createdBy: string | null;
  now?: number;
}

export interface CreatedPairingCode {
  id: string;
  /** The raw code. Returned once, never stored. */
  code: string;
  expiresAt: number;
  scope: PairingScope;
  canSync: boolean;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function createPairingCode(
  driver: SqlDriver,
  opts: CreatePairingCodeOptions,
): CreatedPairingCode {
  const now = opts.now ?? Date.now();
  const ttl = Math.min(
    MAX_PAIRING_TTL_MS,
    Math.max(MIN_PAIRING_TTL_MS, opts.ttlMs ?? PAIRING_CODE_TTL_MS),
  );
  const scope = opts.scope ?? "write";
  const canSync = opts.canSync ?? true;
  const id = newId();
  const code = `nkp_${randomBytes(16).toString("base64url")}`;
  driver.transaction(() => {
    // "Regenerate" means the old QR stops working, not that two are live. Cancelled codes are
    // marked used (with no token), which is what redeem checks.
    if (opts.createdBy === null) {
      driver.run(
        "UPDATE pairing_code SET used_at = ? WHERE created_by IS NULL AND used_at IS NULL",
        [now],
      );
    } else {
      driver.run("UPDATE pairing_code SET used_at = ? WHERE created_by = ? AND used_at IS NULL", [
        now,
        opts.createdBy,
      ]);
    }
    // Housekeeping: nothing older than a day is worth keeping. Used codes keep `token_id` for a
    // day so "which code made this token" can be answered while it still matters.
    driver.run("DELETE FROM pairing_code WHERE expires_at < ?", [now - 24 * 60 * 60 * 1000]);
    driver.run(
      `INSERT INTO pairing_code(id, code_hash, scope, can_sync, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, sha256Hex(code), scope, canSync ? 1 : 0, opts.createdBy, now, now + ttl],
    );
  });
  return { id, code, expiresAt: now + ttl, scope, canSync };
}

export interface RedeemedPairingCode {
  tokenId: string;
  token: string;
  scope: PairingScope;
  canSync: boolean;
}

/**
 * Trade `code` for a new device token labelled `label`, or `null` if the code is not live.
 *
 * Atomic: the conditional UPDATE claims the code (`used_at IS NULL AND expires_at > now`) and the
 * token is minted in the same transaction, so two concurrent redeems of one code produce exactly
 * one token — the second UPDATE changes no row. The Node SQLite driver is synchronous, so the two
 * cannot interleave inside one process anyway; the condition is what keeps that true if they ever
 * could (a second process on the same file, an async driver).
 */
export function redeemPairingCode(
  driver: SqlDriver,
  code: string,
  label: string,
  now: number = Date.now(),
): RedeemedPairingCode | null {
  if (!PAIRING_CODE_RE.test(code)) return null;
  const hash = sha256Hex(code);
  return driver.transaction(() => {
    const claimed = driver.run(
      "UPDATE pairing_code SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
      [now, hash, now],
    );
    if (claimed.changes !== 1) return null;
    const row = driver.get<{ id: string; scope: PairingScope; can_sync: number }>(
      "SELECT id, scope, can_sync FROM pairing_code WHERE code_hash = ?",
      [hash],
    );
    if (!row) return null;
    const created = createToken(driver, {
      label,
      scope: row.scope,
      canSync: row.can_sync !== 0,
    });
    driver.run("UPDATE pairing_code SET token_id = ? WHERE id = ?", [created.id, row.id]);
    return {
      tokenId: created.id,
      token: created.token,
      scope: row.scope,
      canSync: row.can_sync !== 0,
    };
  });
}
