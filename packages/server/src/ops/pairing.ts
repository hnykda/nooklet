/**
 * Device management and QR pairing (B-655: `admin` gates server administration).
 *
 *   - `pairing.create` (admin): a one-time code a phone can trade for its own token
 *   - `pairing.redeem` (no token, rate-limited): that trade
 *   - `token.list` (admin): every token's label, scope and dates; never the token itself
 *   - `token.revoke` (admin): revoke one, and close the WebSockets it opened (B-676)
 *
 * Why these need `admin` rather than `write`: a phone holds a `write` token. If `write` could list
 * and revoke tokens or mint pairing codes, a lost phone could lock out every other device, or mint
 * itself fresh credentials that survive its own revocation. Content editing stays at `write`.
 *
 * Who holds `admin` (decided here, `docs/progress/qr-pairing.md`): the loopback web-client token
 * (the desktop app and a browser on the server's own machine — which can read `graph.sqlite` and
 * `root.token` directly anyway), the token `POST /graphs` hands back to the root-token holder who
 * created the graph, and any token made with `nooklet token create --scope admin`. Never a token a
 * pairing code produces: a code grants at most `write`.
 */

import { z } from "zod";
import { createPairingCode, PAIRING_CODE_RE, redeemPairingCode } from "../auth/pairing-codes.js";
import { closeTokenSockets } from "../auth/token-sockets.js";
import { revokeToken, type TokenRow } from "../auth/tokens.js";
import { defineOp, OpError } from "./registry.js";

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const pairingCreate = defineOp({
  name: "pairing.create",
  summary: "Create a one-time code to pair a new device",
  description:
    "Mints a single-use pairing code that a new device (a phone scanning a QR code) exchanges, " +
    "with no other credential, for its own token via pairing.redeem. The code expires after " +
    "ttl_seconds (default 600) or on first use, and a new code from the same caller cancels the " +
    "caller's earlier unused one. Grants at most write scope. Requires admin. The code is " +
    "returned once and stored only as a hash; do not log or echo it anywhere but to the owner.",
  input: z
    .object({
      scope: z.enum(["read", "write"]).default("write"),
      sync: z.boolean().default(true).describe("Whether the device token may sync (/sync/*)"),
      ttl_seconds: z.number().int().min(60).max(3600).default(600),
    })
    .strict(),
  output: z.object({
    code: z.string(),
    expires_at: z.number().int().describe("Unix milliseconds"),
    scope: z.enum(["read", "write"]),
    sync: z.boolean(),
  }),
  annotations: WRITE_ANNOTATIONS,
  scopes: ["admin"],
  render: (out) =>
    `Pairing code (single use, expires ${new Date(out.expires_at).toISOString()}): ${out.code}`,
  handler: (input, ctx) => {
    const created = createPairingCode(ctx.db, {
      scope: input.scope,
      canSync: input.sync,
      ttlMs: input.ttl_seconds * 1000,
      createdBy: ctx.actor.tokenId ?? null,
    });
    return {
      code: created.code,
      expires_at: created.expiresAt,
      scope: created.scope,
      sync: created.canSync,
    };
  },
});

