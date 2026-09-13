/**
 * `POST /sync/push` (ADR 003 / research/03-sync.md §6.5): a device sends every op it has minted
 * since its last push; the server applies them via `serverApplyOps` (the same write path as the
 * HTTP/MCP op registry, ADR 003's "every write anywhere is an op"), then reports back what
 * happened so the pushing device can reconcile its own optimistic state.
 */

import type { Op } from "@nooklet/core";
import {
  HlcDriftError,
  isOp,
  isoJournalName,
  isValidJournalDay,
  normalizePageName,
} from "@nooklet/core";
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

/**
 * A device's `page.create` refused because a live page already has the name — typically one the
 * server made from another device's reference while this one was offline and made the same page
 * by hand (ADR 024). The device cannot converge from the rejection alone: its replica holds its own
 * page under the name, with blocks on it the server also refused (`no-such-page`), and the server's
 * page cannot land there while the name is taken. So the response names the page that holds the
 * name, as the snapshot row a bootstrap would carry; the client moves onto it and re-sends what
 * it wrote with fresh clocks (`apps/web/src/sync/sync-client.ts#adoptRefusedPage`).
 *
 * Not done here by rewriting the late ops onto the live page: their HLCs are older than that
 * page's `page.create`, so a replay (`nooklet verify`, sorted by HLC) would meet the blocks before
 * their page and reject them.
 */
function refusedPageCreates(
  serverCtx: ServerContext,
  ops: readonly Op[],
  rejected: ReadonlyArray<{ id: string; reason: string }>,
): Array<{ refused_id: string; page: Record<string, unknown>; page_props: unknown[] }> {
  const collided = new Set(
    rejected.filter((r) => r.reason === "page-key-collision").map((r) => r.id),
  );
  const out: Array<{ refused_id: string; page: Record<string, unknown>; page_props: unknown[] }> =
    [];
  for (const op of ops) {
    if (!collided.has(op.id) || op.payload.kind !== "page.create") continue;
    const { name, journalDay } = op.payload;
    const stored =
      journalDay !== null && isValidJournalDay(journalDay) ? isoJournalName(journalDay) : name;
    const page = serverCtx.driver.get<Record<string, unknown>>(
      `SELECT id, name, key, journal_day, created_at, updated_at, deleted_at, name_hlc, deleted_hlc
       FROM page WHERE key = ? AND deleted_at IS NULL`,
      [normalizePageName(stored)],
    );
    if (!page || page.id === op.entity) continue;
    const pageProps = serverCtx.driver.all(
      "SELECT page_id, key, value, hlc FROM page_prop WHERE page_id = ?",
      [page.id],
    );
    out.push({ refused_id: op.entity, page, page_props: pageProps });
  }
  return out;
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

    const refusedPages = refusedPageCreates(serverCtx, validOps, rejected);
    return c.json({
      accepted,
      rejected,
      corrections,
      server_seq: serverSeq,
      ...(refusedPages.length > 0 ? { refused_pages: refusedPages } : {}),
    });
  });
}
