/**
 * `GET /sync/pull` (ADR 003 / research/03-sync.md §6.5): a device asks for every op with
 * `seq > since`, in `seq` order, `status = 'applied'` only (this is what makes a rejected op
 * invisible to every device but the one that sent it — it never leaves the `op` table's `status`
 * column). Server-authored corrective ops (`../apply-ops.ts`) are ordinary `applied` rows here, so
 * they flow to every other device exactly like any other op.
 *
 * Deviation from the bare ADR/research sketch (`GET /sync/pull?since=<seq>&limit=<n>`): a
 * `device_id` query parameter is required too. Advancing `device.acked_seq` (rule 22's GC floor)
 * needs to know *which* device just caught up to `cursor`, and nothing else on this GET request
 * identifies that (a bearer token is not 1:1 with a device: `POST /sync/push` already takes an
 * explicit `device_id` in its body for the same reason). This is called out here since the ADR
 * text doesn't show it.
 */

import type { Op, OpPayload } from "@nooklet/core";
import type { Hono } from "hono";
import type { ServerContext } from "../apply-ops.js";
import { requireSyncToken } from "./auth.js";
import { advanceAckedSeq } from "./device.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

interface OpRow {
  seq: number;
  id: string;
  hlc: string;
  device_id: string;
  entity: string;
  payload_json: string;
}

function rowToOp(row: OpRow): Op {
  return {
    id: row.id,
    hlc: row.hlc,
    device: row.device_id,
    entity: row.entity,
    payload: JSON.parse(row.payload_json) as OpPayload,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

export function registerSyncPull(app: Hono, serverCtx: ServerContext): void {
  app.get("/sync/pull", (c) => {
    const auth = requireSyncToken(c, serverCtx.driver);
    if (auth instanceof Response) return auth;

    const deviceId = c.req.query("device_id");
    if (!deviceId) {
      return c.json(
        { error: { code: "invalid", message: "device_id query parameter is required" } },
        400,
      );
    }

    const since = parsePositiveInt(c.req.query("since"), 0);
    if (since === undefined) {
      return c.json(
        { error: { code: "invalid", message: "since must be a non-negative integer" } },
        400,
      );
    }

    const requestedLimit = parsePositiveInt(c.req.query("limit"), DEFAULT_LIMIT);
    if (requestedLimit === undefined || requestedLimit === 0) {
      return c.json(
        { error: { code: "invalid", message: "limit must be a positive integer" } },
        400,
      );
    }
    const limit = Math.min(requestedLimit, MAX_LIMIT);

    const rows = serverCtx.driver.all<OpRow>(
      `SELECT seq, id, hlc, device_id, entity, payload_json FROM op
       WHERE seq > ? AND status = 'applied'
       ORDER BY seq
       LIMIT ?`,
      [since, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ops = page.map(rowToOp);
    const cursor = page.length > 0 ? (page[page.length - 1] as OpRow).seq : since;

    advanceAckedSeq(serverCtx.driver, deviceId, cursor, {
      tokenId: auth.id,
      defaultName: auth.label,
    });

    return c.json({ ops, cursor, has_more: hasMore });
  });
}
