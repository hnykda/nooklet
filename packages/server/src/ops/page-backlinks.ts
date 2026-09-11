import { normalizePageName } from "@nooklet/core";
import { z } from "zod";
import { isoFromJournalDay } from "../data-api.js";
import { defineOp, OpError } from "./registry.js";
import { resolvePageRef, wirePageName } from "./resolve.js";
import { BlockId, Cursor, Limit, PageRef } from "./schemas.js";

export const pageBacklinks = defineOp({
  name: "page.backlinks",
  summary: "Linked/unlinked references to a page or block",
  description:
    "Lists blocks that reference a page or block: [[page]] links, #tags, ((block refs)), and - if " +
    "include_unlinked - plain-text mentions of the page's name that are not already a link. Each " +
    "item has the referencing block's id, page, and text. Paginated. Use this before renaming or " +
    "deleting a page to see what points at it.",
  input: z
    .object({
      target: z
        .union([PageRef, BlockId])
        .describe("Page name/date/alias, a page id, or a block id"),
      include_unlinked: z.boolean().default(false),
      limit: Limit,
      cursor: Cursor.optional(),
    })
    .strict(),
  output: z.object({
    target: z.string(),
    linked: z.array(
      z.object({ id: BlockId, page: z.string(), text: z.string(), updated_at: z.string() }),
    ),
    unlinked: z.array(z.object({ id: BlockId, page: z.string(), text: z.string() })).default([]),
    cursor: z.string().optional(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ["read"],
  expose: { http: { method: "GET", path: "/pages/{page}/backlinks" } },
  render: (out) =>
    `${out.linked.length} linked, ${out.unlinked.length} unlinked reference(s) to ${out.target}`,
  handler: async (input, ctx) => {
    const driver = ctx.db;
    const offset = input.cursor
      ? Number.parseInt(Buffer.from(input.cursor, "base64").toString("utf8"), 10)
      : 0;

    const asPage = await resolvePageRef(ctx, input.target);
    let targetWire: string;
    let linkedRows: Array<{
      block_id: string;
      page_id: string;
      content: string;
      updated_at: number;
    }>;
    let unlinkedRows: Array<{ block_id: string; page_id: string; content: string }> = [];

    if (asPage) {
      targetWire = wirePageName(asPage);
      linkedRows = driver.all(
        `SELECT DISTINCT b.id AS block_id, b.page_id AS page_id, b.content AS content, b.updated_at AS updated_at
         FROM path_ref pr JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL
         WHERE pr.page_key = ? AND b.page_id != ?
         ORDER BY b.updated_at DESC`,
        [asPage.key, asPage.id],
      );
      if (input.include_unlinked) {
        const plainName = asPage.name.split("/").pop() ?? asPage.name;
        if (plainName.length >= 3) {
          const ftsQuery = `"${plainName.replace(/"/g, '""')}"`;
          unlinkedRows = driver.all(
            `SELECT b.id AS block_id, b.page_id AS page_id, b.content AS content
             FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
             WHERE block_fts MATCH ? AND b.deleted_at IS NULL AND b.page_id != ?
               AND NOT EXISTS (SELECT 1 FROM path_ref pr WHERE pr.block_id = b.id AND pr.page_key = ?)
             LIMIT 50`,
            [ftsQuery, asPage.id, asPage.key],
          );
        }
      }
    } else {
      const asBlock = await ctx.data.blocks.get(input.target);
      if (asBlock) {
        targetWire = input.target;
        linkedRows = driver.all(
          `SELECT DISTINCT b.id AS block_id, b.page_id AS page_id, b.content AS content, b.updated_at AS updated_at
           FROM ref r JOIN block b ON b.id = r.src_block_id AND b.deleted_at IS NULL
           WHERE r.kind = 'block' AND r.dst_block_id = ?
           ORDER BY b.updated_at DESC`,
          [asBlock.id],
        );
      } else {
        // A page that is REFERENCED but not created yet is a normal, addressable thing in a wiki:
        // `[[Lisbon]]` makes that page meaningful the moment you write the link, and opening
        // it should show what points at it. Refs are stored against `page_key`, so this needs no
        // page row — and returning 404 here meant every not-yet-created page rendered as
        // "Couldn't load references", which is both wrong and alarming.
        //
        // An unknown name simply has no backlinks, so the answer is an empty list rather than an
        // error: a caller can tell the difference, and "this page has nothing pointing at it" is a
        // true and useful answer.
        const key = normalizePageName(input.target);
        targetWire = input.target;
        linkedRows = driver.all(
          `SELECT DISTINCT b.id AS block_id, b.page_id AS page_id, b.content AS content, b.updated_at AS updated_at
           FROM path_ref pr JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL
           WHERE pr.page_key = ?
           ORDER BY b.updated_at DESC`,
          [key],
        );
        if (input.include_unlinked) {
          const plainName = input.target.split("/").pop() ?? input.target;
          if (plainName.length >= 3) {
            const ftsQuery = `"${plainName.replace(/"/g, '""')}"`;
            unlinkedRows = driver.all(
              `SELECT b.id AS block_id, b.page_id AS page_id, b.content AS content
               FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
               WHERE block_fts MATCH ? AND b.deleted_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM path_ref pr WHERE pr.block_id = b.id AND pr.page_key = ?)
               LIMIT 50`,
              [ftsQuery, key],
            );
          }
        }
      }
    }

    const hasMore = linkedRows.length > offset + input.limit;
    const pageOf = (pageId: string): string => {
      const p = driver.get<{ name: string; journal_day: number | null }>(
        "SELECT name, journal_day FROM page WHERE id = ?",
        [pageId],
      );
      return p ? (p.journal_day !== null ? isoFromJournalDay(p.journal_day) : p.name) : pageId;
    };

    return {
      target: targetWire,
      linked: linkedRows.slice(offset, offset + input.limit).map((r) => ({
        id: r.block_id,
        page: pageOf(r.page_id),
        text: (r.content.split("\n")[0] ?? "").trim(),
        updated_at: new Date(r.updated_at).toISOString(),
      })),
      unlinked: unlinkedRows.map((r) => ({
        id: r.block_id,
        page: pageOf(r.page_id),
        text: (r.content.split("\n")[0] ?? "").trim(),
      })),
      cursor: hasMore ? Buffer.from(String(offset + input.limit)).toString("base64") : undefined,
    };
  },
});