export const pairingRedeem = defineOp({
  name: "pairing.redeem",
  summary: "Exchange a pairing code for a device token",
  description:
    "Called by a new device with no token: trades a live pairing code (from pairing.create) for " +
    "a new token labelled with the device's name. Single use; an unknown, expired or used code " +
    "is refused with 401 and the same message. Rate-limited per peer. Not an MCP tool.",
  input: z
    .object({
      code: z.string().regex(PAIRING_CODE_RE, "not a nooklet pairing code"),
      label: z.string().trim().min(1).max(80).describe("This device's name, e.g. 'iPhone'"),
    })
    .strict(),
  output: z.object({
    token: z.string(),
    token_id: z.string(),
    scope: z.enum(["read", "write"]),
    sync: z.boolean(),
  }),
  // `idempotentHint: false`, and no `idempotency_key`: a replay must never hand the token out twice.
  annotations: WRITE_ANNOTATIONS,
  scopes: [],
  auth: "none",
  // No MCP: an MCP client already holds a token, and this op's only caller is a device that does
  // not. `OpRegistry.register` refuses an `auth: "none"` op that is MCP-exposed.
  expose: { http: true, mcp: false },
  handler: (input, ctx) => {
    const redeemed = redeemPairingCode(ctx.db, input.code, input.label);
    if (!redeemed) {
      throw new OpError(
        "unauthorized",
        "this pairing code is not valid: it may have expired or already been used",
        "create a new code on a device that manages this server (Settings → Devices, or `nooklet pair`)",
      );
    }
    ctx.log.info(`[pairing] new device token "${input.label}" (${redeemed.tokenId})`);
    return {
      token: redeemed.token,
      token_id: redeemed.tokenId,
      scope: redeemed.scope,
      sync: redeemed.canSync,
    };
  },
});

const TokenInfo = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.enum(["read", "write", "admin"]),
  sync: z.boolean(),
  ui_control: z.boolean(),
  created_at: z.number().int(),
  last_used_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
  current: z.boolean().describe("The token making this request"),
});

export const tokenList = defineOp({
  name: "token.list",
  summary: "List this graph's devices and agent tokens",
  description:
    "Every token that can reach this graph: label, scope, whether it syncs, when it was created " +
    "and last used, and whether it is revoked. Never the token itself (only a hash is stored). " +
    "Revoked tokens are left out unless include_revoked. Requires admin.",
  input: z.object({ include_revoked: z.boolean().default(false) }).strict(),
  output: z.object({ tokens: z.array(TokenInfo) }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["admin"],
  render: (out) =>
    out.tokens
      .map(
        (t) =>
          `${t.id}  ${t.scope}${t.sync ? "+sync" : ""}  ${t.revoked_at ? "revoked" : "active"}  ${t.label}${t.current ? " (this session)" : ""}`,
      )
      .join("\n") || "No tokens.",
  handler: (input, ctx) => {
    const rows = ctx.db.all<Omit<TokenRow, "token_hash">>(
      `SELECT id, label, scope, can_sync, ui_control, created_at, last_used_at, revoked_at
       FROM token ${input.include_revoked ? "" : "WHERE revoked_at IS NULL"}
       ORDER BY created_at DESC`,
    );
    return {
      tokens: rows.map((r) => ({
        id: r.id,
        label: r.label,
        scope: r.scope,
        sync: r.can_sync !== 0,
        ui_control: r.ui_control !== 0,
        created_at: r.created_at,
        last_used_at: r.last_used_at,
        revoked_at: r.revoked_at,
        current: r.id === ctx.actor.tokenId,
      })),
    };
  },
});

export const tokenRevoke = defineOp({
  name: "token.revoke",
  summary: "Revoke a device or agent token",
  description:
    "Revokes the token with this id (from token.list) at once: its next HTTP request is refused, " +
    "and its open sync and live-UI WebSockets are closed. The device keeps its unsynced edits " +
    "until it is paired again. Cannot be undone; pair the device again instead. Requires admin.",
  input: z.object({ id: z.string().min(1) }).strict(),
  output: z.object({
    revoked: z.boolean().describe("false if it was already revoked"),
    closed_sockets: z.number().int(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["admin"],
  expose: { http: true, mcp: { requiresUserInteraction: true } },
  render: (out) =>
    out.revoked
      ? `Revoked; closed ${out.closed_sockets} open connection(s).`
      : "That token was already revoked.",
  handler: (input, ctx) => {
    const exists = ctx.db.get<{ id: string }>("SELECT id FROM token WHERE id = ?", [input.id]);
    if (!exists) throw new OpError("not_found", `no token with id "${input.id}"`);
    const revoked = revokeToken(ctx.db, input.id);
    // Even when it was already revoked: a socket left open from before is closed either way.
    const closed = closeTokenSockets(ctx.db, input.id);
    return { revoked, closed_sockets: closed };
  },
});
