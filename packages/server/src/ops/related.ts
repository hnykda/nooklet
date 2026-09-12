/**
 * "Related pages/blocks" (PLAN.md §9, research/06 §5.3): nearest neighbours of a page or block's
 * own stored vector, excluding itself and (for a block) everything else on its own page. Reuses
 * the target's already-stored vector via a vec0 point lookup — no re-embedding call.
 */

import { isId } from "@nooklet/core";
import { z } from "zod";
import {
  checkSemanticAvailability,
  distanceToScore,
  knnPointLookup,
  knnQuery,
} from "../embeddings/index.js";
import { wirePageNameOf } from "../rows.js";
import { defineOp, OpError } from "./registry.js";
import { resolvePageRef, wirePageName } from "./resolve.js";
import { BlockId, Limit, PageRef } from "./schemas.js";

export const relatedFind = defineOp({
  name: "related.find",
  summary: "Nearest neighbours of a page or block by meaning",
  description:
    "Given a page or block, returns the most similar other pages/blocks by embedding distance - " +
    "excluding the target itself and, for a block, everything else on its own page. Needs an " +
    "embedding model configured and that target already indexed; check available in the response " +
    "(false means no results, not necessarily none exist - the index may still be catching up).",
  input: z
    .object({
      target: z
        .union([PageRef, BlockId])
        .describe("Page name/date/alias, a page id, or a block id"),
      limit: Limit.default(10),
    })
    .strict(),
  output: z.object({
    target: z.string(),
    kind: z.enum(["page", "block"]),
    available: z
      .boolean()
      .describe("false if no embedding model is ready, or this target isn't indexed yet"),
    items: z.array(
      z.object({
        kind: z.enum(["page", "block"]),
        id: z.string(),
        page: z.string(),
        snippet: z.string(),
        score: z.number().min(0).max(1),
      }),
    ),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  render: (out) =>
    `${out.items.length} related ${out.kind}(s) for ${out.target} (${out.available ? "ok" : "unavailable"})`,
  handler: async (input, ctx) => {
    const driver = ctx.db;

    const asPage = await resolvePageRef(ctx, input.target);
    const asBlock = asPage
      ? null
      : isId(input.target)
        ? await ctx.data.blocks.get(input.target)
        : null;
    if (!asPage && !asBlock) {
      throw new OpError("not_found", `no page or block matches "${input.target}"`);
    }
    const kind: "page" | "block" = asPage ? "page" : "block";
    const targetWire = asPage ? wirePageName(asPage) : (input.target as string);

    const availability = checkSemanticAvailability(driver);
    if (!availability.available || !availability.model) {
      return { target: targetWire, kind, available: false, items: [] };
    }
    const model = availability.model;

    let selfPageKey: string;
    let ownerRow: { id: number; status: string } | undefined;
    if (asPage) {
      selfPageKey = asPage.key;
      ownerRow = driver.get<{ id: number; status: string }>(
        "SELECT id, status FROM embedding WHERE model_id = ? AND unit_kind = 'page' AND page_id = ?",
        [model.id, asPage.id],
      );
    } else {
      const block = asBlock as NonNullable<typeof asBlock>;
      const page = driver.get<{ key: string }>("SELECT key FROM page WHERE id = ?", [block.pageId]);
      selfPageKey = page?.key ?? "";
      ownerRow = driver.get<{ id: number; status: string }>(
        "SELECT id, status FROM embedding WHERE model_id = ? AND block_id = ?",
        [model.id, block.id],
      );
    }
    if (ownerRow?.status !== "done") {
      return { target: targetWire, kind, available: true, items: [] };
    }

    const rawVec = knnPointLookup(driver, model.tableName, ownerRow.id);
    if (!rawVec) return { target: targetWire, kind, available: true, items: [] };
    const queryVec = new Float32Array(rawVec);

    const k = Math.min(input.limit * 3 + 5, 200);
    const hits = knnQuery(driver, model.tableName, queryVec, {
      k,
      kind,
      excludeId: ownerRow.id,
      excludePageKey: kind === "block" ? selfPageKey : undefined,
    });

    const embIds = hits.map((h) => h.id);
    const rows =
      embIds.length === 0
        ? []
        : driver.all<{ id: number; block_id: string | null; page_id: string }>(
            `SELECT id, block_id, page_id FROM embedding WHERE model_id = ? AND id IN (${embIds.map(() => "?").join(",")})`,
            [model.id, ...embIds],
          );
    const byEmbId = new Map(rows.map((r) => [r.id, r]));

    const items: Array<{
      kind: "page" | "block";
      id: string;
      page: string;
      snippet: string;
      score: number;
    }> = [];
    for (const h of hits) {
      if (items.length >= input.limit) break;
      const row = byEmbId.get(h.id);
      if (!row) continue;
      if (kind === "page") {
        const page = driver.get<{
          id: string;
          name: string;
          journal_day: number | null;
          deleted_at: number | null;
        }>("SELECT id, name, journal_day, deleted_at FROM page WHERE id = ?", [row.page_id]);
        if (!page || page.deleted_at !== null) continue;
        const name = wirePageNameOf(page);
        items.push({
          kind: "page",
          id: page.id,
          page: name,
          snippet: name,
          score: distanceToScore(h.distance),
        });
      } else {
        if (!row.block_id) continue;
        const b = driver.get<{
          id: string;
          page_id: string;
          content: string;
          deleted_at: number | null;
        }>("SELECT id, page_id, content, deleted_at FROM block WHERE id = ?", [row.block_id]);
        if (!b || b.deleted_at !== null) continue;
        const page = driver.get<{ name: string; journal_day: number | null }>(
          "SELECT name, journal_day FROM page WHERE id = ? AND deleted_at IS NULL",
          [b.page_id],
        );
        if (!page) continue;
        const pageName = wirePageNameOf(page);
        const snippet = b.content.length > 200 ? `${b.content.slice(0, 200)}…` : b.content;
        items.push({
          kind: "block",
          id: b.id,
          page: pageName,
          snippet,
          score: distanceToScore(h.distance),
        });
      }
    }

    return { target: targetWire, kind, available: true, items };
  },
});
