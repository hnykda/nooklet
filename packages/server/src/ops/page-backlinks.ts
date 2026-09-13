import { normalizePageName, refKeyOf } from "@nooklet/core";
import { z } from "zod";
import { unlinkedMentionRows } from "../data-api.js";
import { pageLookupKeys } from "../page-aliases.js";
import { pagesTaggedWith, type TaggedPageRow } from "../page-tags.js";
import { pageWireNameById } from "../rows.js";
import { ftsPhrase } from "./fts-query.js";
import { defineOp } from "./registry.js";
import { resolvePageRef, wirePageName } from "./resolve.js";
import { BlockId, Cursor, Limit, PageRef } from "./schemas.js";

export const pageBacklinks = defineOp({
  name: "page.backlinks",
  summary: "Linked/unlinked references to a page or block",
  description:
    "Lists blocks that reference a page or block: [[page]] links, #tags, ((block refs)), and - if " +
    "include_unlinked - plain-text mentions of the page's name that are not already a link. Each " +
    "item has the referencing block's id, page, and text. For a page it also lists tagged_pages: " +
    "the pages that carry it as a page-level tag - a tags:: page property naming it (source " +
    "property), or every journal day under Journal (source intrinsic) - with tagged_total, so " +
    "asking about Person or Journal returns its members. Linked references and tagged_pages are " +
    "paginated together by limit and cursor (linked_total counts all linked); unlinked mentions " +
    "are not - up to unlinked_limit are returned, with unlinked_truncated saying whether there " +
    "are more. Use this before renaming or deleting a page to see what points at it.",
  input: z
    .object({
      target: z
        .union([PageRef, BlockId])
        .describe("Page name/date/alias, a page id, or a block id"),
      include_unlinked: z.boolean().default(false),
      unlinked_limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe(
          "Max unlinked mentions to return (500 is also what one mentions_link call rewrites)",
        ),
      limit: Limit,
      cursor: Cursor.optional(),
    })
    .strict(),
  output: z.object({
    target: z.string(),
    linked: z.array(
      z.object({ id: BlockId, page: z.string(), text: z.string(), updated_at: z.string() }),
    ),
    linked_total: z.number().int().describe("Linked references across all pages of results"),
    unlinked: z.array(z.object({ id: BlockId, page: z.string(), text: z.string() })).default([]),
    unlinked_truncated: z
      .boolean()
      .default(false)
      .describe("More unlinked mentions exist than unlinked_limit returned"),
    tagged_pages: z
      .array(
        z.object({
          id: z.string(),
          page: z.string(),
          source: z.enum(["property", "intrinsic"]),
        }),
      )
      .default([]),
    tagged_total: z.number().int().default(0),
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
    `${out.linked.length} linked, ${out.unlinked.length} unlinked reference(s) to ${out.target}` +
    (out.tagged_total > 0 ? `; ${out.tagged_total} page(s) tagged ${out.target}` : ""),
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
    // ADR 017: the pages carrying the target as a page-level tag, from the `page_tag` index. A
    // block target has none — tags are names, and a block has no name to be tagged with.
    let taggedRows: TaggedPageRow[] = [];

    if (asPage) {
      targetWire = wirePageName(asPage);
      // The page's own key plus its aliases (sql-schema.md rule 13): `[[Nick]]` is a link to
      // `Real` when `Real` lists `alias:: Nick`.
      const keys = pageLookupKeys(driver, asPage);
      const keyList = keys.map(() => "?").join(",");
      linkedRows = driver.all(
        `SELECT DISTINCT b.id AS block_id, b.page_id AS page_id, b.content AS content, b.updated_at AS updated_at
         FROM path_ref pr JOIN block b ON b.id = pr.block_id AND b.deleted_at IS NULL
         WHERE pr.page_key IN (${keyList}) AND b.page_id != ?
         ORDER BY b.updated_at DESC`,
        [...keys, asPage.id],
      );
      // One more than asked for, so the answer can say whether it stopped short (B-253: the
      // panel showed a silent 50 while Link all rewrote 187).
      if (input.include_unlinked) {
        unlinkedRows = unlinkedMentionRows(driver, asPage, input.unlinked_limit + 1);
      }
      taggedRows = pagesTaggedWith(driver, keys, asPage.id);
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
        // `Journal` usually has no page of its own, yet every journal day carries it: a tag that
        // only exists as an index key must still list its pages (B-111). Keyed the way `page_tag`
        // is (`refKeyOf`), which differs from `key` only for a date-shaped name.
        taggedRows = pagesTaggedWith(driver, [refKeyOf(input.target)], null);
        if (input.include_unlinked) {
          const plainName = input.target.split("/").pop() ?? input.target;
          if (plainName.length >= 3) {
            const ftsQuery = ftsPhrase(plainName);
            unlinkedRows = driver.all(
              `SELECT b.id AS block_id, b.page_id AS page_id, b.content AS content
               FROM block_fts JOIN block b ON b.rowid = block_fts.rowid
               WHERE block_fts MATCH ? AND b.deleted_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM path_ref pr WHERE pr.block_id = b.id AND pr.page_key = ?)
               LIMIT ?`,
              [ftsQuery, key, input.unlinked_limit + 1],
            );
          }
        }
      }
    }

    const end = offset + input.limit;
    const hasMore = linkedRows.length > end || taggedRows.length > end;
    const unlinkedTruncated = unlinkedRows.length > input.unlinked_limit;

    return {
      target: targetWire,
      linked: linkedRows.slice(offset, end).map((r) => ({
        id: r.block_id,
        page: pageWireNameById(driver, r.page_id),
        text: (r.content.split("\n")[0] ?? "").trim(),
        updated_at: new Date(r.updated_at).toISOString(),
      })),
      linked_total: linkedRows.length,
      unlinked: unlinkedRows.slice(0, input.unlinked_limit).map((r) => ({
        id: r.block_id,
        page: pageWireNameById(driver, r.page_id),
        text: (r.content.split("\n")[0] ?? "").trim(),
      })),
      unlinked_truncated: unlinkedTruncated,
      tagged_pages: taggedRows.slice(offset, end).map((r) => ({
        id: r.page_id,
        page: pageWireNameById(driver, r.page_id),
        source: r.source,
      })),
      tagged_total: taggedRows.length,
      cursor: hasMore ? Buffer.from(String(end)).toString("base64") : undefined,
    };
  },
});
