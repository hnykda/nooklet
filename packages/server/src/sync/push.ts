/**
 * `POST /sync/push` (ADR 003 / research/03-sync.md §6.5): a device sends every op it has minted
 * since its last push; the server applies them via `serverApplyOps` (the same write path as the
 * HTTP/MCP op registry, ADR 003's "every write anywhere is an op"), then reports back what
 * happened so the pushing device can reconcile its own optimistic state.
 */

import type { Op } from "@nooklet/core";
import { HlcDriftError, isOp } from "@nooklet/core";
import type { Hono } from "hono";
import { type ServerContext, serverApplyOps } from "../apply-ops.js";
import { requireSyncToken } from "./auth.js";
import { touchDeviceOnPush } from "./device.js";

interface PushBody {
  device_id: string;
  ops: unknown[];
}

function isPushBody(x: unknown): x is PushBody {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o.device_id === "string" && o.device_id.length > 0 && Array.isArray(o.ops);
}

/** Best-effort id for an op that failed `isOp()` validation, so the caller can still correlate the
 * rejection with what it sent. */
function idOf(candidate: unknown): string {
  if (typeof candidate === "object" && candidate !== null) {
    const id = (candidate as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return "unknown";
}

export function registerSyncPush(app: Hono, serverCtx: ServerContext): void {
  app.post("/sync/push", async (c) => {
    const auth = requireSyncToken(c, serverCtx.driver);
    if (auth instanceof Response) return auth;

    let raw: unknown;
    try {
      const text = await c.req.text();
      raw = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      return c.json({ error: { code: "invalid", message: "invalid JSON body" } }, 400);
    }
    if (!isPushBody(raw)) {
      return c.json(
        {
          error: {
            code: "invalid",
            message: "body must be { device_id: string, ops: Op[] }",
          },
        },
        400,
      );
    }

    const validOps: Op[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    for (const candidate of raw.ops) {
      if (isOp(candidate)) validOps.push(candidate);
      else rejected.push({ id: idOf(candidate), reason: "invalid-op" });
    }

    let corrections: Op[] = [];
    let resultsById: Map<string, { status: string; reason?: string }> | undefined;
    if (validOps.length > 0) {
      try {
        const applied = serverApplyOps(serverCtx, validOps, {
          origin: "sync",
          actor: auth.label,
          deviceId: raw.device_id,
        });
        corrections = applied.corrections;
        resultsById = new Map(applied.results.map((r) => [r.id, r]));
      } catch (e) {
        if (e instanceof HlcDriftError) {
          return c.json(
            {
              error: {
                code: "invalid",
                message: e.message,
                hint: "this device's clock is wrong; fix it and retry",
              },
            },
            400,
          );
        }
        throw e;
      }
    }

    touchDeviceOnPush(serverCtx.driver, raw.device_id, {
      tokenId: auth.id,
      defaultName: auth.label,
    });

    const accepted: Array<{ id: string; seq: number }> = [];
    if (resultsById) {
      const ids = validOps.map((o) => o.id);
      const seqRows = serverCtx.driver.all<{ id: string; seq: number }>(
        `SELECT id, seq FROM op WHERE id IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      const seqById = new Map(seqRows.map((r) => [r.id, r.seq]));
      for (const op of validOps) {
        const result = resultsById.get(op.id);
        if (!result) continue; // should not happen: every submitted op is always recorded
        if (result.status === "rejected") {
          rejected.push({ id: op.id, reason: result.reason ?? "rejected" });
        } else {
          accepted.push({ id: op.id, seq: seqById.get(op.id) ?? 0 });
        }
      }
    }

    const serverSeq =
      serverCtx.driver.get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM op")?.n ?? 0;

    return c.json({ accepted, rejected, corrections, server_seq: serverSeq });
  });
}
